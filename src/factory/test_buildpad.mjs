// G1 无头单测: BuildPad 建造平台(整平 level 编辑 + 采样最低点 + pad 实体 + 拆除恢复)。
// 运行:  node src/factory/test_buildpad.mjs   (零 three.js; 用 stub planet 记录 edits)

import assert from 'node:assert';
import { createWorld } from './core/world.js';
import { createRegistry } from './core/registry.js';
import { createSpatial } from './core/spatial.js';
import { createEventBus } from './core/events.js';
import { placeBuildPad, probePad, expandPad, placeBuildingSnapped, padAt, demolish, rebuildPadEdits } from './systems/placement.js';
import { dot, angle } from './core/sphere.js';
import { dirToCell, canPlace, makePad, dirToOffset } from './core/grid.js';
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

// ---- G4 存档: BuildPad 占位/GridSlot 往返 + rebuildPadEdits 使读档后拆除能恢复整平 ----
{
  const ctx = makeCtx(); const world = createWorld();
  const padEid = placeBuildPad(world, ctx, [0, 1, 0], { cell: 3, radius: 0.1 });
  const pad = world.get(padEid, 'BuildPad');
  const r = placeBuildingSnapped(world, ctx, 'smelter', [0, 1, 0]);   // 占 4 格 + GridSlot
  const slot = world.get(r.eid, 'GridSlot');
  const occKeys = Object.keys(pad.occupied).length;
  assert.equal(occKeys, 4, '存档前: 2x2 占 4 格');

  // world 序列化往返(ECS)
  const snap = JSON.parse(JSON.stringify(world.serialize()));
  const w2 = createWorld(); w2.load(snap);
  const pad2 = w2.get(padEid, 'BuildPad');
  assert.equal(Object.keys(pad2.occupied).length, 4, '读档后: 占位保留');
  assert.ok(w2.has(r.eid, 'GridSlot'), '读档后: GridSlot 保留');
  const slot2 = w2.get(r.eid, 'GridSlot');
  assert.equal(slot2.w * slot2.h, 4, '读档后: footprint 保留');

  // 读档后同格仍被占 → 拒绝重放
  const ctx2 = makeCtx();
  const rr = placeBuildingSnapped(w2, ctx2, 'smelter', [0, 1, 0]);
  assert.ok(rr.blocked, '读档后: 已占格仍拒绝重放');

  // planet 存档单独恢复(模拟): 把整平编辑放回 ctx2.planet.edits, rebuildPadEdits 重建映射
  ctx2.planet.params.edits.push({ type: 'level', pos: [pad2.center[0], pad2.center[1], pad2.center[2]], radius: pad2.radius, level: pad2.level, progress: 1, falloff: 'smooth' });
  rebuildPadEdits(w2, ctx2);
  assert.ok(ctx2.padEdits.has(padEid), 'rebuildPadEdits: 平台→整平编辑映射重建');
  assert.equal(ctx2.planet.params.edits.length, 1, '重建后有 1 条整平编辑');
  demolish(w2, ctx2, padEid);
  assert.equal(ctx2.planet.params.edits.length, 0, '拆除读档平台 → 整平编辑移除(地形恢复)');
  ok('存档: 占位/GridSlot 往返 + rebuildPadEdits 恢复整平');
}

// ---- 多高度重叠: padAt 返回最深(level 最低)平台(挖洞里点击吸附到低平台) ----
{
  const ctx = makeCtx(); const world = createWorld();
  const padA = placeBuildPad(world, ctx, [0, 1, 0], { radius: 0.1, level: 0.5 });   // 上层大平台
  const padB = placeBuildPad(world, ctx, [0, 1, 0], { radius: 0.04, level: 0.1 });  // 里面挖的低平台(更深)
  // 重叠中心: 返回更深的 B
  const hitCenter = padAt(world, [0, 1, 0]);
  assert.equal(hitCenter.eid, padB, '重叠处 padAt 返回最深(低 level)平台');
  // A 内、B 外(角距离 0.07: <0.1 且 >0.04): 返回 A
  const dOut = [Math.sin(0.07), Math.cos(0.07), 0];
  const hitA = padAt(world, dOut);
  assert.equal(hitA.eid, padA, 'B 外 A 内 → 返回 A');
  ok('多高度重叠: padAt 取最深平台');
}

// ---- 探测建造区: 检测平整连通区 → 贴合形状生成; 太小则拒; 随开挖扩张 ----
{
  const ctx = makeCtx(); const world = createWorld();
  const basis = makePad([0, 1, 0], { cell: 3, radius: 0.2 });   // 仅用于把 dir 映射回 u,v
  const setFlat = (half) => { ctx.planet.heightAt = (x, y, z) => { const o = dirToOffset(basis, [x, y, z], 200); return (Math.abs(o.u) <= half && Math.abs(o.v) <= half) ? 0 : 9; }; };

  // 一块方形平地 → 探测成功, 网格贴合(平地外格不在集合)
  setFlat(12);
  const res = probePad(world, ctx, [0, 1, 0], { cell: 3, tol: 0.5, minCells: 9 });
  assert.ok(res && res.eid != null, '平整区探测成功建 pad');
  const pad = world.get(res.eid, 'BuildPad');
  assert.equal(Object.keys(pad.cells).length, res.count, 'pad.cells = 探测到的格数');
  assert.ok(pad.cells['0,0'] && !pad.cells['9,0'], '网格贴合平地(平地外格不含)');
  assert.ok(pad.probe, '标记为探测平台');
  ok(`探测建造区: 平整区生成贴合网格(${res.count} 格)`);

  // 平地扩大 → expandPad 网格跟随增长
  const before = Object.keys(pad.cells).length;
  setFlat(24);
  const n = expandPad(world, ctx, res.eid);
  assert.ok(n > before, `平地扩大后网格扩张(${before}→${n})`);
  ok('探测建造区: 随开挖扩张');

  // 太小/不平 → 拒绝
  const world2 = createWorld();
  ctx.planet.heightAt = (x, y, z) => { const o = dirToOffset(basis, [x, y, z], 200); return (Math.abs(o.u) <= 1 && Math.abs(o.v) <= 1) ? 0 : 9; };
  const rej = probePad(world2, ctx, [0, 1, 0], { cell: 3, tol: 0.5, minCells: 9 });
  assert.ok(rej && rej.rejected && rej.count < 9, `不够大的平地被拒绝(${rej.count} 格)`);
  ok('探测建造区: 面积不足则拒绝');
}

console.log(`\nG1/G3/G4 建造平台+吸附+存档 全部通过 (${pass} 组断言)`);
