// B1 无头单测: 分拣器(带↔机器/仓库搬运, 过滤, 速率, 背压)。
// 核心验收: 矿场→带→分拣器→冶炼炉 全链只用带+分拣器跑通(不用卡车)。
// 运行:  node src/factory/test_inserter.mjs   (零 three.js)

import assert from 'node:assert';
import { createWorld } from './core/world.js';
import { createRegistry } from './core/registry.js';
import { createSpatial } from './core/spatial.js';
import { createEventBus } from './core/events.js';
import { invTotal } from './core/inventory.js';
import { createBeltSystem } from './systems/belt.js';
import { createInserterSystem } from './systems/inserter.js';
import { createProductionSystem } from './systems/production.js';
import { placeBuilding, placeBelt, placeInserter } from './systems/placement.js';

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
  const registry = createRegistry();
  // 直接用 gameData
  return { registry, spatial: createSpatial(), bus: createEventBus(), minerEdits: new Map(), planet: stubPlanet() };
}
const dirAt = (ang) => [Math.cos(ang), Math.sin(ang), 0];

// 载入 gameData(异步 import 避免顶层 await 顺序问题)
import gameData from './data/gamedata.js';

// ============ 全链: 矿场 → 带 → 分拣器 → 冶炼炉(只用带+分拣器) ============
{
  const ctx = makeCtx(); ctx.registry.load(gameData); ctx.registry.unlock(['belt', 'inserter']);
  const world = createWorld();

  const depot = placeBuilding(world, ctx, 'depot', dirAt(0));
  world.get(depot, 'Inventory').items.iron_ore = 200;               // 矿场里预置铁矿
  const smelter = placeBuilding(world, ctx, 'smelter', dirAt(0.25));
  assert.ok(world.has(smelter, 'Requester'), '冶炼炉是 iron_ore 需求方');

  const belt = placeBelt(world, ctx, dirAt(0.05), dirAt(0.20));
  // 上带分拣器: 矿场(Provider) → 带尾
  const insLoad = placeInserter(world, ctx,
    { kind: 'inv', eid: depot, role: 'provide' },
    { kind: 'belt', eid: belt, role: 'in' });
  // 下带分拣器: 带头 → 冶炼炉(Requester)
  const insUnload = placeInserter(world, ctx,
    { kind: 'belt', eid: belt, role: 'out' },
    { kind: 'inv', eid: smelter, role: 'request' });
  assert.ok(insLoad && insUnload && world.has(insLoad, 'Inserter') && world.has(insUnload, 'Inserter'), '两个分拣器放置成功');

  // tick 顺序(设计 D.5): 上带分拣器 → 带 → 下带分拣器 → 生产。全程无 logistics/卡车。
  world.addSystem('ins_load', createInserterSystem({ phase: 'load' }));
  world.addSystem('belt', createBeltSystem());
  world.addSystem('ins_unload', createInserterSystem({ phase: 'unload' }));
  world.addSystem('prod', createProductionSystem());

  const beltComp = world.get(belt, 'Belt');
  let sawBeltItems = false, sawSmelterInput = false;
  const depot0 = invTotal(world.get(depot, 'Inventory'));
  for (let i = 0; i < 3000; i++) {
    world.tick(0.05, ctx);
    if (beltComp.items.length > 0) sawBeltItems = true;
    if ((world.get(smelter, 'Inventory').items.iron_ore || 0) > 0) sawSmelterInput = true;
  }
  assert.ok(sawBeltItems, '带上出现过物品(分拣器把矿放上了带)');
  assert.ok(sawSmelterInput, '冶炼炉收到过铁矿(下带分拣器送达)');
  const ingot = world.get(smelter, 'Inventory').items.iron_ingot || 0;
  assert.ok(ingot > 0, `冶炼炉产出了铁锭(${ingot.toFixed(1)})`);
  assert.ok(invTotal(world.get(depot, 'Inventory')) < depot0, '矿场库存下降(货被搬走)');
  assert.equal(world.count('Hauler'), 0, '全程没有用到卡车');
  ok(`全链: 矿场→带→分拣器→冶炼炉 只用带+分拣器 (铁锭=${ingot.toFixed(1)})`);
}

// ============ sorter 过滤: 只搬指定物品 ============
{
  const ctx = makeCtx(); ctx.registry.load(gameData); ctx.registry.unlock(['sorter']);
  const world = createWorld();
  const src = world.create();
  world.add(src, 'Inventory', { items: { iron_ore: 50, copper_ore: 50 }, cap: 200 });
  world.add(src, 'Provider', { items: '*' });
  world.add(src, 'Anchor', { dir: dirAt(0), yaw: 0 });
  const sink = world.create();
  world.add(sink, 'Inventory', { items: {}, cap: 200 });
  world.add(sink, 'Anchor', { dir: dirAt(0.1), yaw: 0 });

  // 过滤分拣器: 只搬 copper_ore
  placeInserter(world, ctx,
    { kind: 'inv', eid: src, role: 'provide' },
    { kind: 'inv', eid: sink, role: 'any' },
    { buildingId: 'sorter', filter: ['copper_ore'] });
  world.addSystem('ins', createInserterSystem());
  for (let i = 0; i < 400; i++) world.tick(0.05, ctx);

  assert.equal(world.get(sink, 'Inventory').items.iron_ore || 0, 0, 'sink 没有 iron_ore(被过滤)');
  assert.ok((world.get(sink, 'Inventory').items.copper_ore || 0) > 0, 'sink 收到 copper_ore');
  assert.equal(world.get(src, 'Inventory').items.iron_ore || 0, 50, 'src 的 iron_ore 原封不动');
  ok('sorter 过滤: 只搬指定物品, 其余不动');
}

// ============ 速率: rate=4 → 1 秒约搬 4 个 ============
{
  const ctx = makeCtx(); ctx.registry.load(gameData); ctx.registry.unlock(['inserter']);
  const world = createWorld();
  const src = world.create();
  world.add(src, 'Inventory', { items: { stone: 100 }, cap: 200 });
  world.add(src, 'Provider', { items: '*' });
  world.add(src, 'Anchor', { dir: dirAt(0), yaw: 0 });
  const sink = world.create();
  world.add(sink, 'Inventory', { items: {}, cap: 200 });
  world.add(sink, 'Anchor', { dir: dirAt(0.1), yaw: 0 });
  placeInserter(world, ctx,
    { kind: 'inv', eid: src, role: 'provide' },
    { kind: 'inv', eid: sink, role: 'any' },
    { rate: 4 });
  world.addSystem('ins', createInserterSystem());
  for (let i = 0; i < 20; i++) world.tick(0.05, ctx);   // 1.0 秒
  const moved = invTotal(world.get(sink, 'Inventory'));
  assert.equal(moved, 4, `rate=4 → 1 秒搬 4 个(实搬 ${moved})`);
  ok('速率: rate=4 每秒搬 4 个');
}

// ============ 背压: 目标满 → 分拣器停手(握住 1 个), 源不再被掏空 ============
{
  const ctx = makeCtx(); ctx.registry.load(gameData); ctx.registry.unlock(['inserter']);
  const world = createWorld();
  const src = world.create();
  world.add(src, 'Inventory', { items: { stone: 100 }, cap: 200 });
  world.add(src, 'Provider', { items: '*' });
  world.add(src, 'Anchor', { dir: dirAt(0), yaw: 0 });
  const sink = world.create();
  world.add(sink, 'Inventory', { items: {}, cap: 3 });   // 只能装 3
  world.add(sink, 'Anchor', { dir: dirAt(0.1), yaw: 0 });
  const ins = placeInserter(world, ctx,
    { kind: 'inv', eid: src, role: 'provide' },
    { kind: 'inv', eid: sink, role: 'any' });
  world.addSystem('ins', createInserterSystem());
  for (let i = 0; i < 200; i++) world.tick(0.05, ctx);
  assert.equal(invTotal(world.get(sink, 'Inventory')), 3, '目标收满 3 后停收');
  const insComp = world.get(ins, 'Inserter');
  // 源被掏走的量 = 3(进 sink) + 至多 1(握在手里)
  const taken = 100 - (world.get(src, 'Inventory').items.stone || 0);
  assert.ok(taken <= 4, `源被掏走不超过 4(sink3+手1), 实际 ${taken}`);
  assert.ok(insComp.carry === 'stone' || taken === 3, '目标满时分拣器握住 1 个或停在只搬了 3 个');
  ok('背压: 目标满 → 分拣器停手, 源不被掏空');
}

console.log(`\nB1 分拣器 全部通过 (${pass} 组断言)`);
