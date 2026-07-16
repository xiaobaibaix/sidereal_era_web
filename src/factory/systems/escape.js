// 逃逸判据(M8) —— 判断一颗天体相对中心天体(恒星)是否已脱离引力束缚。
//   比机械能 ε = ½v² − μ/r  (μ = G·M_center)。ε ≥ 0 → 轨道为抛物/双曲 → 逃逸。
//   逃逸速度 vesc = √(2μ/r); v ≥ vesc 等价于 ε ≥ 0。
// 纯数学(数组坐标, 无 three.js) → 可 node 单测。solar_system 用它出逃逸读数/结算。

export function specificEnergy(v, r, mu) { return 0.5 * v * v - mu / r; }

// relPos/relVel: 相对中心天体的 [x,y,z] 位置/速度; mu = G·M_center
export function escapeInfo({ relPos, relVel, mu }) {
  const r = Math.hypot(relPos[0], relPos[1], relPos[2]) || 1e-9;
  const v = Math.hypot(relVel[0], relVel[1], relVel[2]);
  const energy = 0.5 * v * v - mu / r;
  const vesc = Math.sqrt(2 * mu / r);
  return { r, v, vesc, energy, escaped: energy >= 0, ratio: vesc > 0 ? v / vesc : Infinity };
}
