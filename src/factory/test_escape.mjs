// M8 无头单测: 逃逸判据(ε=½v²-μ/r)。
// 运行:  node src/factory/test_escape.mjs

import assert from 'node:assert';
import { escapeInfo, specificEnergy } from './systems/escape.js';

let pass = 0;
const ok = (n) => { pass++; console.log('  ✓', n); };

const mu = 1000, r = 100;
const vCirc = Math.sqrt(mu / r);       // 圆轨速度
const vEsc = Math.sqrt(2 * mu / r);    // 逃逸速度

// ---- 圆轨: 未逃逸, v/vesc ≈ 1/√2, 能量 = -μ/2r < 0 ----
{
  const info = escapeInfo({ relPos: [r, 0, 0], relVel: [0, vCirc, 0], mu });
  assert.equal(info.escaped, false, '圆轨未逃逸');
  assert.ok(Math.abs(info.ratio - 1 / Math.SQRT2) < 1e-6, `v/vesc≈0.707 (=${info.ratio.toFixed(3)})`);
  assert.ok(Math.abs(info.energy - (-mu / (2 * r))) < 1e-6, '圆轨能量 = -μ/2r');
  ok('圆轨: 未逃逸(ε<0, v/vesc≈0.707)');
}

// ---- 达到逃逸速度: escaped, 能量≈0 ----
{
  const info = escapeInfo({ relPos: [r, 0, 0], relVel: [0, vEsc, 0], mu });
  assert.equal(info.escaped, true, '达到 vesc → 逃逸');
  assert.ok(Math.abs(info.energy) < 1e-6, '逃逸速度处能量≈0');
  assert.ok(Math.abs(info.vesc - vEsc) < 1e-9, 'vesc 计算正确');
  ok('达到逃逸速度: escaped(ε≈0)');
}

// ---- 超过逃逸速度: escaped, 能量>0 ----
{
  const info = escapeInfo({ relPos: [r, 0, 0], relVel: [0, vEsc * 1.2, 0], mu });
  assert.equal(info.escaped, true, '超逃逸速度 → 逃逸');
  assert.ok(info.energy > 0, '双曲轨道能量>0');
  ok('超逃逸速度: escaped(ε>0)');
}

// ---- specificEnergy 一致性 ----
{
  assert.ok(Math.abs(specificEnergy(vCirc, r, mu) - (-mu / (2 * r))) < 1e-6, 'specificEnergy 圆轨');
  ok('specificEnergy 与 escapeInfo 一致');
}

console.log(`\nM8 逃逸判据 全部通过 (${pass} 组断言)`);
