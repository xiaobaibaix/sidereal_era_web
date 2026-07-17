// G1 无头单测: BuildPad 建造平台(整平 level 编辑 + 采样最低点 + pad 实体 + 拆除恢复)。
// 运行:  node src/factory/test_buildpad.mjs   (零 three.js; 用 stub planet 记录 edits)

import assert from 'node:assert';
import { createWorld } from './core/world.js';
import { createRegistry } from './core/registry.js';
import { createSpatial } from './core/spatial.js';
import { createEventBus } from './core/events.js';
import { placeBuildPad, placeBuildingSnapped, padAt, demolish } from './systems/placement.js';
import { dot, angle } from './core/sphere.js';
import { dirToCell, canPlace } from './core/grid.js';
import gameData from './data/gamedata.js';

let pass = 0;
const ok = (n) => { pass++; console.log('  ✓', n); };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// stub planet: 记录 edits; baseHeightAt 随 x 变化(圆区内有最低点); 支持刷新钩子。
function stubPlanet() {
  return {
    params: { edits: [], radius: 200, maxHeight: 8, seaLevel: 0 },
    roots: [], _editPending: false,
    _buildNoise() {}, _invalidateAffected() {},
    baseHeightAt(x /*, y, z */) { return 0.1 + 0.5 * x; },   // 随 x 线性 → 圆区内一侧更低
    heightAt() { return 0; },
    position: { x: 0, y: 0, z: 0 },
  };
}
function makeCtx() {
  return { registry: createRegistry().load(gameData), spatial: createSpatial(), bus: createEventBus(), planet: stubPlanet() };
}

// ---- 平台创建: 组件/基/参数 ----
{
  const ctx = makeCtx(); const world = createWorld();
  const e = placeBuildPad(world, ctx, [0, 1, 0]);
  assert.ok(e != null && world.has(e, 'BuildPad'), '创建了 BuildPad 实体');
  const pad = world.get(e, 'BuildPad');
  assert.equal(pad.cell, 3.0, 'cell 取自 build_pad 定义');
  assert.equal(pad.radius, 0.06, 'radius 取自定义');
  assert.ok(near(dot(pad.e, pad.n), 0) && near(dot(pad.e, pad.center), 0), '平台基正交');
  assert.deepEqual(pad.occupied, {}, '初始无占位');
  ok('平台创建: 组件/正交基/参数');
}

// ---- 整平 level 编辑: 推入 planet.edits, 取圆区最低点 ----
{
  const ctx = makeCtx(); const world = createWorld();
  const centerBase = ctx.planet.baseHeightAt(0, 1, 0);   // = 0.1
  const e = placeBuildPad(world, ctx, [0, 1, 0]);
  const pad = world.get(e, 'BuildPad');
  assert.equal(ctx.planet.params.edits.length, 1, '推入 1 条地形编辑');
  const ed = ctx.planet.params.edits[0];
  assert.equal(ed.type, 'level', '编辑类型为 level(整平)');
  assert.equal(ed.progress, 1, '即时成型 progress=1');
  assert.ok(near(ed.level, pad.level), 'edit.level 与 pad.level 一致');
  assert.ok(pad.level < centerBase - 1e-6, `level 取圆区最低点(<中心 ${centerBase})`);
  assert.ok(near(ed.radius, pad.radius) && ed.pos[1] === 1, 'edit 半径/位置正确');
  ok(`整平编辑: level=${pad.level.toFixed(4)} < 中心 ${centerBase}`);
}

// ---- 显式 level + 拆除恢复 ----
{
  const ctx = makeCtx(); const world = createWorld();
  const e = placeBuildPad(world, ctx, [0, 1, 0], { level: -0.2, cell: 4, radius: 0.08 });
  const pad = world.get(e, 'BuildPad');
  assert.equal(pad.level, -0.2, '显式 level 生效');
  assert.equal(pad.cell, 4, '显式 cell 生效');
  assert.equal(ctx.planet.params.edits.length, 1, '有 1 条编辑');
  demolish(world, ctx, e);
  assert.equal(ctx.planet.params.edits.length, 0, '拆除后整平编辑被移除(地形恢复)');
  assert.ok(!world.alive(e), '实体已销毁');
  ok('显式参数 + 拆除恢复整平');
}

// ---- 无 planet: 不报错, level=0, 无编辑 ----
{
  const ctx = makeCtx(); ctx.planet = null; const world = createWorld();
  const e = placeBuildPad(world, ctx, [0, 1, 0]);
  assert.ok(e != null && world.get(e, 'BuildPad').level === 0, '无 planet → level=0 且不报错');
  ok('无 planet 时安全');
}

// ---- G3 吸附放置: 平台内落格 + footprint 占位 + 拆除释放 ----
{
  const ctx = makeCtx(); const world = createWorld();
  const padEid = placeBuildPad(world, ctx, [0, 1, 0], { cell: 3, radius: 0.1 });
  const pad = world.get(padEid, 'BuildPad');
  const R = ctx.planet.params.radius;

  // 在中心附近放一个冶炼炉(footprint 2x2) → 应吸附落格并占 4 格
  const r1 = placeBuildingSnapped(world, ctx, 'smelter', [0, 1, 0]);
  assert.ok(r1.eid != null && r1.snapped && !r1.blocked, '平台内: 吸附放置成功');
  assert.ok(world.has(r1.eid, 'GridSlot'), '放置的建筑带 GridSlot');
  const slot = world.get(r1.eid, 'GridSlot');
  assert.equal(slot.w * slot.h, 4, 'footprint 2x2 占 4 格');
  assert.ok(!canPlace(pad, slot.i, slot.j, 2, 2), '占位后同处不可再放');
  // 放置点方向应正好在平台内且吸附到 footprint 中心格
  const anch = world.get(r1.eid, 'Anchor');
  assert.ok(angle(anch.dir, pad.center) <= pad.radius, '吸附点落在平台内');

  // 在同一格再放 → 被占位拒绝
  const r2 = placeBuildingSnapped(world, ctx, 'smelter', [0, 1, 0]);
  assert.ok(r2.eid == null && r2.blocked, '重叠放置被占位拒绝');

  ok('吸附放置: 平台内落格 + 占位拒绝重叠');

  // 拆除 → 释放占位, 可再放
  demolish(world, ctx, r1.eid);
  assert.ok(canPlace(pad, slot.i, slot.j, 2, 2), '拆除后占位释放');
  const r3 = placeBuildingSnapped(world, ctx, 'smelter', [0, 1, 0]);
  assert.ok(r3.eid != null && !r3.blocked, '释放后可重新放置');
  ok('拆除释放占位 → 可重放');
}

// ---- G3 平台外: 自由放置(不吸附, 无 GridSlot) ----
{
  const ctx = makeCtx(); const world = createWorld();
  placeBuildPad(world, ctx, [0, 1, 0], { radius: 0.06 });
  const farDir = (() => { // 距平台中心很远的方向
    return [Math.sin(1.2), Math.cos(1.2), 0];
  })();
  assert.equal(padAt(world, farDir), null, '远处不在任何平台内');
  const r = placeBuildingSnapped(world, ctx, 'warehouse', farDir);
  assert.ok(r.eid != null && !r.snapped, '平台外: 自由放置(未吸附)');
  assert.ok(!world.has(r.eid, 'GridSlot'), '自由放置无 GridSlot');
  ok('平台外: 自由放置(不规整也能放)');
}

console.log(`\nG1/G3 建造平台+吸附 全部通过 (${pass} 组断言)`);
