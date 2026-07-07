// Web Worker(module): 在后台线程生成 patch 网格。
// 注意: importmap 不作用于 Worker, 所以 simplex-noise 用完整 CDN 地址导入。

import { createNoise3D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.0/dist/esm/simplex-noise.js';
import { buildPatchArrays } from './patchgeom.js';

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

// 按 seed 缓存噪声生成器, 避免每条消息重建
const cache = { cs: null, ms: null, nc: null, nm: null };
function getNoise(cs, ms) {
  if (cache.cs !== cs) { cache.nc = createNoise3D(mulberry32(cs)); cache.cs = cs; }
  if (cache.ms !== ms) { cache.nm = createNoise3D(mulberry32(ms)); cache.ms = ms; }
  return cache;
}

self.onmessage = (ev) => {
  const d = ev.data;
  const { nc, nm } = getNoise(d.continentSeed, d.mountainSeed);

  const heightAt = (x, y, z) => {
    const cont = fbm(nc, x, y, z, d.continentOctaves, d.continentFreq, d.continentGain, d.continentLacunarity);
    const mtn = ridged(nm, x, y, z, d.mountainOctaves, d.mountainFreq, 0.5, 2.0);
    const mask = Math.min(1, Math.max(0, cont));
    return cont + mtn * d.mountainStrength * mask;
  };
  const colorFor = (h) => {
    if (h < d.seaLevel) return [0.05, 0.2, 0.5];
    const t = Math.min(1, Math.max(0, h));
    if (t < 0.05) return [0.85, 0.8, 0.55];
    if (t < 0.4) return [0.2, 0.5, 0.15];
    if (t < 0.7) return [0.4, 0.3, 0.2];
    return [0.95, 0.95, 0.98];
  };

  const a = buildPatchArrays(d.A, d.B, d.C, d.N, d.R, d.maxHeight, d.seaLevel, heightAt, colorFor);
  self.postMessage(
    { id: d.id, gen: d.gen, positions: a.positions, normals: a.normals, colors: a.colors, indices: a.indices },
    [a.positions.buffer, a.normals.buffer, a.colors.buffer, a.indices.buffer]
  );
};
