// B3 无头单测: 分流器(合流 / 分流 / 按物品路由)。
// 运行:  node src/factory/test_splitter.mjs   (零 three.js)

import assert from 'node:assert';
import { createWorld } from './core/world.js';
import { createRegistry } from './core/registry.js';
import { createSpatial } from './core/spatial.js';
import { createEventBus } from './core/events.js';
import { createBelt, createBeltSystem, beltAddItem } from './systems/belt.js';
import { createSplitterSystem } from './systems/splitter.js';
import { placeSplitter } from './systems/placement.js';
import gameData from './data/gamedata.js';

let pass = 0;
const ok = (n) => { pass++; console.log('  ✓', n); };

function makeCtx() {
  const registry = createRegistry().load(gameData);
  registry.unlockAll();
  return { registry, spatial: createSpatial(), bus: createEventBus() };
}
const dirAt = (ang) => [Math.cos(ang), Math.sin(ang), 0];
// 一个收集用的库存实体
function sink(world, cap = 100000) { const e = world.create(); world.add(e, 'Inventory', { items: {}, cap }); return e; }
const sinkItems = (world, e) => world.get(e, 'Inventory').items;
const sinkTotal = (world, e) => { let t = 0; const it = world.get(e, 'Inventory').items; for (const k in it) t += it[k]; return t; };

// ============ 分流 balance: 一进两出, 平均分配 ============
{
  const world = createWorld(); const ctx = makeCtx();
  const inB = createBelt(world, ctx, dirAt(0), dirAt(0.2));
  const sA = sink(world), sB = sink(world);
  const outA = createBelt(world, ctx, dirAt(0.2), dirAt(0.35), { outPort: { kind: 'inv', eid: sA, role: 'any' } });
  const outB = createBelt(world, ctx, dirAt(0.2), dirAt(0.35), { outPort: { kind: 'inv', eid: sB, role: 'any' } });
  placeSplitter(world, ctx, null, { ins: [inB], outs: [outA, outB], mode: 'balance' });
  world.addSystem('belt', createBeltSystem());
  world.addSystem('splitter', createSplitterSystem());

  const belt = world.get(inB, 'Belt');
  for (let i = 0; i < 3000; i++) { beltAddItem(belt, 'iron_ore'); world.tick(0.05, ctx); }
  const a = sinkTotal(world, sA), b = sinkTotal(world, sB);
  assert.ok(a > 50 && b > 50, `两出带都收到货(a=${a}, b=${b})`);
  assert.ok(Math.abs(a - b) / (a + b) < 0.1, `balance 大致平均(a=${a}, b=${b}, 偏差${(Math.abs(a - b) / (a + b) * 100).toFixed(1)}%)`);
  ok(`分流 balance: 一进两出平均分配(a=${a}, b=${b})`);
}

// ============ 分流 priority: 优先喂前带, 满了才溢出到后带 ============
{
  const world = createWorld(); const ctx = makeCtx();
  const inB = createBelt(world, ctx, dirAt(0), dirAt(0.2));
  const sA = sink(world, 5);            // 前带的汇很小 → 很快填满 → 前带回堵
  const sB = sink(world, 100000);
  const outA = createBelt(world, ctx, dirAt(0.2), dirAt(0.30), { outPort: { kind: 'inv', eid: sA, role: 'any' } });
  const outB = createBelt(world, ctx, dirAt(0.2), dirAt(0.30), { outPort: { kind: 'inv', eid: sB, role: 'any' } });
  placeSplitter(world, ctx, null, { ins: [inB], outs: [outA, outB], mode: 'priority' });
  world.addSystem('belt', createBeltSystem());
  world.addSystem('splitter', createSplitterSystem());

  const belt = world.get(inB, 'Belt');
  for (let i = 0; i < 3000; i++) { beltAddItem(belt, 'iron_ore'); world.tick(0.05, ctx); }
  const a = sinkTotal(world, sA), b = sinkTotal(world, sB);
  assert.equal(a, 5, `前带汇被填满(a=${a})`);
  assert.ok(b > 50, `前带堵后溢出到后带(b=${b})`);
  ok(`分流 priority: 优先前带(满5)后溢出后带(b=${b})`);
}

// ============ 合流 merge: 两进一出, 两路都汇入 ============
{
  const world = createWorld(); const ctx = makeCtx();
  const in1 = createBelt(world, ctx, dirAt(0), dirAt(0.2));
  const in2 = createBelt(world, ctx, dirAt(0.1), dirAt(0.2));
  const sOut = sink(world);
  const outB = createBelt(world, ctx, dirAt(0.2), dirAt(0.35), { outPort: { kind: 'inv', eid: sOut, role: 'any' } });
  placeSplitter(world, ctx, null, { ins: [in1, in2], outs: [outB], mode: 'balance' });
  world.addSystem('belt', createBeltSystem());
  world.addSystem('splitter', createSplitterSystem());

  const b1 = world.get(in1, 'Belt'), b2 = world.get(in2, 'Belt');
  for (let i = 0; i < 3000; i++) { beltAddItem(b1, 'iron_ore'); beltAddItem(b2, 'copper_ore'); world.tick(0.05, ctx); }
  const items = sinkItems(world, sOut);
  assert.ok((items.iron_ore || 0) > 50, `出带收到入带1的 iron_ore(${items.iron_ore || 0})`);
  assert.ok((items.copper_ore || 0) > 50, `出带收到入带2的 copper_ore(${items.copper_ore || 0})`);
  ok(`合流: 两入带都汇入一出带(Fe=${items.iron_ore || 0}, Cu=${items.copper_ore || 0})`);
}

// ============ filter 路由: 混合流按物品分类到不同出带 ============
{
  const world = createWorld(); const ctx = makeCtx();
  const inB = createBelt(world, ctx, dirAt(0), dirAt(0.2));
  const sFe = sink(world), sCu = sink(world);
  const outFe = createBelt(world, ctx, dirAt(0.2), dirAt(0.35), { outPort: { kind: 'inv', eid: sFe, role: 'any' } });
  const outCu = createBelt(world, ctx, dirAt(0.2), dirAt(0.35), { outPort: { kind: 'inv', eid: sCu, role: 'any' } });
  placeSplitter(world, ctx, null, {
    ins: [inB], outs: [outFe, outCu], mode: 'filter',
    filters: { [outFe]: ['iron_ore'], [outCu]: ['copper_ore'] },
  });
  world.addSystem('belt', createBeltSystem());
  world.addSystem('splitter', createSplitterSystem());

  const belt = world.get(inB, 'Belt');
  for (let i = 0; i < 4000; i++) { beltAddItem(belt, i % 2 ? 'iron_ore' : 'copper_ore'); world.tick(0.05, ctx); }
  const fe = sinkItems(world, sFe), cu = sinkItems(world, sCu);
  assert.ok((fe.iron_ore || 0) > 20, `iron_ore 路由到 Fe 出带(${fe.iron_ore || 0})`);
  assert.equal(fe.copper_ore || 0, 0, 'Fe 出带无 copper_ore');
  assert.ok((cu.copper_ore || 0) > 20, `copper_ore 路由到 Cu 出带(${cu.copper_ore || 0})`);
  assert.equal(cu.iron_ore || 0, 0, 'Cu 出带无 iron_ore');
  ok(`filter 路由: 混合流分类(Fe带 Fe=${fe.iron_ore || 0}, Cu带 Cu=${cu.copper_ore || 0})`);
}

console.log(`\nB3 分流器 全部通过 (${pass} 组断言)`);
