// M0 无头单测: 验证 ECS/事件/注册表/空间/存档/门面。
// 运行:  node src/factory/test_m0.mjs
// 不依赖 three.js(不导入 anchor.js)。

import assert from 'node:assert';
import { createWorld } from './core/world.js';
import { createEventBus } from './core/events.js';
import { createRegistry } from './core/registry.js';
import { createSpatial } from './core/spatial.js';
import { toJSON, fromJSON } from './core/save.js';
import { createFactory } from './factory.js';

let pass = 0;
const ok = (name) => { pass++; console.log('  ✓', name); };

// ---- World: 实体/组件/查询 ----
{
  const w = createWorld();
  const a = w.create(), b = w.create(), c = w.create();
  w.add(a, 'Pos', { x: 1 }); w.add(a, 'Vel', { x: 2 });
  w.add(b, 'Pos', { x: 10 });
  w.add(c, 'Vel', { x: 5 });
  assert.equal(w.entityCount, 3);
  assert.equal(w.count('Pos'), 2);
  assert.equal(w.get(a, 'Pos').x, 1);
  assert.ok(w.has(a, 'Vel') && !w.has(b, 'Vel'));

  const posVel = [...w.query('Pos', 'Vel')];
  assert.deepEqual(posVel, [a]);                       // 只有 a 同时有 Pos+Vel
  const pos = [...w.query('Pos')].sort((x, y) => x - y);
  assert.deepEqual(pos, [a, b]);

  let seen = 0;
  w.each(['Pos'], (e, p) => { seen++; assert.ok(typeof p.x === 'number'); });
  assert.equal(seen, 2);

  w.remove(a, 'Vel');
  assert.equal([...w.query('Pos', 'Vel')].length, 0);
  w.destroy(b);
  assert.equal(w.count('Pos'), 1);
  assert.ok(!w.alive(b));
  ok('World 实体/组件/查询/each/删除');
}

// ---- System + tick ----
{
  const w = createWorld();
  for (let i = 0; i < 5; i++) { const e = w.create(); w.add(e, 'N', { v: 0 }); }
  w.addSystem('inc', (world, dt) => { world.each(['N'], (e, n) => { n.v += dt; }); });
  for (let i = 0; i < 10; i++) w.tick(0.5);
  assert.equal(w.tickCount, 10);
  assert.equal(w.time, 5);
  let all5 = true; w.each(['N'], (e, n) => { if (Math.abs(n.v - 5) > 1e-9) all5 = false; });
  assert.ok(all5);
  ok('System + 固定 tick 累加');
}

// ---- 序列化往返 ----
{
  const w = createWorld();
  const e = w.create(); w.add(e, 'Pos', { x: 3, y: 4 }); w.add(e, 'Tag', { on: true });
  w.tick(1); // time=1
  const snap = w.serialize();
  const w2 = createWorld().load(JSON.parse(JSON.stringify(snap)));
  assert.equal(w2.entityCount, 1);
  assert.deepEqual(w2.get(e, 'Pos'), { x: 3, y: 4 });
  assert.equal(w2.get(e, 'Tag').on, true);
  assert.equal(w2.time, 1);
  // load 后新建实体 id 不撞
  const e2 = w2.create();
  assert.ok(e2 > e);
  ok('World 序列化 → load 往返');
}

// ---- EventBus ----
{
  const bus = createEventBus();
  let got = null, onceCount = 0;
  const off = bus.on('boom', (p) => { got = p; });
  bus.once('once', () => onceCount++);
  bus.emit('boom', 42); assert.equal(got, 42);
  bus.emit('once'); bus.emit('once'); assert.equal(onceCount, 1);
  off(); bus.emit('boom', 99); assert.equal(got, 42);   // 已取消订阅
  ok('EventBus on/once/off/emit');
}

// ---- Registry ----
{
  const reg = createRegistry();
  reg.load({
    items: { iron_ore: { name: '铁矿' }, iron_ingot: { name: '铁锭' } },
    recipes: { smelt_iron: { in: [{ iron_ore: 2 }], out: [{ iron_ingot: 1 }], time: 40, building: 'smelter' } },
    buildings: { smelter: { name: '冶炼炉', recipes: ['smelt_iron'] } },
  });
  const rs = reg.recipesFor('smelter');
  assert.equal(rs.length, 1);
  assert.equal(rs[0].time, 40);
  ok('Registry load + recipesFor + 校验');
}

// ---- Spatial ----
{
  const sp = createSpatial();
  sp.insert(1, [0, 1, 0]);            // 北极
  sp.insert(2, [0, 0.9848, 0.1736]);  // 离北极 ~10°
  sp.insert(3, [0, -1, 0]);           // 南极
  const near = sp.queryCap([0, 1, 0], 0.3).sort((a, b) => a - b);  // 0.3rad ≈ 17°
  assert.deepEqual(near, [1, 2]);
  assert.equal(sp.nearest([0, 1, 0]), 1);
  assert.equal(sp.nearest([0, -1, 0]), 3);
  sp.remove(2);
  assert.equal(sp.size, 2);
  ok('Spatial 球冠查询 / 最近 / 删除');
}

// ---- Save 往返 ----
{
  const w = createWorld();
  const e = w.create(); w.add(e, 'A', { k: 7 });
  const json = toJSON(w, { note: 'hi' });
  const w2 = createWorld();
  const meta = fromJSON(json, w2);
  assert.equal(w2.get(e, 'A').k, 7);
  assert.equal(meta.version, 1);
  ok('Save toJSON / fromJSON 往返');
}

// ---- Factory 门面 ----
{
  const factory = createFactory({ data: { items: { x: { name: 'X' } } } });
  assert.ok(factory.registry.items.x);
  let ran = 0;
  factory.addSystem('noop', () => { ran++; });
  factory.tick(0.1); factory.tick(0.1);
  assert.equal(ran, 2);
  assert.equal(factory.world.time.toFixed(1), '0.2');
  ok('Factory 门面 addSystem/tick/data');
}

console.log(`\nM0 全部通过 (${pass} 组断言)`);
