// M2a 无头单测: 球面移动数学 + 物流卡车(矿机→仓库搬运, 矿机腾空后恢复挖掘)。
// 运行:  node src/factory/test_m2.mjs   (不导入 three.js/render)

import assert from 'node:assert';
import { createWorld } from './core/world.js';
import { createRegistry } from './core/registry.js';
import { createSpatial } from './core/spatial.js';
import { createEventBus } from './core/events.js';
import { invTotal } from './core/inventory.js';
import { createMiningSystem } from './systems/mining.js';
import { createLogisticsSystem, spawnHaulers } from './systems/logistics.js';
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
    heightAt() { return 0; },
    position: { x: 0, y: 0, z: 0 },
  };
}
function makeCtx(planet) {
  const registry = createRegistry().load(gameData);
  return { planet, registry, spatial: createSpatial(), bus: createEventBus(), minerEdits: new Map() };
}

// ---- 球面数学 ----
{
  const n = S.norm([3, 0, 4]);
  assert.ok(Math.abs(Math.hypot(n[0], n[1], n[2]) - 1) < 1e-9, 'norm 归一');
  assert.ok(Math.abs(S.angle([1, 0, 0], [0, 1, 0]) - Math.PI / 2) < 1e-9, 'angle 90°');

  // moveToward: 从 x 轴朝 y 轴走小步 → 角度减小, 未到达
  let d = [1, 0, 0];
  const target = [0, 1, 0];
  let arrived = false, steps = 0;
  while (!arrived && steps < 1000) { const r = S.moveToward(d, target, 0.02); d = r.dir; arrived = r.arrived; steps++; }
  assert.ok(arrived, 'moveToward 最终到达');
  assert.ok(S.angle(d, target) < 0.05, '到达时朝向 target');
  assert.ok(steps > 50 && steps < 200, `步数合理(${steps})`);

  // tangentToward 与 dir 垂直
  const t = S.tangentToward([0, 1, 0], [1, 1, 0]);
  assert.ok(Math.abs(S.dot(t, [0, 1, 0])) < 1e-9, 'tangent ⟂ dir');

  // randInCap 落在角半径内
  const c = S.norm([0.2, 1, 0.1]);
  for (let i = 0; i < 50; i++) assert.ok(S.angle(S.randInCap(c, 0.1), c) <= 0.1 + 1e-6, 'randInCap 在帽内');
  ok('球面数学: norm/angle/moveToward/tangentToward/randInCap');
}

// ---- 物流: 卡车把矿机的矿运到仓库 ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();

  const minerDir = S.norm([0.2, 1, 0.1]);
  const whDir = S.norm([0.55, 1, 0.1]);   // 与矿机相隔 ~0.2 rad, 卡车走得到

  const miner = placeBuilding(world, ctx, 'miner', minerDir);
  const wh = placeBuilding(world, ctx, 'warehouse', whDir);
  assert.ok(world.has(wh, 'Storage') && world.has(wh, 'Inventory'), '仓库有 Storage+Inventory');

  world.get(miner, 'Inventory').cap = 30;   // 小仓 → 先让它挖满 → 再上卡车验证腾空恢复

  const whInv = world.get(wh, 'Inventory');
  const minerInv = world.get(miner, 'Inventory');
  const mComp = world.get(miner, 'Miner');

  // 阶段 1: 只挖不运 → 矿机应挖到满仓(state=full)
  world.addSystem('mining', createMiningSystem());
  let sawFull = false;
  for (let i = 0; i < 600 && !sawFull; i++) { world.tick(0.05, ctx); if (mComp.state === 'full') sawFull = true; }
  assert.ok(sawFull, '阶段1: 矿机挖到满仓');
  assert.ok(invTotal(minerInv) >= 30 - 1e-6, '满仓量达到 cap');

  // 阶段 2: 上物流 + 卡车 → 搬到仓库, 矿机腾空后恢复挖掘
  world.addSystem('logistics', createLogisticsSystem());
  const haulers = spawnHaulers(world, ctx, 1, 'hauler_mk1', minerDir);
  assert.equal(haulers.length, 1);
  const truck = haulers[0];
  assert.ok(world.has(truck, 'Hauler') && world.has(truck, 'Mover') && world.has(truck, 'Agent'), '卡车有 Hauler+Mover+Agent');

  let sawResume = false, sawLoad = false, sawUnload = false, maxCargo = 0;
  for (let i = 0; i < 2000; i++) {
    world.tick(0.05, ctx);
    const h = world.get(truck, 'Hauler');
    if (h.state === 'load') sawLoad = true;
    if (h.state === 'unload') sawUnload = true;
    maxCargo = Math.max(maxCargo, h.cargoAmt);
    if (mComp.state === 'mining') sawResume = true;   // 满仓被搬空后恢复挖掘
  }

  assert.ok(sawLoad, '卡车执行过装载');
  assert.ok(sawUnload, '卡车执行过卸货');
  assert.ok(maxCargo > 0, '卡车运过货');
  assert.ok(invTotal(whInv) > 0, `仓库收到货物(${invTotal(whInv).toFixed(1)})`);
  assert.ok(sawResume, '矿机被腾空后恢复挖掘');
  ok('物流: 矿机挖满→卡车搬到仓库→矿机腾空恢复挖掘');
}

// ---- 就近派活: 两个仓库时卡车选更近的 ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  const minerDir = S.norm([0, 1, 0]);
  placeBuilding(world, ctx, 'miner', minerDir);
  const near = placeBuilding(world, ctx, 'warehouse', S.norm([0.2, 1, 0]));
  const far = placeBuilding(world, ctx, 'warehouse', S.norm([0, 1, 0.9]));
  world.get(world.query('Miner', 'Inventory').next().value, 'Inventory').cap = 30;
  world.addSystem('mining', createMiningSystem());
  world.addSystem('logistics', createLogisticsSystem());
  const [truck] = spawnHaulers(world, ctx, 1, 'hauler_mk1', minerDir);
  for (let i = 0; i < 3000; i++) world.tick(0.05, ctx);
  assert.ok(invTotal(world.get(near, 'Inventory')) >= invTotal(world.get(far, 'Inventory')), '更近的仓库收到不少于远仓');
  assert.ok(invTotal(world.get(near, 'Inventory')) > 0, '近仓有货');
  ok('就近派活: 优先送近仓');
}

console.log(`\nM2a 全部通过 (${pass} 组断言)`);
