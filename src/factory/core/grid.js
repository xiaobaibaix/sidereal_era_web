// 建造网格(网格球)数学 —— 平台切平面基 + 球面指数/对数映射 + 吸附 + 朝向量化 + 占位。纯逻辑, 零 three.js。
//
// 思路(见《网格辅助建造》设计 C):
//   以平台中心 c(单位方向)建切平面正交基 {e(东), n(北)}, 格点(i,j) 经"指数映射"贴到球面 → 局部方格、整体随曲率弯曲。
//   吸附: 方向经"对数映射"回切平面坐标(米) → 就近取整到格点 → 指数映射回球面。
//   朝向: 建筑前向对齐平台东向(与 worldMatrix 的默认前向做有符号夹角), 量化到 90°。
//   占位: pad.occupied 记录已占格("i,j"), 支持多格 footprint。
//
// R = 行星半径(planet.params.radius); 角半径 radius 决定平台覆盖范围。

import { norm, dot, cross, angle } from './sphere.js';

// 平台切平面基: 返回 { c, e, n } (右手系 {e, n, c})
export function makePadBasis(center) {
  const c = norm(center);
  const a = Math.abs(c[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0];
  const e = norm(cross(a, c));   // 东向切向
  const n = cross(c, e);         // 北向切向(c,e 正交 → 已是单位)
  return { c, e, n };
}

// 建一个平台(纯数据; 将作为 BuildPad 组件)。opts: { cell, radius, level }
export function makePad(center, opts = {}) {
  const { c, e, n } = makePadBasis(center);
  return {
    center: c, e, n,
    cell: opts.cell != null ? opts.cell : 3.0,       // 世界单位/格
    radius: opts.radius != null ? opts.radius : 0.06, // 角半径(弧度)
    level: opts.level != null ? opts.level : 0,       // 整平高度(供地形 level 编辑)
    occupied: opts.occupied || {},                    // { "i,j": eid }
  };
}

// 切平面偏移(u,v 米) → 球面方向(指数映射)
export function offsetToDir(pad, u, v, R) {
  const tx = pad.e[0] * u + pad.n[0] * v;
  const ty = pad.e[1] * u + pad.n[1] * v;
  const tz = pad.e[2] * u + pad.n[2] * v;
  const d = Math.hypot(tx, ty, tz);
  if (d < 1e-12) return [pad.center[0], pad.center[1], pad.center[2]];
  const alpha = d / R;
  const ca = Math.cos(alpha), sa = Math.sin(alpha);
  const hx = tx / d, hy = ty / d, hz = tz / d;
  return norm([
    pad.center[0] * ca + hx * sa,
    pad.center[1] * ca + hy * sa,
    pad.center[2] * ca + hz * sa,
  ]);
}

// 球面方向 → 切平面偏移(对数映射)。返回 { u, v, ang }(ang=与中心的角距离)
export function dirToOffset(pad, dir, R) {
  const d0 = norm(dir);
  const cosang = Math.max(-1, Math.min(1, dot(pad.center, d0)));
  const alpha = Math.acos(cosang);
  const px = d0[0] - pad.center[0] * cosang;
  const py = d0[1] - pad.center[1] * cosang;
  const pz = d0[2] - pad.center[2] * cosang;
  const pl = Math.hypot(px, py, pz);
  if (pl < 1e-12) return { u: 0, v: 0, ang: alpha };
  const hx = px / pl, hy = py / pl, hz = pz / pl;
  const dm = alpha * R;
  return {
    u: dm * (hx * pad.e[0] + hy * pad.e[1] + hz * pad.e[2]),
    v: dm * (hx * pad.n[0] + hy * pad.n[1] + hz * pad.n[2]),
    ang: alpha,
  };
}

// 格点 (i,j) → 球面方向(i,j 可为小数, 用于 footprint 中心)
export function cellToDir(pad, i, j, R) {
  return offsetToDir(pad, i * pad.cell, j * pad.cell, R);
}

// 方向 → 最近格点 { i, j, inside }
export function dirToCell(pad, dir, R) {
  const { u, v, ang } = dirToOffset(pad, dir, R);
  return { i: Math.round(u / pad.cell), j: Math.round(v / pad.cell), inside: ang <= pad.radius };
}

// 吸附: pad 内 → 最近格点方向 { dir, i, j, inside:true }; pad 外 → 原方向 { dir, i:null, j:null, inside:false }
export function snapDir(pad, dir, R) {
  const { u, v, ang } = dirToOffset(pad, dir, R);
  if (ang > pad.radius) return { dir: norm(dir), i: null, j: null, inside: false };
  const i = Math.round(u / pad.cell), j = Math.round(v / pad.cell);
  return { dir: cellToDir(pad, i, j, R), i, j, inside: true };
}

// 朝向量化: 使建筑前向对齐平台东向(平移到落点), 叠加玩家旋转 quarter·90°。返回 yaw(弧度)。
// 与 anchor.worldMatrix 约定一致: 默认前向 t1 = norm(cross(up, p)), up=|p.y|<0.99?[0,1,0]:[1,0,0]。
export function snapYaw(pad, dir, quarter = 0) {
  const p = norm(dir);
  const up = Math.abs(p[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0];
  const t1 = norm(cross(up, p));                       // worldMatrix 的 yaw=0 前向
  const ed = dot(p, pad.e);                            // 平台东向平移到 p(投影到切平面)
  let ex = pad.e[0] - p[0] * ed, ey = pad.e[1] - p[1] * ed, ez = pad.e[2] - p[2] * ed;
  const el = Math.hypot(ex, ey, ez) || 1; ex /= el; ey /= el; ez /= el;
  const cosA = dot(t1, [ex, ey, ez]);
  const cr = cross(t1, [ex, ey, ez]);
  const sinA = dot(cr, p);                             // 有符号(绕径向 p)
  return Math.atan2(sinA, cosA) + quarter * Math.PI / 2;
}

// ---- 占位(多格建筑) ----
const cellKey = (i, j) => i + ',' + j;

// footprint [w,h] 锚在最小角 (i,j) 时覆盖的格
export function footprintCells(i, j, w = 1, h = 1) {
  const out = [];
  for (let di = 0; di < w; di++) for (let dj = 0; dj < h; dj++) out.push([i + di, j + dj]);
  return out;
}

// footprint 覆盖格的中心方向(放置锚点 dir); 最小角 (i,j)
export function footprintCenterDir(pad, i, j, w, h, R) {
  return cellToDir(pad, i + (w - 1) / 2, j + (h - 1) / 2, R);
}

export function canPlace(pad, i, j, w = 1, h = 1) {
  for (const [ci, cj] of footprintCells(i, j, w, h)) if (pad.occupied[cellKey(ci, cj)] != null) return false;
  return true;
}
export function markPlaced(pad, i, j, w = 1, h = 1, eid = true) {
  for (const [ci, cj] of footprintCells(i, j, w, h)) pad.occupied[cellKey(ci, cj)] = eid;
}
export function freePlaced(pad, i, j, w = 1, h = 1) {
  for (const [ci, cj] of footprintCells(i, j, w, h)) delete pad.occupied[cellKey(ci, cj)];
}

// 从一组 pad 里找包含该方向的(角距离 ≤ radius); 无则 null
export function padContaining(pads, dir) {
  const d = norm(dir);
  for (const pad of pads) if (angle(pad.center, d) <= pad.radius) return pad;
  return null;
}
