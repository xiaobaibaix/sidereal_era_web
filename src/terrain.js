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

  // 地表材质(方案B: 顶点级坡度混岩 + 低频颜色扰动, 打破单调色块; 逐顶点在 worker/主线程一致)
  const slopeRock = p.surfSlopeRock != null ? p.surfSlopeRock : 0.7;      // 陡坡露岩强度(0=关)
  const colorJitter = p.surfColorJitter != null ? p.surfColorJitter : 0.1; // 同 biome 颜色扰动幅度(0=关)
  const jitterFreq = p.surfColorFreq != null ? p.surfColorFreq : 6.0;      // 扰动噪声频率(越大越碎)

  // 运行时编辑。snapshot 一份避免外部修改影响一致性。
  // 两类:
  //   减量式(默认, 鼠标刷子/填埋区): { pos, radius, depth(0..1, 正=挖/负=抬), falloff }
  //   整平式(挖掘机挖掘区): { type:'level', pos, radius, level(目标 h 平面), progress(0..1), falloff }
  const edits = Array.isArray(p.edits) ? p.edits.map((e) => ({
    type: e.type || 'sub',
    pos: e.pos, radius: e.radius,
    depth: e.depth, level: e.level, progress: e.progress, dry: e.dry,
    falloff: e.falloff || 'smooth',
  })) : [];
  // 顶点网格(B升级·逐顶点挖掘): 每个矿场挖掘区一组离散顶点; heightAt 用"progress 加权整平"把
  // 它们叠加到高度场上 → 挖机改某顶点 offset 即"该方向逐渐下沉到 planeH", 视觉上一点一点下降。
  //   - center: zone 中心方向(单位向量)
  //   - cosRadiusPad: cos(radius+padding), 角距离 > radius+pad 的采样点直接跳过该 zone(粗筛)
  //   - planeH: zone 整平基准(挖完后所有顶点高度 = planeH, 即球面切片)
  //   - maxInfluence: 单顶点影响半径(角弧度); 通常 = zone.resolution × 1.5
  //   - vertices: [{ dir, offset, targetOffset }]
  //       offset = 已挖深度; targetOffset = 应挖深度(baseH - planeH)。
  //       progress_i = offset/targetOffset(0=未挖, 1=完成); targetOffset=0 的"天然基准点" progress=1。
  //   heightAt 在 zone 影响内把 h 朝 planeH 拉, 拉力 = IDW 加权的 progress →
  //     完全挖完的 zone: h = planeH(完美球面切片, 无 bumps);
  //     部分挖: h 在 baseH 与 planeH 之间平滑过渡;
  //     边界外: h = baseH(dir)(原地形)。
  //   比"减 IDW(offset)"准: 那样 baseNoise 在顶点间的高频起伏会泄漏成 bumps。
  const digZones = Array.isArray(p.digZoneVertices) ? p.digZoneVertices.map((z) => ({
    center: z.center,
    cosRadiusPad: Math.cos((z.radius || 0) + 0.005),
    planeH: z.planeH || 0,
    maxInfluence: z.maxInfluence || 0.0075,
    vertices: Array.isArray(z.vertices) ? z.vertices.map((v) => ({
      dir: v.dir, offset: v.offset || 0, targetOffset: v.targetOffset || 0,
    })) : [],
  })) : [];
  // 每条挖掘编辑自带 dry 标记(挖的那刻的开关状态): 默认(dry!==false)是"干坑"→坑底露泥土;
  // dry===false 的是"湖"(关闭开关时挖的)→坑内保留海洋色。逐编辑独立, 改开关不影响已挖好的。
  const lakeEdits = edits.filter((e) => e.dry === false).map((e) => ({ pos: e.pos, cosR: Math.cos(e.radius) }));
  const DUG_COLOR = p.colDug || [0.34, 0.27, 0.19];   // 干坑坑底泥土色

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
  const noiseV = createNoise3D(mulberry32((moSeed ^ 0x5f356495) >>> 0));   // 地表颜色扰动噪声(独立种子, 与湿度解耦)

  // 基础地形高度(不含运行时 edits): 用于判断某方向"天然是陆地还是海"。
  function baseHeightAt(x, y, z) {
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
    return cont + mountains * mStr;
  }

  function heightAt(x, y, z) {
    let h = baseHeightAt(x, y, z);
    // 叠加运行时 edits(挖掘/抬升): 把行星表面"按方向"打孔/起脊/整平
    if (edits.length > 0) {
      const len = Math.hypot(x, y, z) || 1;
      const ux = x / len, uy = y / len, uz = z / len;
      for (let i = 0; i < edits.length; i++) {
        const e = edits[i];
        const cos = ux * e.pos[0] + uy * e.pos[1] + uz * e.pos[2];
        if (cos <= 0) continue;                              // edit 在球的对面, 不影响
        const ang = cos >= 1 ? 0 : Math.acos(cos);
        if (ang > e.radius) continue;                        // 角距离 > 半径, 不在范围内
        const t = ang / e.radius;                            // 0=中心, 1=边缘
        const fall = e.falloff === 'sharp' ? 1.0
                    : e.falloff === 'linear' ? 1.0 - t
                    : Math.cos(t * Math.PI * 0.5);           // smooth (cosine)
        if (e.type === 'level') {
          // 整平到目标平面(只挖不填): 用"平顶"权重 → 内侧 ~75% 完全削平到 level(真正的平地),
          // 外侧 25% 平滑过渡回原地形; 按 progress 推进。progress=1 时圆区内高于 level 处全被削平。
          const leveled = h < e.level ? h : e.level;
          const rim = 0.75;
          let w;
          if (t <= rim) w = 1.0;
          else { const s = (t - rim) / (1 - rim); w = 1 - s * s * (3 - 2 * s); }
          h += (leveled - h) * w * (e.progress || 0);
        } else {
          h -= e.depth * fall;                               // 减量式(挖/抬)
        }
      }
    }
    // 叠加顶点网格(B升级·逐顶点挖掘): progress 加权整平到 planeH。
    //   progress = IDW 加权的 (offset/targetOffset) → 0..1 表示"此处挖完了多少"。
    //   h 朝 planeH 拉 progress 比例 → 完成处 h=planeH(球面切片), 未挖处 h=原值。
    //   天然基准点(targetOffset=0 即 baseH==planeH)算 progress=1(本来就在基准上)。
    if (digZones.length > 0) {
      const len = Math.hypot(x, y, z) || 1;
      const ux = x / len, uy = y / len, uz = z / len;
      for (let gi = 0; gi < digZones.length; gi++) {
        const zg = digZones[gi];
        const cosC = ux * zg.center[0] + uy * zg.center[1] + uz * zg.center[2];
        if (cosC < zg.cosRadiusPad) continue;                // 粗筛: 角距离 > radius+pad
        let weight = 0, sumDone = 0;
        for (let vi = 0; vi < zg.vertices.length; vi++) {
          const v = zg.vertices[vi];
          const cos = ux * v.dir[0] + uy * v.dir[1] + uz * v.dir[2];
          if (cos <= 0) continue;
          const ang = cos >= 1 ? 0 : Math.acos(cos);
          if (ang > zg.maxInfluence) continue;
          const w = 1 / Math.max(ang, 1e-4);                 // 反距离权重
          weight += w;
          // 该顶点的"完成度": targetOffset=0 → 1(天然在基准上); 否则 offset/targetOffset clamp 到 [0,1]
          const done = v.targetOffset <= 1e-6 ? 1
            : v.offset >= v.targetOffset - 1e-6 ? 1
            : v.offset <= 0 ? 0
            : v.offset / v.targetOffset;
          sumDone += w * done;
        }
        if (weight > 0) {
          const progress = sumDone / weight;                 // 0..1
          if (progress > 0) h = h + (zg.planeH - h) * progress;
        }
      }
    }
    return h;
  }

  // 地表材质后处理(方案B): 陆地色 → 陡坡混岩 + 低频颜色扰动。
  // slope: 1 - (法线·径向), 平坦≈0, 陡坡→大(由 patchgeom 传入; 缺省 0 = 不混岩)。
  // 只作用于陆地(海洋/挖坑泥土保持原样, 海面另有 shader)。
  function surfaceApply(col, slope, x, y, z) {
    // 陡坡露岩: 缓坡草木、陡坡裸岩, 一下就有"地形感"
    if (slopeRock > 0 && slope > 0) {
      const w = smoothstep(0.22, 0.6, slope) * slopeRock;
      if (w > 0) col = lerp3(col, C.rock, w);
    }
    // 低频颜色扰动: 同一 biome 内轻微明暗/色相漂移, 打破纯色块的"塑料感"
    if (colorJitter > 0) {
      const v = noiseV(x * jitterFreq, y * jitterFreq, z * jitterFreq);   // [-1,1]
      const f = 1 + v * colorJitter;
      col = [clamp01(col[0] * f), clamp01(col[1] * f), clamp01(col[2] * f)];
    }
    return col;
  }

  function colorFor(h, x, y, z, slope) {
    // 海洋: 深浅水渐变(不做地表材质处理)
    if (h < sea) {
      // 陆地(原始地形高于海平面)被挖到海平面以下 → 露泥土; 但落在"湖"编辑内则保留海洋色。天然海不受影响。
      if (edits.length > 0 && baseHeightAt(x, y, z) >= sea) {
        let lake = false;
        if (lakeEdits.length) {
          const len = Math.hypot(x, y, z) || 1;
          const ux = x / len, uy = y / len, uz = z / len;
          for (let i = 0; i < lakeEdits.length; i++) {
            const e = lakeEdits[i];
            if (ux * e.pos[0] + uy * e.pos[1] + uz * e.pos[2] >= e.cosR) { lake = true; break; }
          }
        }
        if (!lake) return DUG_COLOR;
      }
      const d = clamp01((sea - h) / 0.3);
      return lerp3(C.oceanShallow, C.oceanDeep, d);
    }
    // 陆地: 先算 biome 基色, 再统一叠加地表材质处理
    let col;
    if (!useClimate) {
      const t = clamp01(h);
      if (t < 0.05) col = C.beach;
      else if (t < 0.4) col = C.wet;
      else if (t < 0.7) col = C.rock;
      else col = C.snow;
    } else if (h - sea < 0.02) {
      col = C.beach;                                             // 海岸沙滩
    } else {
      // 气候: 温度(海拔+纬度) × 湿度 → 生物群系
      const alt = clamp01((h - sea) / altRange);
      const lat = Math.abs(y);                                   // 纬度 0..1
      const temp = clamp01((1 - alt) * (1 - lat));               // 1=热, 0=冷
      let moist = noiseH(x * moFreq, y * moFreq, z * moFreq) * 0.5 + 0.5;
      moist = clamp01(moist * (1 - alt * 0.4));                  // 越高越干
      if (alt > 0.72 || temp < 0.12) {
        // 高海拔 / 极寒 → 岩石到雪
        const s = clamp01((Math.max(alt, 1 - temp) - 0.6) / 0.4);
        col = lerp3(C.rock, C.snow, s);
      } else {
        const cold = lerp3(C.coldDry, C.coldWet, moist);  // 冷: 苔原→针叶林
        const warm = lerp3(C.dry, C.wet, moist);          // 热: 荒漠→雨林
        col = lerp3(cold, warm, temp);
      }
    }
    return surfaceApply(col, slope || 0, x, y, z);
  }

  return { heightAt, colorFor, baseHeightAt };
}
