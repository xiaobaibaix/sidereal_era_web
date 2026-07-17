// B2 无头单测: 运输站(装货站/卸货站) + 卡车站点化。
// 核心验收:
//   1) 矿场→带→装货站→卡车→卸货站→带→分拣器→冶炼炉 全链跑通;
//   2) 世界无站点时, 卡车自动回退到旧的"任意 Provider→Requester"直连(不破坏 M2-M8)。
// 运行:  node src/factory/test_stations.mjs   (零 three.js)

import assert from 'node:assert';
import { createWorld } from './core/world.js';
import { createRegistry } from './core/registry.js';
import { createSpatial } from './core/spatial.js';
import { createEventBus } from './core/events.js';
import { invTotal } from './core/inventory.js';
import { createBeltSystem } from './systems/belt.js';
import { createInserterSystem } from './systems/inserter.js';
import { createProductionSystem } from './systems/production.js';
import { createLogisticsSystem, spawnHaulers } from './systems/logistics.js';
import { placeBuilding, placeBelt, placeInserter } from './systems/placement.js';
import { toJSON, fromJSON } from './core/save.js';
import gameData from './data/gamedata.js';

let pass = 0;
const ok = (n) => { pass++; console.log('  ✓', n); };

function stubPlanet() {
  return {
    params: { edits: [], radius: 100, maxHeight: 8, seaLevel: 0 },
    roots: [], _editPending: false,
    _buildNoise() {}, _invalidateAffected() {}, heightAt() { return 0; },
    position: { x: 0, y: 0, z: 0 },
  };
}
function makeCtx() {
  const registry = createRegistry().load(gameData);
  registry.unlockAll();   // 解锁全部建筑(含带/分拣器/站)
  return { registry, spatial: createSpatial(), bus: createEventBus(), minerEdits: new Map(), planet: stubPlanet() };
}
const dirAt = (ang) => [Math.cos(ang), Math.sin(ang), 0];

// ============ 全链: 矿场→带→装货站→卡车→卸货站→带→分拣器→冶炼炉 ============
{
  const ctx = makeCtx();
  const world = createWorld();

  // 上游区: 矿场(预置铁矿) — 带 — 装货站
  const depot = placeBuilding(world, ctx, 'depot', dirAt(0));
  world.get(depot, 'Inventory').items.iron_ore = 500;
  const loadSt = placeBuilding(world, ctx, 'load_station', dirAt(0.30));
  assert.ok(world.has(loadSt, 'LoadStation') && world.has(loadSt, 'Provider'), '装货站有 LoadStation+Provider');

  const beltUp = placeBelt(world, ctx, dirAt(0.05), dirAt(0.25));
  placeInserter(world, ctx, { kind: 'inv', eid: depot, role: 'provide' }, { kind: 'belt', eid: beltUp, role: 'in' });
  placeInserter(world, ctx, { kind: 'belt', eid: beltUp, role: 'out' }, { kind: 'inv', eid: loadSt, role: 'any' });

  // 下游区(远处): 卸货站 — 带 — 分拣器 — 冶炼炉
  const unloadSt = placeBuilding(world, ctx, 'unload_station', dirAt(1.2));
  assert.ok(world.has(unloadSt, 'UnloadStation') && world.has(unloadSt, 'Requester'), '卸货站有 UnloadStation+Requester');
  const smelter = placeBuilding(world, ctx, 'smelter', dirAt(1.5));
  const beltDn = placeBelt(world, ctx, dirAt(1.28), dirAt(1.45));
  placeInserter(world, ctx, { kind: 'inv', eid: unloadSt, role: 'provide' }, { kind: 'belt', eid: beltDn, role: 'in' });
  placeInserter(world, ctx, { kind: 'belt', eid: beltDn, role: 'out' }, { kind: 'inv', eid: smelter, role: 'request' });

  // 站间卡车
  const [truck] = spawnHaulers(world, ctx, 1, 'hauler_mk1', dirAt(0.30));

  // tick 顺序(设计 D.5): 上带分拣器 → 带 → 下带分拣器 → 卡车(站间) → 生产
  world.addSystem('ins_load', createInserterSystem({ phase: 'load' }));
  world.addSystem('belt', createBeltSystem());
  world.addSystem('ins_unload', createInserterSystem({ phase: 'unload' }));
  world.addSystem('logistics', createLogisticsSystem());
  world.addSystem('prod', createProductionSystem());

  let sawLoadStGoods = false, sawTruckCargo = false, sawUnloadStGoods = false;
  for (let i = 0; i < 8000; i++) {
    world.tick(0.05, ctx);
    if ((world.get(loadSt, 'Inventory').items.iron_ore || 0) > 0) sawLoadStGoods = true;
    if (world.get(truck, 'Hauler').cargoAmt > 0) sawTruckCargo = true;
    if ((world.get(unloadSt, 'Inventory').items.iron_ore || 0) > 0) sawUnloadStGoods = true;
  }
  assert.ok(sawLoadStGoods, '装货站被上游带填充过');
  assert.ok(sawTruckCargo, '卡车在站间运过货');
  assert.ok(sawUnloadStGoods, '卸货站收到过卡车运来的货');
  const ingot = world.get(smelter, 'Inventory').items.iron_ingot || 0;
  assert.ok(ingot > 0, `末端冶炼炉产出铁锭(${ingot.toFixed(1)})`);
  ok(`全链: 矿场→带→装货站→卡车→卸货站→带→分拣器→冶炼炉 (铁锭=${ingot.toFixed(1)})`);
}

// ============ 站点模式: 卡车只在站间跑, 不直连普通建筑 ============
{
  const ctx = makeCtx();
  const world = createWorld();
  // 一个普通仓库(Provider) + 一个装货站(有货) + 一个卸货站; 卡车应只服务站点
  const depot = placeBuilding(world, ctx, 'depot', dirAt(0));
  world.get(depot, 'Inventory').items.iron_ore = 200;          // 普通 Provider, 站点模式下卡车不应直接来搬
  const loadSt = placeBuilding(world, ctx, 'load_station', dirAt(0.3));
  world.get(loadSt, 'Inventory').items.copper_ore = 100;       // 装货站有货
  const unloadSt = placeBuilding(world, ctx, 'unload_station', dirAt(1.0));
  const [truck] = spawnHaulers(world, ctx, 1, 'hauler_mk1', dirAt(0.3));
  world.addSystem('logistics', createLogisticsSystem());
  for (let i = 0; i < 4000; i++) world.tick(0.05, ctx);
  assert.equal(world.get(depot, 'Inventory').items.iron_ore || 0, 200, '普通仓库未被卡车搬动(站点模式只服务站点)');
  assert.ok((world.get(unloadSt, 'Inventory').items.copper_ore || 0) > 0, '卸货站收到装货站的货');
  assert.ok((world.get(loadSt, 'Inventory').items.copper_ore || 0) < 100, '装货站的货被搬走');
  ok('站点模式: 卡车只在站间跑(不直连普通建筑)');
}

// ============ 无站点回退: 删掉/不放站点 → 卡车按旧 Provider→Requester 直连 ============
{
  const ctx = makeCtx();
  const world = createWorld();
  const depot = placeBuilding(world, ctx, 'depot', dirAt(0));
  world.get(depot, 'Inventory').items.iron_ore = 200;
  const smelter = placeBuilding(world, ctx, 'smelter', dirAt(0.3));   // Requester(iron_ore)
  const [truck] = spawnHaulers(world, ctx, 1, 'hauler_mk1', dirAt(0));
  assert.equal(world.count('LoadStation'), 0, '世界中无装货站');
  world.addSystem('logistics', createLogisticsSystem());
  world.addSystem('prod', createProductionSystem());
  let sawLoad = false, sawUnload = false;
  for (let i = 0; i < 4000; i++) {
    world.tick(0.05, ctx);
    const h = world.get(truck, 'Hauler');
    if (h.state === 'load') sawLoad = true;
    if (h.state === 'unload') sawUnload = true;
  }
  assert.ok(sawLoad && sawUnload, '无站点 → 卡车回退旧直连(装/卸都发生)');
  assert.ok((world.get(smelter, 'Inventory').items.iron_ore || 0) > 0 || (world.get(smelter, 'Inventory').items.iron_ingot || 0) > 0, '冶炼炉经旧直连收到料/出锭');
  assert.ok(invTotal(world.get(depot, 'Inventory')) < 200, '矿场货被旧直连卡车搬走');
  ok('无站点回退: 卡车按旧 Provider→Requester 直连(向后兼容)');
}

// ============ 端到端存档: 全物流链 tick→存档→载入新世界→重挂系统→继续跑 ============
{
  const ctx = makeCtx();
  const world = createWorld();
  // 搭一条完整链(与首例同构, 但紧凑)
  const depot = placeBuilding(world, ctx, 'depot', dirAt(0));
  world.get(depot, 'Inventory').items.iron_ore = 500;
  const loadSt = placeBuilding(world, ctx, 'load_station', dirAt(0.28));
  const beltUp = placeBelt(world, ctx, dirAt(0.05), dirAt(0.24));
  placeInserter(world, ctx, { kind: 'inv', eid: depot, role: 'provide' }, { kind: 'belt', eid: beltUp, role: 'in' });
  placeInserter(world, ctx, { kind: 'belt', eid: beltUp, role: 'out' }, { kind: 'inv', eid: loadSt, role: 'any' });
  const unloadSt = placeBuilding(world, ctx, 'unload_station', dirAt(1.2));
  const smelter = placeBuilding(world, ctx, 'smelter', dirAt(1.5));
  const beltDn = placeBelt(world, ctx, dirAt(1.28), dirAt(1.45));
  placeInserter(world, ctx, { kind: 'inv', eid: unloadSt, role: 'provide' }, { kind: 'belt', eid: beltDn, role: 'in' });
  placeInserter(world, ctx, { kind: 'belt', eid: beltDn, role: 'out' }, { kind: 'inv', eid: smelter, role: 'request' });
  spawnHaulers(world, ctx, 1, 'hauler_mk1', dirAt(0.28));

  const addSystems = (w) => {
    w.addSystem('ins_load', createInserterSystem({ phase: 'load' }));
    w.addSystem('belt', createBeltSystem());
    w.addSystem('ins_unload', createInserterSystem({ phase: 'unload' }));
    w.addSystem('logistics', createLogisticsSystem());
    w.addSystem('prod', createProductionSystem());
  };
  addSystems(world);
  for (let i = 0; i < 2000; i++) world.tick(0.05, ctx);

  // 存档 → 载入新世界
  const json = toJSON(world);
  const w2 = createWorld();
  fromJSON(json, w2);
  // 组件完整保留
  assert.equal(w2.count('Belt'), world.count('Belt'), '带数量保留');
  assert.equal(w2.count('Inserter'), world.count('Inserter'), '分拣器数量保留');
  assert.ok(w2.has(loadSt, 'LoadStation') && w2.has(unloadSt, 'UnloadStation'), '装/卸货站标记保留');
  const beltUp2 = w2.get(beltUp, 'Belt');
  assert.ok(Array.isArray(beltUp2.items), '带上物品序列保留(数组)');
  const ingotBefore = w2.get(smelter, 'Inventory').items.iron_ingot || 0;

  // 新世界重挂系统, 继续跑 → 仍能继续产出(存档不中断物流)
  const ctx2 = makeCtx();
  addSystems(w2);
  for (let i = 0; i < 2000; i++) w2.tick(0.05, ctx2);
  const ingotAfter = w2.get(smelter, 'Inventory').items.iron_ingot || 0;
  assert.ok(ingotAfter > ingotBefore, `载入后继续产出铁锭(${ingotBefore.toFixed(0)}→${ingotAfter.toFixed(0)})`);
  ok(`端到端存档: 全链 tick→存档→载入→继续跑仍产出(铁锭 ${ingotBefore.toFixed(0)}→${ingotAfter.toFixed(0)})`);
}

console.log(`\nB2 运输站 全部通过 (${pass} 组断言)`);
