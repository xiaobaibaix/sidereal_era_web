// 统一的地形函数(主线程与 Web Worker 共用, 保证 heightAt/colorFor 逐位一致)。
// importmap 不作用于 Worker, 故 simplex-noise 用完整 CDN 地址导入(主线程也能用, 浏览器按 URL 去重)。
//
// Tier 1 结构增强(仍是单值径向高度场 → 碰撞/缝合/无限细节全部保持):
//   - 域扭曲(domain warping): 斑块 → 冲刷流线感
//   - 大陆掩膜: 陆海成片, 海里不叠山
//   - Worley 板块边界带: 山脉沿"板块"边界生长, 有走向
//   - ridged 山脊: 尖锐山脉
//   - 气候配色: 温度(纬度+海拔) × 湿度 → 生物群系

import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.0/dist/esm/simplex-noise.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function fbm(noise, x, y, z, octaves, freq, gain, lac) {
  let sum = 0, amp = 1, f = freq;
  for (let i = 0; i < octaves; i++) { sum += amp * noise(x * f, y * f, z * f); f *= lac; amp *= gain; }
  return sum;
}
function ridged(noise, x, y, z, octaves, freq, gain, lac) {
  let sum = 0, amp = 1, f = freq;
  for (let i = 0; i < octaves; i++) { let n = 1 - Math.abs(noise(x * f, y * f, z * f)); n *= n; sum += amp * n; f *= lac; amp *= gain; }
  return sum;
}

// 3D Worley(细胞噪声): 返回最近/次近特征点距离 {f1, f2}。用整数哈希放置每个细胞的特征点。
function hash3(i, j, k, seed) {
  let h = (Math.imul(i | 0, 374761393) + Math.imul(j | 0, 668265263) + Math.imul(k | 0, 40503) + Math.imul(seed | 0, 971)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  const rx = ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  let h2 = Math.imul(h ^ 0x9e3779b9, 2246822519);
  const ry = ((h2 ^ (h2 >>> 15)) >>> 0) / 4294967296;
  let h3 = Math.imul(h2 ^ 0x85ebca6b, 3266489917);
  const rz = ((h3 ^ (h3 >>> 13)) >>> 0) / 4294967296;
  return [rx, ry, rz];
}
function worley(x, y, z, freq, seed) {
  const px = x * freq, py = y * freq, pz = z * freq;
  const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
  let f1 = 1e9, f2 = 1e9;
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dz = -1; dz <= 1; dz++) {
        const cx = ix + dx, cy = iy + dy, cz = iz + dz;
        const r = hash3(cx, cy, cz, seed);
        const fx = cx + r[0] - px, fy = cy + r[1] - py, fz = cz + r[2] - pz;
        const d = Math.sqrt(fx * fx + fy * fy + fz * fz);
        if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
      }
  return { f1, f2 };
}

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function smoothstep(a, b, x) { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); }
function lerp3(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

// 生成地形函数。参数在此快照为局部常量, 保证一个"代"内主线程与 worker 结果一致。
export function makeTerrain(p) {
  const cSeed = p.continentSeed, cFreq = p.continentFreq, cOct = p.continentOctaves, cGain = p.continentGain, cLac = p.continentLacunarity;
  const mSeed = p.mountainSeed, mFreq = p.mountainFreq, mOct = p.mountainOctaves, mStr = p.mountainStrength;
  const sea = p.seaLevel;
  const warpSeed = p.warpSeed, warp = p.warpStrength, wFreq = p.warpFreq;
  const plateSeed = p.plateSeed, pFreq = p.plateFreq, plate = p.plateStrength;
  const moSeed = p.moistureSeed, moFreq = p.moistureFreq;
  const useClimate = p.useClimate;
  const altRange = p.climateAltRange || 1.0;

  // 运行时编辑(挖掘/抬升)。snapshot 一份避免外部修改影响一致性。
  // 每个 edit: { pos: [ux,uy,uz] 单位方向, radius: 角半径(弧度), depth: 0..1, falloff }
  const edits = Array.isArray(p.edits) ? p.edits.map((e) => ({
    pos: e.pos, radius: e.radius, depth: e.depth, falloff: e.falloff || 'smooth',
  })) : [];

  // 可调调色板(缺省回退到原硬编码值 → 不传颜色的调用者行为不变)
  const C = {
    oceanShallow: p.colOceanShallow || [0.20, 0.45, 0.62],
    oceanDeep: p.colOceanDeep || [0.03, 0.12, 0.30],
    beach: p.colBeach || [0.82, 0.78, 0.55],
    dry: p.colDry || [0.78, 0.70, 0.42],       // 暖·干 → 荒漠
    wet: p.colWet || [0.13, 0.45, 0.15],       // 暖·湿 → 雨林/低地绿
    coldDry: p.colColdDry || [0.55, 0.53, 0.45], // 冷·干 → 苔原
    coldWet: p.colColdWet || [0.22, 0.38, 0.32], // 冷·湿 → 针叶林
    rock: p.colRock || [0.50, 0.50, 0.52],
    snow: p.colSnow || [0.97, 0.97, 1.0],
  };

  const noiseC = createNoise3D(mulberry32(cSeed));
  const noiseM = createNoise3D(mulberry32(mSeed));
  const noiseW = createNoise3D(mulberry32(warpSeed));
  const noiseH = createNoise3D(mulberry32(moSeed));

  function heightAt(x, y, z) {
    // 域扭曲: 用一层噪声扰动采样坐标
    let wx = x, wy = y, wz = z;
    if (warp > 0) {
      const q0 = noiseW(x * wFreq, y * wFreq, z * wFreq);
      const q1 = noiseW(x * wFreq + 31.4, y * wFreq + 12.7, z * wFreq + 5.2);
      const q2 = noiseW(x * wFreq + 7.7, y * wFreq + 41.3, z * wFreq + 19.1);
      wx = x + warp * q0; wy = y + warp * q1; wz = z + warp * q2;
    }
    // 大陆(低频 fBm) → 掩膜(海里不叠山)
    const cont = fbm(noiseC, wx, wy, wz, cOct, cFreq, cGain, cLac);
    const land = smoothstep(-0.06, 0.10, cont);
    // 山脉(ridged)
    const mtn = ridged(noiseM, wx, wy, wz, mOct, mFreq, 0.5, 2.0);
    // Worley 板块边界带: F2-F1 在细胞边界→0, 起脊
    let belt = 0;
    if (plate > 0) {
      const w = worley(wx, wy, wz, pFreq, plateSeed);
      belt = Math.pow(1 - clamp01(w.f2 - w.f1), 6);
    }
    const mountains = (mtn + belt * plate) * land;
    let h = cont + mountains * mStr;
    // 叠加运行时 edits(挖掘/抬升): 把行星表面"按方向"打孔/起脊
    if (edits.length > 0) {
      const len = Math.hypot(x, y, z) || 1;
      const ux = x / len, uy = y / len, uz = z / len;
      for (let i = 0; i < edits.length; i++) {
        const e = edits[i];
        const cos = ux * e.pos[0] + uy * e.pos[1] + uz * e.pos[2];
        if (cos <= 0) continue;                              // edit 在球的对面, 不影响
        if (cos >= 1) { h -= e.depth; continue; }            // 正中心
        const ang = Math.acos(cos);
        if (ang > e.radius) continue;                        // 角距离 > 半径, 不在刷子内
        const t = ang / e.radius;                            // 0=中心, 1=边缘
        const fall = e.falloff === 'sharp' ? 1.0
                    : e.falloff === 'linear' ? 1.0 - t
                    : Math.cos(t * Math.PI * 0.5);           // smooth (cosine)
        h -= e.depth * fall;
      }
    }
    return h;
  }

  function colorFor(h, x, y, z) {
    // 海洋: 深浅水渐变
    if (h < sea) {
      const d = clamp01((sea - h) / 0.3);
      return lerp3(C.oceanShallow, C.oceanDeep, d);
    }
    if (!useClimate) {
      const t = clamp01(h);
      if (t < 0.05) return C.beach;
      if (t < 0.4) return C.wet;
      if (t < 0.7) return C.rock;
      return C.snow;
    }
    // 海岸沙滩
    if (h - sea < 0.02) return C.beach;
    // 气候: 温度(海拔+纬度) × 湿度 → 生物群系
    const alt = clamp01((h - sea) / altRange);
    const lat = Math.abs(y);                                   // 纬度 0..1
    const temp = clamp01((1 - alt) * (1 - lat));               // 1=热, 0=冷
    let moist = noiseH(x * moFreq, y * moFreq, z * moFreq) * 0.5 + 0.5;
    moist = clamp01(moist * (1 - alt * 0.4));                  // 越高越干
    // 高海拔 / 极寒 → 岩石到雪
    if (alt > 0.72 || temp < 0.12) {
      const s = clamp01((Math.max(alt, 1 - temp) - 0.6) / 0.4);
      return lerp3(C.rock, C.snow, s);
    }
    const cold = lerp3(C.coldDry, C.coldWet, moist);  // 冷: 苔原→针叶林
    const warm = lerp3(C.dry, C.wet, moist);          // 热: 荒漠→雨林
    return lerp3(cold, warm, temp);
  }

  return { heightAt, colorFor };
}
