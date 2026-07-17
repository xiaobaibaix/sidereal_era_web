// M4 无头单测: 矿场(depot) + 挖掘区 + 挖机 + 采矿卡车。
//   - 只放矿场(无挖掘区/无小队)→ 矿场保持空(不工作)。
//   - 圈定挖掘区 + 生成挖机 + 采矿卡车 → 挖机产矿、卡车把矿运进矿场 → 矿场进货。
//   - 下游物流卡车从矿场取货喂冶炼炉。
// 运行:  node src/factory/test_m4.mjs

import assert from 'node:assert';
import { createWorld } from './core/world.js';
import { createRegistry } from './core/registry.js';
import { createSpatial } from './core/spatial.js';
import { createEventBus } from './core/events.js';
import { invTotal } from './core/inventory.js';
import { createMiningCrewSystem, setDigZone, spawnExcavators, spawnMineTrucks } from './systems/mining_crew.js';
import { createLogisticsSystem, spawnHaulers } from './systems/logistics.js';
import { createProductionSystem } from './systems/production.js';
import { placeBuilding } from './systems/placement.js';
import * as S from './core/sphere.js';
import gameData from './data/gamedata.js';

let pass = 0;
const ok = (n) => { pass++; console.log('  ✓', n); };

function stubPlanet() {
  return {
    params: { edits: [], radius: 100, maxHeight: 8, seaLevel: 0 },
    roots: [], _editPending: false,
    _buildNoise() {}, _invalidateAffected() {},
    // 平整策略需要 baseH 有变化(否则 planeH == max → 全部 targetOffset=0, 挖机没活干)
    baseHeightAt(x, y, z) { return 1.0 + 0.3 * Math.sin(x * 50) + 0.3 * Math.cos(z * 70); },
    heightAt(x, y, z) { return this.baseHeightAt(x, y, z); },
    position: { x: 0, y: 0, z: 0 },
  };
}
function makeCtx(planet) {
  const registry = createRegistry().load(gameData).unlockAll();   // 测试: 解锁全部建筑
  return { planet, registry, spatial: createSpatial(), bus: createEventBus(), minerEdits: new Map(), zoneEdits: new Map() };
}

// ---- 只放矿场, 不圈区/不生成小队 → 矿场保持空 ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  const depot = placeBuilding(world, ctx, 'depot', S.norm([0, 1, 0]));
  assert.ok(world.has(depot, 'Depot') && world.has(depot, 'Provider') && world.has(depot, 'DigZone'), '矿场有 Depot/Provider/DigZone');
  assert.equal(world.get(depot, 'DigZone').center, null, '初始无挖掘区');
  world.addSystem('crew', createMiningCrewSystem());
  for (let i = 0; i < 200; i++) world.tick(0.05, ctx);
  assert.equal(invTotal(world.get(depot, 'Inventory')), 0, '无挖掘区/小队 → 矿场空(不工作)');
  ok('只放矿场不工作(需圈区+小队)');
}

// ---- 圈定挖掘区 + 挖机 + 采矿卡车 → 矿场进货 ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  const depotDir = S.norm([0, 1, 0]);
  const depot = placeBuilding(world, ctx, 'depot', depotDir);
  world.addSystem('crew', createMiningCrewSystem());

  const zoneDir = S.norm([0.1, 1, 0.05]);
  assert.ok(setDigZone(world, ctx, depot, zoneDir), '圈定挖掘区成功');
  const dz = world.get(depot, 'DigZone');
  assert.deepEqual(dz.zones[0].center, [...zoneDir], '挖掘区中心已设');
  assert.equal(planet.params.edits.length, 1, '建了挖掘区地形坑 edit');

  const exs = spawnExcavators(world, ctx, 2, depot);
  const trucks = spawnMineTrucks(world, ctx, 2, depot);
  assert.equal(exs.length, 2); assert.equal(trucks.length, 2);
  assert.ok(world.has(exs[0], 'Excavator') && world.has(exs[0], 'Inventory') && world.has(exs[0], 'Mover'), '挖机组件齐');
  assert.ok(world.has(trucks[0], 'MineTruck') && world.has(trucks[0], 'Mover'), '采矿卡车组件齐');

  const depotInv = world.get(depot, 'Inventory');
  let sawExcaOre = false, sawDig = false;
  for (let i = 0; i < 2000; i++) {
    world.tick(0.05, ctx);
    for (const e of exs) if (invTotal(world.get(e, 'Inventory')) > 0) sawExcaOre = true;
    if (dz.zones[0].depth > 0.05) sawDig = true;
    if (invTotal(depotInv) > 50) break;
  }
  assert.ok(sawDig, '挖掘区被挖深');
  assert.ok(sawExcaOre, '挖机缓冲产出过矿');
  assert.ok(invTotal(depotInv) > 0, `矿场收到矿(${invTotal(depotInv).toFixed(0)})`);
  assert.ok((depotInv.items.iron_ore || 0) > 0, '矿场里有铁矿');
  ok('圈区+挖机+采矿车 → 矿场进货');
}

// ---- 下游: 物流卡车从矿场取矿喂冶炼炉 ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  const depotDir = S.norm([0, 1, 0]);
  const depot = placeBuilding(world, ctx, 'depot', depotDir);
  const smelter = placeBuilding(world, ctx, 'smelter', S.norm([0.25, 1, 0]));
  world.addSystem('crew', createMiningCrewSystem());
  world.addSystem('prod', createProductionSystem());
  world.addSystem('logistics', createLogisticsSystem());

  setDigZone(world, ctx, depot, S.norm([0.05, 1, 0.05]));
  spawnExcavators(world, ctx, 2, depot);
  spawnMineTrucks(world, ctx, 2, depot);
  spawnHaulers(world, ctx, 3, 'hauler_mk1', depotDir);

  const smInv = world.get(smelter, 'Inventory');
  let fedSmelter = false, madeIngot = false;
  for (let i = 0; i < 4000; i++) {
    world.tick(0.05, ctx);
    if ((smInv.items.iron_ore || 0) > 0) fedSmelter = true;
    if ((smInv.items.iron_ingot || 0) > 0) madeIngot = true;
    if (madeIngot) break;
  }
  assert.ok(fedSmelter, '物流卡车把矿从矿场送到了冶炼炉');
  assert.ok(madeIngot, '冶炼炉产出铁锭(全链跑通)');
  ok('下游: 矿场→冶炼炉(物流)→铁锭');
}

console.log(`\nM4 全部通过 (${pass} 组断言)`);
