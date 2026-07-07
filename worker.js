// Web Worker(module): 在后台线程生成 patch 网格。
// 地形函数来自共享的 terrain.js(与主线程逐位一致)。

import { buildPatchArrays } from './patchgeom.js';
import { makeTerrain } from './terrain.js';

// 按地形参数缓存 terrain, 避免每条消息重建噪声
let _tkey = null, _terrain = null;
function getTerrain(tp) {
  const k = JSON.stringify(tp);
  if (k !== _tkey) { _terrain = makeTerrain(tp); _tkey = k; }
  return _terrain;
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
