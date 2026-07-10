// Web Worker(module): 在后台线程生成 patch 网格。
// 地形函数来自共享的 terrain.js(与主线程逐位一致)。

import { buildPatchArrays } from './patchgeom.js';
import { makeTerrain } from './terrain.js';

// 按地形参数缓存 terrain(小型 LRU), 避免每条消息重建噪声。
// 共享 worker 池会交错处理多颗行星的任务 → 需缓存多份, 否则每次切换行星都重建。
const _cache = new Map();   // key(JSON) → terrain
function getTerrain(tp) {
  const k = JSON.stringify(tp);
  let t = _cache.get(k);
  if (t) { _cache.delete(k); _cache.set(k, t); return t; }   // 命中: 提到最新
  t = makeTerrain(tp);
  _cache.set(k, t);
  if (_cache.size > 6) _cache.delete(_cache.keys().next().value);   // 超限丢最旧
  return t;
}

self.onmessage = (ev) => {
  const d = ev.data;
  const terrain = getTerrain(d.terrain);
  const a = buildPatchArrays(
    d.A, d.B, d.C, d.N, d.R, d.maxHeight, d.terrain.seaLevel,
    terrain.heightAt, terrain.colorFor, d.strides
  );
  self.postMessage(
    { id: d.id, gen: d.gen, positions: a.positions, normals: a.normals, colors: a.colors, indices: a.indices },
    [a.positions.buffer, a.normals.buffer, a.colors.buffer, a.indices.buffer]
  );
};
