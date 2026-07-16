// 纯几何构建(无 THREE 依赖), 主线程和 Web Worker 共用。
//
// 关键点(为消除 T 型接缝):
// 1) 边顶点用"递归中点细分(dyadic)"生成, 使相邻不同层级 patch 的边顶点严格嵌套。
// 2) strides[edge] 表示该边相对粗邻居要"抽稀"的倍率; 把多余(非保留)顶点吸附到
//    保留顶点(与粗邻居重合)之间的直线上 → 两侧边完全重合, 缝消失。
// 法线仍用有限差分(反映真实斜率, 且同一位置结果一致 → 无着色接缝)。

function normArr(x, y, z) { const l = 1 / Math.hypot(x, y, z); return [x * l, y * l, z * l]; }
function dist3(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }

// 递归中点细分一条边(P->Q), N 必须是 2 的幂。返回 N+1 个单位向量。
function dyadicEdge(P, Q, N) {
  let pts = [P, Q];
  while (pts.length - 1 < N) {
    const next = [];
    for (let i = 0; i < pts.length - 1; i++) {
      next.push(pts[i]);
      next.push(normArr(pts[i][0] + pts[i + 1][0], pts[i][1] + pts[i + 1][1], pts[i][2] + pts[i + 1][2]));
    }
    next.push(pts[pts.length - 1]);
    pts = next;
  }
  return pts;
}

// 把一条边上"非保留"的顶点吸附到保留顶点之间的直线(粗邻居的边线)上。
function snapEdge(gi, stride, pos, nor, col, N) {
  if (stride <= 1) return;
  for (let k = 1; k < N; k++) {
    if (k % stride === 0) continue;            // 保留顶点(与粗邻居重合)
    const lo = Math.floor(k / stride) * stride;
    const hi = lo + stride;
    const t = (k - lo) / stride;
    const a = gi[k] * 3, l = gi[lo] * 3, h = gi[hi] * 3;
    for (let c = 0; c < 3; c++) {
      pos[a + c] = pos[l + c] * (1 - t) + pos[h + c] * t;
      col[a + c] = col[l + c] * (1 - t) + col[h + c] * t;
    }
    let nx = nor[l] * (1 - t) + nor[h] * t;
    let ny = nor[l + 1] * (1 - t) + nor[h + 1] * t;
    let nz = nor[l + 2] * (1 - t) + nor[h + 2] * t;
    const nl = 1 / (Math.hypot(nx, ny, nz) || 1);
    nor[a] = nx * nl; nor[a + 1] = ny * nl; nor[a + 2] = nz * nl;
  }
}

// A,B,C: [x,y,z] 单位向量。strides: [sAB, sAC, sBC](默认全 1)。
export function buildPatchArrays(A, B, C, N, R, maxHeight, seaLevel, heightAt, colorFor, strides) {
  strides = strides || [1, 1, 1];
  const rowIndex = (i, j) => i * (N + 1) - (i * (i - 1)) / 2 + j;
  const mainCount = ((N + 1) * (N + 2)) / 2;

  const edgeAB = dyadicEdge(A, B, N);
  const edgeAC = dyadicEdge(A, C, N);
  const edgeBC = dyadicEdge(B, C, N);

  const dirs = new Array(mainCount);
  const pos = new Float32Array(mainCount * 3);
  const nor = new Float32Array(mainCount * 3);
  const col = new Float32Array(mainCount * 3);

  const EPS = 1e-3;

  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N - i; j++) {
      let d;
      if (j === 0) d = edgeAB[i];
      else if (i === 0) d = edgeAC[j];
      else if (i + j === N) d = edgeBC[N - i];
      else {
        const w0 = (N - i - j) / N, w1 = i / N, w2 = j / N;
        d = normArr(A[0] * w0 + B[0] * w1 + C[0] * w2, A[1] * w0 + B[1] * w1 + C[1] * w2, A[2] * w0 + B[2] * w1 + C[2] * w2);
      }
      const k3 = rowIndex(i, j) * 3;
      dirs[rowIndex(i, j)] = d;

      const h = heightAt(d[0], d[1], d[2]);
      const rr = R + h * maxHeight;
      pos[k3] = d[0] * rr; pos[k3 + 1] = d[1] * rr; pos[k3 + 2] = d[2] * rr;

      // 有限差分法线(先算, 供 colorFor 的坡度混岩用)
      let hax = 1, hay = 0, haz = 0;
      if (Math.abs(d[0]) > 0.9) { hax = 0; hay = 1; haz = 0; }
      let t1x = d[1] * haz - d[2] * hay, t1y = d[2] * hax - d[0] * haz, t1z = d[0] * hay - d[1] * hax;
      const t1l = 1 / (Math.hypot(t1x, t1y, t1z) || 1); t1x *= t1l; t1y *= t1l; t1z *= t1l;
      const t2x = d[1] * t1z - d[2] * t1y, t2y = d[2] * t1x - d[0] * t1z, t2z = d[0] * t1y - d[1] * t1x;
      const d1 = normArr(d[0] + t1x * EPS, d[1] + t1y * EPS, d[2] + t1z * EPS);
      const rr1 = R + heightAt(d1[0], d1[1], d1[2]) * maxHeight;
      const d2 = normArr(d[0] + t2x * EPS, d[1] + t2y * EPS, d[2] + t2z * EPS);
      const rr2 = R + heightAt(d2[0], d2[1], d2[2]) * maxHeight;
      const ax = d1[0] * rr1 - pos[k3], ay = d1[1] * rr1 - pos[k3 + 1], az = d1[2] * rr1 - pos[k3 + 2];
      const bx = d2[0] * rr2 - pos[k3], by = d2[1] * rr2 - pos[k3 + 1], bz = d2[2] * rr2 - pos[k3 + 2];
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const nl = 1 / (Math.hypot(nx, ny, nz) || 1); nx *= nl; ny *= nl; nz *= nl;
      if (nx * d[0] + ny * d[1] + nz * d[2] < 0) { nx = -nx; ny = -ny; nz = -nz; }
      nor[k3] = nx; nor[k3 + 1] = ny; nor[k3 + 2] = nz;

      // 坡度混岩: slope = 1 - 法线·径向 (平坦≈0, 陡坡→大), 传给 colorFor 决定裸岩比例
      const slope = 1 - (nx * d[0] + ny * d[1] + nz * d[2]);
      const c = colorFor(h, d[0], d[1], d[2], slope);
      col[k3] = c[0]; col[k3 + 1] = c[1]; col[k3 + 2] = c[2];
    }
  }

  // 三条边的顶点索引(按各自参数顺序)
  const giAB = [], giAC = [], giBC = [];
  for (let i = 0; i <= N; i++) giAB.push(rowIndex(i, 0));       // A->B
  for (let j = 0; j <= N; j++) giAC.push(rowIndex(0, j));       // A->C
  for (let p = 0; p <= N; p++) giBC.push(rowIndex(N - p, p));   // B->C

  // 缝合(把多余顶点吸附到粗邻居的边线)
  snapEdge(giAB, strides[0], pos, nor, col, N);
  snapEdge(giAC, strides[1], pos, nor, col, N);
  snapEdge(giBC, strides[2], pos, nor, col, N);

  // 主三角形索引
  const indices = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N - i; j++) {
      indices.push(rowIndex(i, j), rowIndex(i + 1, j), rowIndex(i, j + 1));
      if (j < N - i - 1) indices.push(rowIndex(i + 1, j), rowIndex(i + 1, j + 1), rowIndex(i, j + 1));
    }
  }

  // 输出数组(主网格 + skirt 裙边; 缝合已消除稳态裂缝, 裙边仅作加载过渡的兜底)
  const outPos = [], outNor = [], outCol = [];
  for (let k = 0; k < mainCount * 3; k++) { outPos.push(pos[k]); outNor.push(nor[k]); outCol.push(col[k]); }

  // 裙边深度: 30% 边长 + 小常数, 上限 R*0.02。
  // 目的只是兜底 LOD 过渡瞬间的裂缝, 不需要深入行星内部(原 chord²*R*3 项 + R*0.4 上限
  // 在 R=500 时裙边深达 200 单位, 配合 DoubleSide 会在 limb 处看到裙边墙反面穿透)。
  const chord = dist3(A, B);
  const edgeWorld = chord * R;
  const skirtDepth = Math.min(edgeWorld * 0.3 + 0.3, R * 0.02);
  for (const eg of [giAB, giAC, giBC]) {
    const start = outPos.length / 3;
    for (let m = 0; m < eg.length; m++) {
      const gi3 = eg[m] * 3, d = dirs[eg[m]];
      outPos.push(pos[gi3] - d[0] * skirtDepth, pos[gi3 + 1] - d[1] * skirtDepth, pos[gi3 + 2] - d[2] * skirtDepth);
      outNor.push(nor[gi3], nor[gi3 + 1], nor[gi3 + 2]);
      outCol.push(col[gi3], col[gi3 + 1], col[gi3 + 2]);
    }
    for (let m = 0; m < eg.length - 1; m++) {
      const e0 = eg[m], e1 = eg[m + 1], s0 = start + m, s1 = start + m + 1;
      indices.push(e0, s0, e1, e1, s0, s1);
    }
  }

  const totalVerts = outPos.length / 3;
  const IndexArray = totalVerts > 65535 ? Uint32Array : Uint16Array;
  return {
    positions: Float32Array.from(outPos),
    normals: Float32Array.from(outNor),
    colors: Float32Array.from(outCol),
    indices: IndexArray.from(indices),
  };
}
