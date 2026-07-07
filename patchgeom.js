// 纯几何构建(无 THREE 依赖), 主线程和 Web Worker 共用。
// 给定球面三角形三个角(单位向量)+分辨率, 生成 patch 的顶点/法线/颜色/索引。
// heightAt / colorFor 由调用方注入(主线程与 worker 各自持有一致的噪声实现)。
//
// 法线用"有限差分"直接对高度场求梯度: 反映真实地形斜率(含高频细节),
// 消除刻面感; 且只依赖顶点方向, 相邻 patch 在共享位置法线一致 → 无接缝。

function dist3(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

// A, B, C: [x,y,z] 单位向量。返回 { positions, normals, colors, indices } 均为 TypedArray。
export function buildPatchArrays(A, B, C, N, R, maxHeight, seaLevel, heightAt, colorFor) {
  const rowIndex = (i, j) => i * (N + 1) - (i * (i - 1)) / 2 + j;
  const mainCount = ((N + 1) * (N + 2)) / 2;

  const dirs = new Float32Array(mainCount * 3);
  const P = new Float32Array(mainCount * 3);
  const normM = new Float32Array(mainCount * 3);
  const colM = new Float32Array(mainCount * 3);

  const EPS = 1e-3; // 有限差分步长(单位球方向空间)

  // 计算某方向的抬升世界坐标。不再把海平面以下压平, 让海床也有起伏(半透明海洋下可见)。
  const surf = (x, y, z, out, o) => {
    const h = heightAt(x, y, z);
    const rr = R + h * maxHeight;
    out[o] = x * rr; out[o + 1] = y * rr; out[o + 2] = z * rr;
    return h;
  };

  const tmp1 = new Float32Array(3), tmp2 = new Float32Array(3);

  // 1) 主网格顶点 + 有限差分法线
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N - i; j++) {
      const w0 = (N - i - j) / N, w1 = i / N, w2 = j / N;
      let vx = A[0] * w0 + B[0] * w1 + C[0] * w2;
      let vy = A[1] * w0 + B[1] * w1 + C[1] * w2;
      let vz = A[2] * w0 + B[2] * w1 + C[2] * w2;
      const inv = 1 / Math.hypot(vx, vy, vz);
      vx *= inv; vy *= inv; vz *= inv;

      const k3 = rowIndex(i, j) * 3;
      dirs[k3] = vx; dirs[k3 + 1] = vy; dirs[k3 + 2] = vz;
      const h = surf(vx, vy, vz, P, k3);
      const c = colorFor(h);
      colM[k3] = c[0]; colM[k3 + 1] = c[1]; colM[k3 + 2] = c[2];

      // 切平面基: 选一个不与 dir 平行的辅助轴
      let hax = 1, hay = 0, haz = 0;
      if (Math.abs(vx) > 0.9) { hax = 0; hay = 1; haz = 0; }
      // t1 = normalize(cross(dir, helper))
      let t1x = vy * haz - vz * hay, t1y = vz * hax - vx * haz, t1z = vx * hay - vy * hax;
      const t1l = Math.hypot(t1x, t1y, t1z) || 1;
      t1x /= t1l; t1y /= t1l; t1z /= t1l;
      // t2 = cross(dir, t1)
      const t2x = vy * t1z - vz * t1y, t2y = vz * t1x - vx * t1z, t2z = vx * t1y - vy * t1x;

      // 沿 t1、t2 各取一个微偏移点(重新归一化到球面), 求抬升坐标
      let d1x = vx + t1x * EPS, d1y = vy + t1y * EPS, d1z = vz + t1z * EPS;
      let l1 = 1 / Math.hypot(d1x, d1y, d1z); d1x *= l1; d1y *= l1; d1z *= l1;
      surf(d1x, d1y, d1z, tmp1, 0);

      let d2x = vx + t2x * EPS, d2y = vy + t2y * EPS, d2z = vz + t2z * EPS;
      let l2 = 1 / Math.hypot(d2x, d2y, d2z); d2x *= l2; d2y *= l2; d2z *= l2;
      surf(d2x, d2y, d2z, tmp2, 0);

      // n = cross(p1 - P, p2 - P)
      const ax = tmp1[0] - P[k3], ay = tmp1[1] - P[k3 + 1], az = tmp1[2] - P[k3 + 2];
      const bx = tmp2[0] - P[k3], by = tmp2[1] - P[k3 + 1], bz = tmp2[2] - P[k3 + 2];
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      if (nx * vx + ny * vy + nz * vz < 0) { nx = -nx; ny = -ny; nz = -nz; } // 强制朝外
      normM[k3] = nx; normM[k3 + 1] = ny; normM[k3 + 2] = nz;
    }
  }

  // 2) 主三角形索引
  const indices = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N - i; j++) {
      indices.push(rowIndex(i, j), rowIndex(i + 1, j), rowIndex(i, j + 1));
      if (j < N - i - 1) indices.push(rowIndex(i + 1, j), rowIndex(i + 1, j + 1), rowIndex(i, j + 1));
    }
  }

  // 3) 组装为可增长数组(主网格 + skirt 裙边)
  const positions = [], normals = [], colors = [];
  for (let k = 0; k < mainCount * 3; k++) {
    positions.push(P[k]); normals.push(normM[k]); colors.push(colM[k]);
  }

  // 裙边深度与 patch 尺寸成正比: 近处高细分的小 patch 裙边很浅(几乎不可见),
  // 远处粗 patch 裙边深(且被地表挡住)。裂缝大小本身也随 patch 尺寸缩小, 所以正比即可覆盖。
  // 上限防止粗 patch 的裙边穿过球心。
  const chord = dist3(A, B);
  const edgeWorld = chord * R;
  const skirtDepth = Math.min(edgeWorld * 0.6 + chord * chord * R * 3 + 0.3, R * 0.4);
  const edges = [[], [], []];
  for (let i = 0; i <= N; i++) edges[0].push(rowIndex(i, 0));       // A-B
  for (let j = 0; j <= N; j++) edges[1].push(rowIndex(0, j));       // A-C
  for (let i = 0; i <= N; i++) edges[2].push(rowIndex(i, N - i));   // B-C

  for (const edge of edges) {
    const start = positions.length / 3;
    for (let m = 0; m < edge.length; m++) {
      const k3 = edge[m] * 3;
      positions.push(
        P[k3] - dirs[k3] * skirtDepth,
        P[k3 + 1] - dirs[k3 + 1] * skirtDepth,
        P[k3 + 2] - dirs[k3 + 2] * skirtDepth
      );
      normals.push(normM[k3], normM[k3 + 1], normM[k3 + 2]);
      colors.push(colM[k3], colM[k3 + 1], colM[k3 + 2]);
    }
    for (let m = 0; m < edge.length - 1; m++) {
      const e0 = edge[m], e1 = edge[m + 1], s0 = start + m, s1 = start + m + 1;
      indices.push(e0, s0, e1, e1, s0, s1);
    }
  }

  const totalVerts = positions.length / 3;
  const IndexArray = totalVerts > 65535 ? Uint32Array : Uint16Array;
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    colors: Float32Array.from(colors),
    indices: IndexArray.from(indices),
  };
}
