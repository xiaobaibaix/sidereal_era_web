// G0 无头单测: 建造网格数学(平台基/指数·对数映射/吸附/朝向量化/占位)。
// 运行:  node src/factory/test_grid.mjs   (零 three.js)

import assert from 'node:assert';
import {
  makePadBasis, makePad, offsetToDir, dirToOffset, cellToDir, dirToCell, snapDir, snapYaw,
  footprintCells, footprintCenterDir, canPlace, markPlaced, freePlaced, padContaining,
  discCells, floodFlatCells, expandFlatCells,
} from './core/grid.js';
import { norm, dot, angle } from './core/sphere.js';

let pass = 0;
const ok = (n) => { pass++; console.log('  ✓', n); };
const R = 200;                       // 行星半径
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ---- 平台基: 正交单位 ----
{
  const { c, e, n } = makePadBasis([0.3, 1, 0.2]);
  assert.ok(near(Math.hypot(...c), 1) && near(Math.hypot(...e), 1) && near(Math.hypot(...n), 1), 'c/e/n 均为单位向量');
  assert.ok(near(dot(e, n), 0) && near(dot(e, c), 0) && near(dot(n, c), 0), 'e⟂n, e⟂c, n⟂c 正交');
  ok('平台基: {e,n,c} 正交单位');
}

// ---- 指数/对数映射 往返 ----
{
  const pad = makePad([0, 1, 0], { cell: 3, radius: 0.06 });
  for (const [i, j] of [[0, 0], [1, 0], [0, 1], [2, -3], [-4, 5], [3, 3]]) {
    const dir = cellToDir(pad, i, j, R);
    assert.ok(near(Math.hypot(...dir), 1), '格点方向为单位向量');
    const c = dirToCell(pad, dir, R);
    assert.equal(c.i, i, `往返 i (${i},${j})`);
    assert.equal(c.j, j, `往返 j (${i},${j})`);
    const off = dirToOffset(pad, dir, R);
    assert.ok(near(off.u, i * pad.cell, 1e-6) && near(off.v, j * pad.cell, 1e-6), '偏移往返精确');
  }
  ok('指数/对数映射: 格点↔方向 往返精确');
}

// ---- 近中心方格: 相邻格弧长 ≈ cell/R, 对角 ≈ √2·cell/R ----
{
  const pad = makePad([0, 1, 0], { cell: 3, radius: 0.06 });
  const o = cellToDir(pad, 0, 0, R);
  const ax = cellToDir(pad, 1, 0, R);
  const ay = cellToDir(pad, 0, 1, R);
  const ad = cellToDir(pad, 1, 1, R);
  const expect = pad.cell / R;
  assert.ok(near(angle(o, ax), expect, 1e-4), `+i 相邻弧长≈cell/R (${angle(o, ax).toFixed(5)})`);
  assert.ok(near(angle(o, ay), expect, 1e-4), `+j 相邻弧长≈cell/R (${angle(o, ay).toFixed(5)})`);
  assert.ok(near(angle(o, ad), Math.SQRT2 * expect, 1e-4), `对角弧长≈√2·cell/R (${angle(o, ad).toFixed(5)})`);
  ok('近中心: 相邻/对角弧长符合方格');
}

// ---- 吸附: 略偏格点的方向被吸到最近格点; pad 外原样返回 ----
{
  const pad = makePad([0, 1, 0], { cell: 3, radius: 0.06 });
  const node = cellToDir(pad, 2, -1, R);
  // 在 node 附近加一点点偏移(小于半格)
  const off = dirToOffset(pad, node, R);
  const jitter = offsetToDir(pad, off.u + 0.9, off.v - 0.9, R);   // 偏移 < cell/2=1.5
  const s = snapDir(pad, jitter, R);
  assert.ok(s.inside && s.i === 2 && s.j === -1, `吸附到最近格点 (${s.i},${s.j})`);
  assert.ok(angle(s.dir, node) < 1e-6, '吸附方向 = 该格点方向');   // acos 近 0 精度 ~1e-8
  // pad 外(角距离 > radius): 原样返回
  const far = offsetToDir(pad, 0.1 * R, 0, R);   // 角距离 0.1 > radius 0.06
  const s2 = snapDir(pad, far, R);
  assert.ok(!s2.inside && angle(s2.dir, norm(far)) < 1e-6, 'pad 外不吸附, 返回原方向');
  ok('吸附: pad 内就近, pad 外原样');
}

// ---- inside 判定 + padContaining ----
{
  const padA = makePad([0, 1, 0], { radius: 0.06 });
  const padB = makePad(norm([1, 0.2, 0]), { radius: 0.05 });
  const inA = offsetToDir(padA, 0.03 * R, 0, R);   // 距 A 中心 0.03 < 0.06
  const outAll = offsetToDir(padA, 0.5 * R, 0, R);
  assert.equal(padContaining([padA, padB], inA), padA, 'padContaining 命中 A');
  assert.equal(padContaining([padA, padB], padB.center), padB, 'padContaining 命中 B(中心)');
  assert.equal(padContaining([padA, padB], outAll), null, '都不含 → null');
  ok('inside 判定 + padContaining');
}

// ---- 朝向量化: quarter 叠加 90°; 落点朝向确定 ----
{
  const pad = makePad([0, 1, 0], { cell: 3 });
  const dir = cellToDir(pad, 1, 1, R);
  const y0 = snapYaw(pad, dir, 0);
  const y1 = snapYaw(pad, dir, 1);
  assert.ok(Number.isFinite(y0), 'yaw 有限');
  assert.ok(near(((y1 - y0) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2), Math.PI / 2, 1e-9), 'quarter+1 → 朝向 +90°');
  // 在中心处, yaw=0 应使前向对齐平台东向 e(与 worldMatrix 默认前向 t1 的夹角)
  const yc = snapYaw(pad, pad.center, 0);
  assert.ok(Number.isFinite(yc), '中心处 yaw 有限');
  ok('朝向量化: quarter 步进 90°');
}

// ---- 占位: 多格 footprint 覆盖/重叠拒绝/释放 ----
{
  const pad = makePad([0, 1, 0], { cell: 3 });
  assert.deepEqual(footprintCells(0, 0, 2, 2).sort(), [[0, 0], [0, 1], [1, 0], [1, 1]].sort(), 'footprint 2x2 覆盖 4 格');
  assert.ok(canPlace(pad, 0, 0, 2, 2), '初始可放 2x2');
  markPlaced(pad, 0, 0, 2, 2, 42);
  assert.ok(!canPlace(pad, 1, 1, 1, 1), '与已占格 (1,1) 重叠 → 拒绝');
  assert.ok(!canPlace(pad, -1, -1, 2, 2), '部分重叠 (覆盖(0,0)) → 拒绝');
  assert.ok(canPlace(pad, 2, 2, 2, 2), '不重叠 → 可放');
  freePlaced(pad, 0, 0, 2, 2);
  assert.ok(canPlace(pad, 1, 1, 1, 1), '释放后可放');
  // footprint 中心方向: 2x2 锚(0,0) 的中心在 (0.5,0.5)
  const cd = footprintCenterDir(pad, 0, 0, 2, 2, R);
  const cc = cellToDir(pad, 0.5, 0.5, R);
  assert.ok(angle(cd, cc) < 1e-6, 'footprint 中心方向 = (0.5,0.5) 格点');
  ok('占位: 覆盖/重叠拒绝/释放/中心');
}

// ---- 平地探测洪泛: 只收连通的平整格, 边界处停止(网格贴合平地形状) ----
{
  const pad = makePad([0, 1, 0], { cell: 3, radius: 0.3 });
  // heightAt: 方形平地 |u|,|v|<=10(世界单位)内为 0, 其余为 5(不平)
  const flatHeight = (half) => (d) => { const o = dirToOffset(pad, d, R); return (Math.abs(o.u) <= half && Math.abs(o.v) <= half) ? 0 : 5; };
  const res = floodFlatCells(pad, flatHeight(10), R, { tol: 0.5, level: 0 });
  // |i*3|<=10 → i∈[-3,3] → 7x7=49 格
  assert.equal(res.count, 49, `洪泛收到平整方形 7x7=49 格(实${res.count})`);
  assert.equal(res.cells['3,3'], true, '平地内角格在集合');
  assert.ok(!res.cells['4,0'], '平地外格不在集合(边界停止)');
  ok('平地探测洪泛: 贴合平整区形状');

  // 扩张: 平地变大(|u|,|v|<=20) → 以现有格为种子重洪泛, 格数增长
  pad.cells = res.cells; pad.level = 0;
  const grown = expandFlatCells(pad, flatHeight(20), R, { tol: 0.5 });
  assert.ok(grown.count > res.count, `平地扩大后网格跟随增长(${res.count}→${grown.count})`);
  assert.equal(grown.count, 13 * 13, `扩张到 |i|<=6 → 13x13=169(实${grown.count})`);
  ok('平地探测洪泛: 随扩张增长');
}

// ---- 圆盘格集合(调试平整) ----
{
  const pad = makePad([0, 1, 0], { cell: 3, radius: 0.06 });
  const cells = discCells(pad, R);
  assert.ok(Object.keys(cells).length > 0, '圆盘格集合非空');
  assert.equal(cells['0,0'], true, '中心格在集合');
  ok('圆盘格集合(调试平整)');
}

// ---- 全局参考基: 相邻平台方向一致(修复经纬基在极点附近的摆动) ----
{
  const ref = [1, 0, 0];
  const b1 = makePadBasis([0, 1, 0], ref);
  const b2 = makePadBasis(norm([0.1, 1, 0.05]), ref);
  const b3 = makePadBasis(norm([-0.08, 1, 0.06]), ref);
  assert.ok(dot(b1.e, b2.e) > 0.99 && dot(b1.e, b3.e) > 0.99, `全局参考 → 相邻平台 e 方向一致(${dot(b1.e, b2.e).toFixed(3)}, ${dot(b1.e, b3.e).toFixed(3)})`);
  // 对照: 无 ref(经纬基)在极点附近方向剧烈摆动
  const p1 = makePadBasis([0, 1, 0]);
  const p2 = makePadBasis(norm([0.2, 1, 0]));
  assert.ok(dot(p1.e, p2.e) < 0.5, '经纬基在极点附近确实摆动(对照)');
  ok('全局参考基: 相邻平台网格方向一致');
}

console.log(`\nG0 建造网格数学 全部通过 (${pass} 组断言)`);
