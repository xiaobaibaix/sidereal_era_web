// 矿脉/矿柱逻辑 —— 给定方向, 算出从地表往下各深度层是什么物质。
// 自带一个轻量确定性 3D 值噪声(不依赖外部库) → 可 node 单测、主线程/Worker 一致。

function hash3(i, j, k, seed) {
  let h = (Math.imul(i | 0, 374761393) + Math.imul(j | 0, 668265263) + Math.imul(k | 0, 40503) + Math.imul(seed | 0, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;   // [0,1)
}
// 三线性插值的值噪声, 返回 [0,1]
function valueNoise(x, y, z, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy), w = fz * fz * (3 - 2 * fz);
  const c = (dx, dy, dz) => hash3(ix + dx, iy + dy, iz + dz, seed);
  const lerp = (a, b, t) => a + (b - a) * t;
  const x00 = lerp(c(0, 0, 0), c(1, 0, 0), u), x10 = lerp(c(0, 1, 0), c(1, 1, 0), u);
  const x01 = lerp(c(0, 0, 1), c(1, 0, 1), u), x11 = lerp(c(0, 1, 1), c(1, 1, 1), u);
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w);
}

// 某方向的矿柱: 把每层 noise 解析成具体物品(没矿则退回 fallback)。
// dir: 单位向量 [x,y,z]。返回 [{ item, d0, d1, hardness }] 按深度排列。
export function oreColumn(dir, oreData) {
  const layers = (oreData && oreData.layers) || [];
  const fb = (oreData && oreData.fallback) || 'stone';
  const out = [];
  for (const l of layers) {
    let item = l.item;
    if (l.noise) {
      const f = (l.noise.freq || 1) * 4;   // 放大频率, 让矿区成片
      const val = valueNoise(dir[0] * f, dir[1] * f, dir[2] * f, l.noise.seed || 0);
      if (val < (l.noise.threshold != null ? l.noise.threshold : 0.5)) item = l.fallback || fb;
    }
    out.push({ item, d0: l.d[0], d1: l.d[1], hardness: l.hardness || 1 });
  }
  return out;
}

// 挖到深度 depth 时所在的层(超过最深层 → 取最后一层, 即基岩)
export function layerAt(column, depth) {
  for (let i = 0; i < column.length; i++) {
    const l = column[i];
    if (depth >= l.d0 && depth < l.d1) return l;
  }
  return column.length ? column[column.length - 1] : null;
}

export { valueNoise };
