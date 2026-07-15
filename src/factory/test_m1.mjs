// M1 无头单测: 分层矿柱 / 采矿累积 / 硬度阻挡 / 满仓 / 放置拆除。
// 运行:  node src/factory/test_m1.mjs   (不导入 three.js/render)

import assert from 'node:assert';
import { createWorld } from './core/world.js';
import { createRegistry } from './core/registry.js';
import { createSpatial } from './core/spatial.js';
import { createEventBus } from './core/events.js';
import { invTotal } from './core/inventory.js';
import { oreColumn, layerAt } from './ore.js';
import { createMiningSystem } from './systems/mining.js';
import { placeBuilding, demolish } from './systems/placement.js';
import gameData from './data/gamedata.js';

let pass = 0;
const ok = (n) => { pass++; console.log('  ✓', n); };

// 地形桩(采矿只需这些: params.edits / roots / _buildNoise / _invalidateAffected / _editPending)
function stubPlanet() {
  return {
    params: { edits: [], radius: 100, maxHeight: 8, seaLevel: 0 },
    roots: [], _editPending: false,
    _buildNoise() { this._built = (this._built || 0) + 1; },
    _invalidateAffected() {},
    heightAt() { return 0; },
    position: { x: 0, y: 0, z: 0 },
  };
}
function makeCtx(planet) {
  const registry = createRegistry().load(gameData);
  return { planet, registry, spatial: createSpatial(), bus: createEventBus(), minerEdits: new Map() };
}
function norm(v) { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; }

// ---- oreColumn / layerAt ----
{
  const col = oreColumn([0, 1, 0], gameData.ore);
  assert.equal(col.length, 4);
  assert.equal(layerAt(col, 0.05).item, 'overburden');   // 表层
  assert.equal(layerAt(col, 2.5).item, 'stone');          // 超深 → 基岩
  assert.equal(layerAt(col, 0.05).hardness, 1);
  ok('oreColumn 分层 + layerAt 深度定位');
}

// ---- 找一个"有铁矿"的方向(noise ≥ threshold)----
let ironDir = null;
for (let i = 0; i < 400 && !ironDir; i++) {
  const d = norm([Math.sin(i * 1.1) + 0.3, Math.cos(i * 0.7), Math.sin(i * 0.37) - 0.2]);
  const col = oreColumn(d, gameData.ore);
  if (layerAt(col, 0.3).item === 'iron_ore') ironDir = d;
}
assert.ok(ironDir, '应能找到含铁方向');

// ---- 采矿: 先出废土 → 挖到铁矿; 硬度阻挡在铜层(hardness3 > mk1 的 2)----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  const e = placeBuilding(world, ctx, 'miner', ironDir);
  assert.ok(e && world.has(e, 'Miner') && world.has(e, 'Inventory'));
  assert.equal(planet.params.edits.length, 1);          // 建了地形坑 edit

  const sys = createMiningSystem({ commitEvery: 0.15 });
  world.addSystem('mining', sys);

  // 挖一小会儿(应在表土层) → 有 overburden
  for (let i = 0; i < 20; i++) world.tick(0.05, ctx);   // 1s, digRate0.05 → dug~0.05 < 0.12 表土
  const inv = world.get(e, 'Inventory');
  assert.ok((inv.items.overburden || 0) > 0, '先产出废土');
  assert.ok(!inv.items.iron_ore, '此时还没挖到铁');

  // 继续挖到铁层(dug 越过 0.12)
  for (let i = 0; i < 120; i++) world.tick(0.05, ctx);
  assert.ok((inv.items.iron_ore || 0) > 0, '挖到铁矿层出铁');

  // 一直挖 → 到铜层(0.5, hardness3)被卡住, state=blocked, dugDepth 停在 ~0.5
  for (let i = 0; i < 400; i++) world.tick(0.05, ctx);
  const m = world.get(e, 'Miner');
  // 若没满仓, 应被硬度卡在铜层
  if (invTotal(inv) < inv.cap) {
    assert.equal(m.state, 'blocked', '铜层太硬 mk1 挖不动');
    assert.ok(m.dugDepth >= 0.5 - 1e-3 && m.dugDepth < 0.55, 'dugDepth 卡在铜层上沿');
  }
  // 地形坑 edit 深度随挖掘增长
  assert.ok(ctx.minerEdits.get(e).depth > 0.1, '坑变深了');
  assert.ok(planet._built > 0, '地形提交被节流触发过');
  ok('采矿: 废土→铁矿→铜层硬度阻挡 + 坑加深');
}

// ---- 满仓停挖 ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  const e = placeBuilding(world, ctx, 'miner', ironDir);
  world.get(e, 'Inventory').cap = 20;   // 小仓, 很快满
  world.addSystem('mining', createMiningSystem());
  for (let i = 0; i < 200; i++) world.tick(0.05, ctx);
  const inv = world.get(e, 'Inventory');
  assert.ok(invTotal(inv) <= 20 + 1e-6, '不超过仓容');
  assert.equal(world.get(e, 'Miner').state, 'full');
  ok('满仓停挖(等运输)');
}

// ---- 拆除: 回收 edit + 实体消失 ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  const e = placeBuilding(world, ctx, 'miner', ironDir);
  assert.equal(planet.params.edits.length, 1);
  demolish(world, ctx, e);
  assert.equal(planet.params.edits.length, 0, 'edit 被回收');
  assert.ok(!world.alive(e), '实体已销毁');
  assert.equal(ctx.spatial.size, 0);
  ok('拆除回收 edit + 销毁实体');
}

console.log(`\nM1 全部通过 (${pass} 组断言)`);
