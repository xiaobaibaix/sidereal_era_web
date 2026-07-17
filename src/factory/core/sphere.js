// 球面数学(纯数组 [x,y,z], 零 three.js 依赖) —— 供物流/agent 在球面上大圆移动。
// 与 excavators.js 的 THREE 版逻辑一致, 但可 node 单测、可进 Worker。

export function norm(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
export function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
export function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export function angle(a, b) { return Math.acos(Math.max(-1, Math.min(1, dot(a, b)))); }

// Rodrigues 旋转: v 绕单位轴 axis 转 ang
export function rotateAxis(v, axis, ang) {
  const c = Math.cos(ang), s = Math.sin(ang), d = dot(axis, v) * (1 - c), cr = cross(axis, v);
  return [v[0] * c + cr[0] * s + axis[0] * d, v[1] * c + cr[1] * s + axis[1] * d, v[2] * c + cr[2] * s + axis[2] * d];
}

// dir 沿大圆朝 target 移动最多 maxAng; 返回 { dir(新), arrived }
export function moveToward(dir, target, maxAng, arriveAng = 0.02) {
  const ang = angle(dir, target);
  const arrive = Math.max(arriveAng, maxAng * 1.2);
  if (ang <= arrive) return { dir: [target[0], target[1], target[2]], arrived: true };
  let axis = cross(dir, target);
  const al = Math.hypot(axis[0], axis[1], axis[2]);
  if (al < 1e-9) return { dir: [dir[0], dir[1], dir[2]], arrived: true };
  axis = [axis[0] / al, axis[1] / al, axis[2] / al];
  return { dir: norm(rotateAxis(dir, axis, Math.min(maxAng, ang))), arrived: false };
}

// 大圆插值(测地线 slerp): 在单位方向 a→b 之间按 t∈[0,1] 取点。用于带上物品/带段沿弧摆放。
export function slerp(a, b, t) {
  const om = angle(a, b);
  if (om < 1e-6) return [a[0], a[1], a[2]];
  const so = Math.sin(om);
  const s0 = Math.sin((1 - t) * om) / so, s1 = Math.sin(t * om) / so;
  return norm([a[0] * s0 + b[0] * s1, a[1] * s0 + b[1] * s1, a[2] * s0 + b[2] * s1]);
}

// target 在 dir 切平面上的方向(前进朝向)
export function tangentToward(dir, target) {
  const d = dot(target, dir);
  const t = [target[0] - dir[0] * d, target[1] - dir[1] * d, target[2] - dir[2] * d];
  const l = Math.hypot(t[0], t[1], t[2]);
  if (l < 1e-9) return Math.abs(dir[1]) < 0.99 ? norm(cross([0, 1, 0], dir)) : norm(cross([1, 0, 0], dir));
  return [t[0] / l, t[1] / l, t[2] / l];
}

// 与 dir 垂直的单位向量
function perp(n) {
  const t = Math.abs(n[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0];
  return norm(cross(t, n));
}
// 以 center 为极点、角半径 capRadius 内的均匀随机方向
export function randInCap(center, capRadius) {
  const u = Math.random();
  const ang = Math.acos(1 - u * (1 - Math.cos(capRadius)));
  const az = Math.random() * Math.PI * 2;
  const t1 = perp(center), t2 = norm(cross(center, t1));
  const s = Math.sin(ang), c = Math.cos(ang), ca = Math.cos(az), sa = Math.sin(az);
  return norm([
    center[0] * c + (t1[0] * ca + t2[0] * sa) * s,
    center[1] * c + (t1[1] * ca + t2[1] * sa) * s,
    center[2] * c + (t1[2] * ca + t2[2] * sa) * s,
  ]);
}
