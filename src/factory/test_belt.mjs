// B0 无头单测: 传送带核心(物品前进 / 间距背压 / 容量 / 到头投递 / 目标满背压)。
// 运行:  node src/factory/test_belt.mjs   (零 three.js)

import assert from 'node:assert';
import { createWorld } from './core/world.js';
import { createRegistry } from './core/registry.js';
import { createSpatial } from './core/spatial.js';
import { createEventBus } from './core/events.js';
import { invTotal } from './core/inventory.js';
import { createBelt, createBeltSystem, beltAddItem, stepBelt } from './systems/belt.js';
import { placeBelt } from './systems/placement.js';
import * as S from './core/sphere.js';
import gameData from './data/gamedata.js';

let pass = 0;
const ok = (n) => { pass++; console.log('  ✓', n); };

function makeCtx() {
  const registry = createRegistry().load(gameData);
  return { registry, spatial: createSpatial(), bus: createEventBus() };
}
// 绕 z 轴把 [1,0,0] 转 ang → 得到与之相隔 ang 弧度的方向
const dirAt = (ang) => [Math.cos(ang), Math.sin(ang), 0];

// ---- 容量 = floor(length/spacing) ----
{
  const world = createWorld(); const ctx = makeCtx();
  const len = 0.2;   // 弧长(角)
  const e = createBelt(world, ctx, dirAt(0), dirAt(len));
  const belt = world.get(e, 'Belt');
  assert.ok(Math.abs(belt.length - len) < 1e-6, `带弧长≈${len}`);
  assert.equal(belt.cap, Math.floor(len / belt.spacing), `cap=floor(len/spacing)=${belt.cap}`);
  assert.equal(belt.speed, 0.15, '默认 speed 来自 belt_mk1');
  ok(`容量/几何: length=${belt.length.toFixed(3)} cap=${belt.cap}`);
}

// ---- 物品匀速前进 + 到头投递到 Inventory ----
{
  const world = createWorld(); const ctx = makeCtx();
  const sink = world.create();
  world.add(sink, 'Inventory', { items: {}, cap: 100 });
  const e = createBelt(world, ctx, dirAt(0), dirAt(0.2), { outPort: { kind: 'inv', eid: sink, role: 'any' } });
  const belt = world.get(e, 'Belt');
  world.addSystem('belt', createBeltSystem());

  assert.ok(beltAddItem(belt, 'iron_ore'), '入口放一个物品');
  assert.equal(belt.items.length, 1, '带上 1 个物品');
  assert.equal(belt.items[0].s, 0, '入口 s=0');

  const dsExpect = (belt.speed * 0.05) / belt.length;
  world.tick(0.05, ctx);
  assert.ok(Math.abs(belt.items[0].s - dsExpect) < 1e-9, `一帧前进 ds≈${dsExpect.toFixed(4)}`);

  // 继续 tick 直到投递到 sink
  let ticks = 1;
  while (invTotal(world.get(sink, 'Inventory')) < 1 && ticks < 500) { world.tick(0.05, ctx); ticks++; }
  assert.equal(invTotal(world.get(sink, 'Inventory')), 1, '物品到头后投递进 Inventory');
  assert.equal(belt.items.length, 0, '投递后带清空');
  // 行程时间 ≈ length/speed = 0.2/0.15 ≈ 1.33s → 约 27 帧
  assert.ok(ticks >= 24 && ticks <= 32, `行程帧数合理(${ticks})`);
  ok(`物品匀速前进 → 到头投递(用了 ${ticks} 帧)`);
}

// ---- 入口 spacing 背压: 连放两个 → 第二个被拒(尾物品未离开入口) ----
{
  const world = createWorld(); const ctx = makeCtx();
  const e = createBelt(world, ctx, dirAt(0), dirAt(0.3));
  const belt = world.get(e, 'Belt');
  world.addSystem('belt', createBeltSystem());
  assert.ok(beltAddItem(belt, 'stone'), '放第 1 个成功');
  assert.equal(beltAddItem(belt, 'stone'), false, '紧接着放第 2 个被拒(间距不足)');
  // tick 到尾物品离开入口 spacing 后可再放
  const spNorm = belt.spacing / belt.length;
  const need = Math.ceil(spNorm / ((belt.speed * 0.05) / belt.length)) + 1;
  for (let i = 0; i < need; i++) world.tick(0.05, ctx);
  assert.ok(beltAddItem(belt, 'stone'), '尾物品前进 spacing 后可再放');
  assert.equal(belt.items.length, 2, '带上 2 个物品');
  ok('入口 spacing 背压: 间距不足拒收, 前进后可续放');
}

// ---- 容量背压: 无输出口持续投喂, 物品数不超过 cap 且维持 spacing ----
{
  const world = createWorld(); const ctx = makeCtx();
  const e = createBelt(world, ctx, dirAt(0), dirAt(0.12));   // 短带
  const belt = world.get(e, 'Belt');
  world.addSystem('belt', createBeltSystem());
  // 每帧都尝试投喂(大多会被 spacing/cap 拒), tick 很多帧
  for (let i = 0; i < 400; i++) { beltAddItem(belt, 'iron_ore'); world.tick(0.05, ctx); }
  assert.ok(belt.items.length <= belt.cap, `物品数不超过 cap(${belt.items.length}<=${belt.cap})`);
  assert.ok(belt.items.length >= belt.cap - 1, `带被填满到接近 cap(${belt.items.length})`);
  assert.ok(belt.items[0].s >= 1 - 1e-6, '无输出 → 头堵在出口(s=1)');
  // 相邻物品间距 >= spacing(归一化)
  const spNorm = belt.spacing / belt.length;
  let okSpacing = true;
  for (let i = 1; i < belt.items.length; i++) if (belt.items[i - 1].s - belt.items[i].s < spNorm - 1e-6) okSpacing = false;
  assert.ok(okSpacing, '相邻物品维持 spacing');
  ok(`容量背压: 填满至 cap=${belt.cap}, 头堵出口, 维持间距`);
}

// ---- 目标 Inventory 满 → 到头投不掉(背压), 腾空后恢复投递 ----
{
  const world = createWorld(); const ctx = makeCtx();
  const sink = world.create();
  world.add(sink, 'Inventory', { items: {}, cap: 2 });   // 只能收 2 个
  const e = createBelt(world, ctx, dirAt(0), dirAt(0.15), { outPort: { kind: 'inv', eid: sink, role: 'any' } });
  const belt = world.get(e, 'Belt');
  world.addSystem('belt', createBeltSystem());
  for (let i = 0; i < 300; i++) { beltAddItem(belt, 'iron_ore'); world.tick(0.05, ctx); }
  assert.equal(invTotal(world.get(sink, 'Inventory')), 2, '目标收满 2 个后不再收(背压)');
  assert.ok(belt.items.length > 0, '带上物品堆积(投不掉)');
  assert.ok(belt.items[0].s >= 1 - 1e-6, '头堵在出口');
  // 腾空目标 → 带恢复投递
  world.get(sink, 'Inventory').items = {};
  for (let i = 0; i < 50; i++) world.tick(0.05, ctx);
  assert.ok(invTotal(world.get(sink, 'Inventory')) > 0, '目标腾空后带恢复投递');
  ok('目标满 → 头部背压; 腾空后恢复投递');
}

// ---- 'request' 语义投递: 仅投递目标需要的物品 ----
{
  const world = createWorld(); const ctx = makeCtx();
  const machine = world.create();
  world.add(machine, 'Inventory', { items: {}, cap: 100 });
  world.add(machine, 'Requester', { needs: { iron_ore: 10 } });   // 只要 iron_ore
  const e = createBelt(world, ctx, dirAt(0), dirAt(0.1), { outPort: { kind: 'inv', eid: machine, role: 'request' } });
  const belt = world.get(e, 'Belt');
  world.addSystem('belt', createBeltSystem());
  // 放一个 copper_ore(非需求) → 到头投不掉, 堵住
  beltAddItem(belt, 'copper_ore');
  for (let i = 0; i < 80; i++) world.tick(0.05, ctx);
  assert.equal(world.get(machine, 'Inventory').items.copper_ore || 0, 0, 'request 端拒收非需求物品');
  assert.ok(belt.items.length === 1 && belt.items[0].s >= 1 - 1e-6, '非需求物品堵在头部');
  ok("request 语义: 仅投递目标需求物品");
}

// ---- placeBelt 科技锁: 未解锁返回 null, 解锁后成功 ----
{
  const world = createWorld(); const ctx = makeCtx();
  assert.equal(placeBelt(world, ctx, dirAt(0), dirAt(0.1)), null, 'belt 未解锁 → placeBelt 返回 null');
  ctx.registry.unlock(['belt']);
  const e = placeBelt(world, ctx, dirAt(0), dirAt(0.1));
  assert.ok(e != null && world.has(e, 'Belt'), '解锁后 placeBelt 成功');
  ok('placeBelt 科技锁: 未解锁拒绝, 解锁后放置');
}

// ---- 序列化往返: 带上物品序列保留 ----
{
  const world = createWorld(); const ctx = makeCtx();
  const e = createBelt(world, ctx, dirAt(0), dirAt(0.2));
  const belt = world.get(e, 'Belt');
  beltAddItem(belt, 'iron_ore');
  stepBelt(world, 0.05, belt); stepBelt(world, 0.05, belt);
  const snap = JSON.parse(JSON.stringify(world.serialize()));
  const w2 = createWorld(); w2.load(snap);
  const b2 = w2.get(e, 'Belt');
  assert.equal(b2.items.length, 1, '反序列化后物品数一致');
  assert.ok(Math.abs(b2.items[0].s - belt.items[0].s) < 1e-9, '物品位置 s 保留');
  ok('序列化往返: 带上物品序列保留');
}

console.log(`\nB0 传送带核心 全部通过 (${pass} 组断言)`);
