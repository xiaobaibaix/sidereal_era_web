// 网格分拣器无头单测: 分拣器装在平台建筑边缘, 抓取格动态解析(带/建筑), 进料/出料, reach。
// 运行:  node src/factory/test_inserter_grid.mjs   (零 three.js; stub planet)

import assert from 'node:assert';
import { createWorld } from './core/world.js';
import { createRegistry } from './core/registry.js';
import { createSpatial } from './core/spatial.js';
import { createEventBus } from './core/events.js';
import { invTotal } from './core/inventory.js';
import { createBeltSystem, beltAddItem } from './systems/belt.js';
import { createInserterSystem } from './systems/inserter.js';
import { placeBuildPad, placeBuildingSnapped, placeBelt, placeInserterMounted } from './systems/placement.js';
import { cellToDir } from './core/grid.js';
import gameData from './data/gamedata.js';

let pass = 0;
const ok = (n) => { pass++; console.log('  ✓', n); };

function stubPlanet() {
  return {
    params: { edits: [], radius: 200, maxHeight: 8, seaLevel: 0 }, roots: [], _editPending: false,
    _buildNoise() {}, _invalidateAffected() {}, baseHeightAt() { return 0; }, heightAt() { return 0; }, position: { x: 0, y: 0, z: 0 },
  };
}
function makeCtx() {
  const registry = createRegistry().load(gameData); registry.unlockAll();
  return { registry, spatial: createSpatial(), bus: createEventBus(), planet: stubPlanet() };
}
// 抓取格坐标(与 placeInserterMounted 内部一致)
function grabCell(slot, di, dj, reach) {
  const { i, j, w, h } = slot; const midI = i + Math.floor(w / 2), midJ = j + Math.floor(h / 2);
  if (di > 0) return { gi: i + w - 1 + reach, gj: midJ };
  if (di < 0) return { gi: i - reach, gj: midJ };
  if (dj > 0) return { gi: midI, gj: j + h - 1 + reach };
  return { gi: midI, gj: j - reach };
}

// ============ 进料: 抓取格上的带 → 建筑 ============
{
  const ctx = makeCtx(); const world = createWorld(); const R = 200;
  const padE = placeBuildPad(world, ctx, [0, 1, 0], { cell: 3, radius: 0.2 });
  const pad = world.get(padE, 'BuildPad');
  const r = placeBuildingSnapped(world, ctx, 'smelter', [0, 1, 0]);   // 2x2
  const slot = world.get(r.eid, 'GridSlot');
  const { gi, gj } = grabCell(slot, 1, 0, 1);                          // +i 边, reach 1
  // 在抓取格所在列放一条纵向带, 穿过 (gi,gj)
  const belt = placeBelt(world, ctx, cellToDir(pad, gi, gj - 1, R), cellToDir(pad, gi, gj + 1, R));
  const bComp = world.get(belt, 'Belt');
  assert.ok(bComp.pad === padE && bComp.cells[gi + ',' + gj] != null, '带注册到平台且经过抓取格');
  const ins = placeInserterMounted(world, ctx, r.eid, { di: 1, dj: 0 }, 1, 'in', false);
  assert.ok(ins != null && world.get(ins, 'Inserter').mount === r.eid, '分拣器装在冶炼炉边');
  assert.equal(world.get(ins, 'Inserter').gi, gi, '抓取格 gi 正确');

  world.addSystem('belt', createBeltSystem());
  world.addSystem('ins', createInserterSystem());
  let fed = false;
  for (let i = 0; i < 800; i++) { beltAddItem(bComp, 'iron_ore'); world.tick(0.05, ctx); if ((world.get(r.eid, 'Inventory').items.iron_ore || 0) > 0) { fed = true; } }
  assert.ok(fed, '带上物品被分拣器抓进冶炼炉');
  assert.ok((world.get(r.eid, 'Inventory').items.iron_ore || 0) > 0, `冶炼炉收到铁矿(${(world.get(r.eid, 'Inventory').items.iron_ore || 0).toFixed(0)})`);
  ok('进料: 抓取格的带 → 建筑');
}

// ============ 出料: 建筑 → 抓取格上的带(带尾接收) ============
{
  const ctx = makeCtx(); const world = createWorld(); const R = 200;
  const padE = placeBuildPad(world, ctx, [0, 1, 0], { cell: 3, radius: 0.2 });
  const pad = world.get(padE, 'BuildPad');
  const r = placeBuildingSnapped(world, ctx, 'depot', [0, 1, 0]);     // 3x3, Provider('*')
  world.get(r.eid, 'Inventory').items.iron_ore = 200;                 // 预置货
  const slot = world.get(r.eid, 'GridSlot');
  const { gi, gj } = grabCell(slot, 1, 0, 1);
  const belt = placeBelt(world, ctx, cellToDir(pad, gi, gj - 1, R), cellToDir(pad, gi, gj + 1, R));
  const bComp = world.get(belt, 'Belt');
  // 带头接一个收集库存, 便于统计搬出量
  const sink = world.create(); world.add(sink, 'Inventory', { items: {}, cap: 100000 });
  bComp.outPort = { kind: 'inv', eid: sink, role: 'any' };
  const ins = placeInserterMounted(world, ctx, r.eid, { di: 1, dj: 0 }, 1, 'out', false);
  assert.equal(world.get(ins, 'Inserter').mode, 'out', '出料模式');

  world.addSystem('belt', createBeltSystem());
  world.addSystem('ins', createInserterSystem());
  for (let i = 0; i < 800; i++) world.tick(0.05, ctx);
  assert.ok(invTotal(world.get(sink, 'Inventory')) > 0, `矿场的货经分拣器上带并流到带头(${invTotal(world.get(sink, 'Inventory')).toFixed(0)})`);
  assert.ok((world.get(r.eid, 'Inventory').items.iron_ore || 0) < 200, '矿场库存下降(被搬出)');
  ok('出料: 建筑 → 抓取格的带');
}

// ============ reach: 抓取格随 reach 外移; 带不在抓取格则不搬 ============
{
  const ctx = makeCtx(); const world = createWorld(); const R = 200;
  const padE = placeBuildPad(world, ctx, [0, 1, 0], { cell: 3, radius: 0.25 });
  const pad = world.get(padE, 'BuildPad');
  const r = placeBuildingSnapped(world, ctx, 'smelter', [0, 1, 0]);
  const slot = world.get(r.eid, 'GridSlot');
  const g1 = grabCell(slot, 1, 0, 1), g2 = grabCell(slot, 1, 0, 2);
  assert.ok(g2.gi === g1.gi + 1 && g2.gj === g1.gj, 'reach2 抓取格比 reach1 外移一格');
  // 带只铺在 reach2 的格上; reach1 的分拣器够不到 → 不搬
  const belt = placeBelt(world, ctx, cellToDir(pad, g2.gi, g2.gj - 1, R), cellToDir(pad, g2.gi, g2.gj + 1, R));
  const bComp = world.get(belt, 'Belt');
  const insShort = placeInserterMounted(world, ctx, r.eid, { di: 1, dj: 0 }, 1, 'in', false);   // reach1, 够不到
  world.addSystem('belt', createBeltSystem());
  world.addSystem('ins', createInserterSystem());
  for (let i = 0; i < 300; i++) { beltAddItem(bComp, 'iron_ore'); world.tick(0.05, ctx); }
  assert.equal(world.get(r.eid, 'Inventory').items.iron_ore || 0, 0, 'reach1 够不到 reach2 的带 → 不搬');
  ok('reach: 抓取格随 reach 外移, 够不到则不搬');
}

console.log(`\n网格分拣器 全部通过 (${pass} 组断言)`);
