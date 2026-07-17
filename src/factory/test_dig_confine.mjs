// 修复回归: 挖机不重复挖"已经比目标更低"的位置。
// generateVertices 的 baseH 取"当前地形高度(heightAt, 含已有挖掘)"而非原始噪声(baseHeightAt),
// 所以已被挖低的位置 targetOffset≈0, 挖机不会再去挖。
// 运行:  node src/factory/test_dig_confine.mjs   (纯逻辑; stub planet)

import assert from 'node:assert';
import { generateVertices } from './systems/mining_crew.js';
import { angle } from './core/sphere.js';
import gameData from './data/gamedata.js';

let pass = 0;
const ok = (n) => { pass++; console.log('  ✓', n); };
const C = [0, 1, 0];

// stub planet: 原始噪声(baseHeightAt)到处都高=1.0; 但当前地形(heightAt)中心已被挖低到 0.2。
// 若挖机按 baseHeightAt 判定 → 会以为中心还高 1.0 要继续挖(bug);
// 按 heightAt 判定 → 中心 targetOffset≈0, 不再挖。
const planet = {
  params: { radius: 100 },
  baseHeightAt() { return 1.0; },
  heightAt(x, y, z) { return angle([x, y, z], C) < 0.02 ? 0.2 : 1.0; },
};
const ore = gameData.ore;
const hardnessMax = (gameData.machineTypes.excavator_mk1 || {}).hardnessMax || 2;

{
  const zone = { center: C, radius: 0.05, resolution: 0.01 };
  const vs = generateVertices(zone, planet, ore, hardnessMax);
  assert.ok(vs.length > 0, '生成了顶点');
  // 基准面 = 当前地形最低点 ≈ 0.2(中心已挖低区)
  assert.ok(Math.abs(zone.planeH - 0.2) < 1e-6, `planeH 取当前地形最低≈0.2(实 ${zone.planeH})`);

  let centerV = null, outerV = null;
  for (const v of vs) {
    const a = angle(v.dir, C);
    if (a < 0.015 && !centerV) centerV = v;
    if (a > 0.035 && !outerV) outerV = v;
  }
  assert.ok(centerV && outerV, '取到中心/外围顶点');
  assert.ok(centerV.targetOffset < 1e-6, `已挖低的中心 targetOffset≈0(不再挖, 实 ${centerV.targetOffset})`);
  assert.ok(outerV.targetOffset > 0.1, `仍高的外围 targetOffset>0(要挖平, 实 ${outerV.targetOffset.toFixed(2)})`);
  // baseH 用的是当前高度: 中心≈0.2(已低), 外围≈1.0
  assert.ok(Math.abs(centerV.baseH - 0.2) < 1e-6, '中心 baseH 取当前(已挖低)高度 0.2');
  assert.ok(Math.abs(outerV.baseH - 1.0) < 1e-6, '外围 baseH 取当前高度 1.0');
  ok('已挖低处不重复挖: baseH 用当前地形高度');
}

console.log(`\n挖掘限制修复 全部通过 (${pass} 组断言)`);
