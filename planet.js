// Planet: 正二十面体 + 三角形四叉树 LOD + fBm 噪声位移(three.js)
// 缝合版: 相邻层级的边通过 dyadic 顶点 + 按邻居层级抽稀吸附实现精确对接(无裂缝)。
// patch 网格在 Web Worker 异步生成; skirt 仅作加载过渡兜底。

import * as THREE from 'three';
import { createNoise3D } from 'simplex-noise';
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

// ---- 小型数组向量工具(供邻居层级查询用, 避免大量 Vector3 分配) ----
function vnorm(x, y, z) { const l = 1 / Math.hypot(x, y, z); return [x * l, y * l, z * l]; }
function vmid(a, b) { return vnorm(a[0] + b[0], a[1] + b[1], a[2] + b[2]); }
function vdot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function vcross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function vdist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
// 球面点在三角形内(含边界容差)
function pointInTri(p, a, b, c) {
  const nAB = vcross(a, b); if (vdot(p, nAB) * vdot(c, nAB) < -1e-7) return false;
  const nBC = vcross(b, c); if (vdot(p, nBC) * vdot(a, nBC) < -1e-7) return false;
  const nCA = vcross(c, a); if (vdot(p, nCA) * vdot(b, nCA) < -1e-7) return false;
  return true;
}

// ============================================================================
export class Planet extends THREE.Group {
  constructor(params) {
    super();
    this.params = params;
    this.stats = { patches: 0, triangles: 0, queued: 0, inflight: 0 };
    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide,
      polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    });
    this.wireMaterial = new THREE.LineBasicMaterial({ color: 0xffffff });
    this._wire = false;
    this._solidColor = 0x05070d;

    this._heightCb = (x, y, z) => this.heightAt(x, y, z);
    this._colorCb = (h) => this.colorFor(h);

    this._gen = 0;
    this._queue = [];
    this._pending = new Map();
    this._nextId = 1;
    this._camPos = [1e9, 1e9, 1e9];
    this._camMoved = true;   // 相机移动时才重算缝合步长(静止时跳过, 省开销)

    this._initWorkers();
    this._buildNoise();
    this._buildRoots();
  }

  _initWorkers() {
    const count = Math.max(2, Math.min((navigator.hardwareConcurrency || 4) - 1, 8));
    this.workers = [];
    for (let i = 0; i < count; i++) {
      const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      w.busy = false;
      w.onmessage = (e) => this._onWorkerDone(w, e.data);
      this.workers.push(w);
    }
  }

  _buildNoise() {
    this.noiseC = createNoise3D(mulberry32(this.params.continentSeed));
    this.noiseM = createNoise3D(mulberry32(this.params.mountainSeed));
  }

  heightAt(x, y, z) {
    const p = this.params;
    const c = fbm(this.noiseC, x, y, z, p.continentOctaves, p.continentFreq, p.continentGain, p.continentLacunarity);
    const m = ridged(this.noiseM, x, y, z, p.mountainOctaves, p.mountainFreq, 0.5, 2.0);
    const mask = Math.min(1, Math.max(0, c));
    return c + m * p.mountainStrength * mask;
  }

  displace(dir) {
    const h = this.heightAt(dir.x, dir.y, dir.z);
    return dir.clone().multiplyScalar(this.params.radius + h * this.params.maxHeight);
  }

  colorFor(h) {
    if (h < this.params.seaLevel) return [0.05, 0.2, 0.5];
    const t = Math.min(1, Math.max(0, h));
    if (t < 0.05) return [0.85, 0.8, 0.55];
    if (t < 0.4) return [0.2, 0.5, 0.15];
    if (t < 0.7) return [0.4, 0.3, 0.2];
    return [0.95, 0.95, 0.98];
  }

  _buildRoots() {
    const t = (1 + Math.sqrt(5)) / 2;
    const raw = [
      [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
      [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
      [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
    ];
    this._V = raw.map((v) => vnorm(v[0], v[1], v[2]));           // 数组形式(邻居查询用)
    this._faces = [
      [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
      [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
      [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
      [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
    ];
    const V3 = this._V.map((v) => new THREE.Vector3(v[0], v[1], v[2]));
    this.roots = this._faces.map((f) => new QNode(this, V3[f[0]], V3[f[1]], V3[f[2]], 0));
    for (const r of this.roots) {                               // 根同步生成(stride 全1)
      r.mesh = this._genMeshSync(r);
      r._builtKey = '1,1,1';
    }
  }

  // ---- 邻居目标层级查询(纯几何, 与四叉树分裂规则一致) ----
  _rootContaining(p) {
    for (const f of this._faces) {
      const a = this._V[f[0]], b = this._V[f[1]], c = this._V[f[2]];
      if (pointInTri(p, a, b, c)) return [a, b, c];
    }
    const f0 = this._faces[0];
    return [this._V[f0[0]], this._V[f0[1]], this._V[f0[2]]];
  }

  targetLevelAt(p) {
    const R = this.params.radius, sf = this.params.splitFactor, maxL = this.params.maxLevel;
    const cam = this._camPos;
    let tri = this._rootContaining(p);
    let A = tri[0], B = tri[1], C = tri[2], level = 0;
    while (level < maxL) {
      const cl = 1 / Math.hypot(A[0] + B[0] + C[0], A[1] + B[1] + C[1], A[2] + B[2] + C[2]);
      const cwx = (A[0] + B[0] + C[0]) * cl * R, cwy = (A[1] + B[1] + C[1]) * cl * R, cwz = (A[2] + B[2] + C[2]) * cl * R;
      const edgeLen = vdist(A, B) * R;
      const dcam = Math.hypot(cam[0] - cwx, cam[1] - cwy, cam[2] - cwz);
      if (dcam < edgeLen * sf) {
        const ab = vmid(A, B), bc = vmid(B, C), ca = vmid(C, A);
        const ch = [[A, ab, ca], [ab, B, bc], [ca, bc, C], [ab, bc, ca]];
        let nxt = ch[3];
        for (const t of ch) { if (pointInTri(p, t[0], t[1], t[2])) { nxt = t; break; } }
        A = nxt[0]; B = nxt[1]; C = nxt[2]; level++;
      } else break;
    }
    return level;
  }

  // ---- 网格 ----
  _arraysToMesh(a) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(a.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(a.normals, 3));
    g.setAttribute('color', new THREE.BufferAttribute(a.colors, 3));
    g.setIndex(new THREE.BufferAttribute(a.indices, 1));
    const m = new THREE.Mesh(g, this.material);
    m.frustumCulled = false;
    m.visible = false;
    m.userData.triangles = a.indices.length / 3;
    this.add(m);
    return m;
  }

  _genMeshSync(node) {
    const p = this.params;
    const a = buildPatchArrays(
      [node.A.x, node.A.y, node.A.z], [node.B.x, node.B.y, node.B.z], [node.C.x, node.C.y, node.C.z],
      p.patchResolution, p.radius, p.maxHeight, p.seaLevel, this._heightCb, this._colorCb, [1, 1, 1]
    );
    return this._arraysToMesh(a);
  }

  // ---- Worker 请求调度(带缝合参数 + 重生成) ----
  requestMesh(node, strides, key) {
    if (node.pending) return;
    if (node.mesh && node._builtKey === key) return;
    node.pending = true; node._cancelled = false; node._reqStrides = strides; node._reqKey = key;
    this._queue.push(node);
    this._pump();
  }

  _pump() {
    for (const w of this.workers) {
      while (!w.busy && this._queue.length > 0) {
        const node = this._queue.shift();
        if (node._cancelled || (node.mesh && node._builtKey === node._reqKey)) { node.pending = false; continue; }
        this._dispatch(w, node);
      }
    }
  }

  _dispatch(w, node) {
    const id = this._nextId++;
    node._id = id;
    this._pending.set(id, node);
    w.busy = true;
    const p = this.params;
    w.postMessage({
      id, gen: this._gen,
      A: [node.A.x, node.A.y, node.A.z], B: [node.B.x, node.B.y, node.B.z], C: [node.C.x, node.C.y, node.C.z],
      N: p.patchResolution, R: p.radius, maxHeight: p.maxHeight, seaLevel: p.seaLevel,
      strides: node._reqStrides,
      continentSeed: p.continentSeed, continentFreq: p.continentFreq, continentOctaves: p.continentOctaves,
      continentGain: p.continentGain, continentLacunarity: p.continentLacunarity,
      mountainSeed: p.mountainSeed, mountainFreq: p.mountainFreq, mountainOctaves: p.mountainOctaves,
      mountainStrength: p.mountainStrength,
    });
  }

  _onWorkerDone(w, data) {
    w.busy = false;
    const node = this._pending.get(data.id);
    this._pending.delete(data.id);
    if (node && !node._cancelled && data.gen === this._gen) {
      const newMesh = this._arraysToMesh(data);
      const wasVisible = node.mesh ? node.mesh.visible : false;
      if (node.mesh) this._disposeMesh(node.mesh);   // 重生成: 换掉旧网格
      newMesh.visible = wasVisible;
      node.mesh = newMesh;
      node._builtKey = node._reqKey;
      node.pending = false;
      if (this._wire) this._ensureWire(newMesh);
    }
    this._pump();
  }

  _count(node) {
    this.stats.patches++;
    this.stats.triangles += node.mesh.userData.triangles;
  }

  update(camera) {
    camera.updateMatrixWorld();
    const cp = camera.position;
    this._camMoved = (Math.abs(cp.x - this._camPos[0]) + Math.abs(cp.y - this._camPos[1]) + Math.abs(cp.z - this._camPos[2])) > 1e-3;
    this._camPos[0] = cp.x; this._camPos[1] = cp.y; this._camPos[2] = cp.z;
    const m = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const frustum = new THREE.Frustum().setFromProjectionMatrix(m);
    this.stats.patches = 0; this.stats.triangles = 0;
    for (const r of this.roots) r.selectLOD(camera.position, frustum, this);
    this.stats.queued = this._queue.length;
    let busy = 0; for (const w of this.workers) if (w.busy) busy++;
    this.stats.inflight = busy;
  }

  rebuild() {
    this._gen++;
    for (const r of this.roots) r.dispose(this);
    this._queue.length = 0;
    this.clear();
    this._camMoved = true;
    this._buildNoise();
    this._buildRoots();
    if (this._wire) this.setWireframe(true);
  }

  // ---- 线框叠加 ----
  setWireframe(on) {
    this._wire = on;
    this.material.vertexColors = !on;
    this.material.color.setHex(on ? this._solidColor : 0xffffff);
    this.material.polygonOffset = on;
    this.material.needsUpdate = true;
    for (const m of this.children) {
      if (!m.isMesh) continue;
      if (on) this._ensureWire(m); else this._removeWire(m);
    }
  }

  _ensureWire(mesh) {
    if (mesh.userData.wire) { mesh.userData.wire.visible = true; return; }
    const N = this.params.patchResolution;
    const mainCount = ((N + 1) * (N + 2)) / 2;
    const mainTri = N * N;
    const pos = mesh.geometry.getAttribute('position').array;
    const idx = mesh.geometry.index.array;
    const g2 = new THREE.BufferGeometry();
    g2.setAttribute('position', new THREE.BufferAttribute(pos.slice(0, mainCount * 3), 3));
    g2.setIndex(new THREE.BufferAttribute(idx.slice(0, mainTri * 3), 1));
    const wg = new THREE.WireframeGeometry(g2);
    g2.dispose();
    const wire = new THREE.LineSegments(wg, this.wireMaterial);
    wire.frustumCulled = false;
    mesh.add(wire);
    mesh.userData.wire = wire;
  }

  _removeWire(mesh) {
    const w = mesh.userData.wire;
    if (w) { mesh.remove(w); w.geometry.dispose(); mesh.userData.wire = null; }
  }

  _disposeMesh(m) {
    if (m.userData.wire) m.userData.wire.geometry.dispose();
    this.remove(m);
    m.geometry.dispose();
  }
}

// ============================================================================
class QNode {
  constructor(planet, A, B, C, level) {
    this.A = A; this.B = B; this.C = C;
    this.level = level;
    this.children = null;
    this.mesh = null;
    this.pending = false;
    this._cancelled = false;
    this._id = 0;
    this._builtKey = null;

    const R = planet.params.radius;
    this.centerDir = A.clone().add(B).add(C).normalize();
    this.centerWorld = this.centerDir.clone().multiplyScalar(R);   // 高度无关(与 targetLevelAt 一致)
    this.edgeLen = A.distanceTo(B) * R;

    // 包围球: 单位球角点*R 的范围 + 地形高度 + 裙边
    const wa = A.clone().multiplyScalar(R), wb = B.clone().multiplyScalar(R), wc = C.clone().multiplyScalar(R);
    const spread = Math.max(this.centerWorld.distanceTo(wa), this.centerWorld.distanceTo(wb), this.centerWorld.distanceTo(wc));
    const chord = A.distanceTo(B);
    const skirt = Math.min(chord * R * 0.6 + chord * chord * R * 3, R * 0.4);
    this.bsphere = new THREE.Sphere(this.centerWorld.clone(), spread + planet.params.maxHeight * 2 + skirt + 1);
  }

  // 计算三条边(AB, AC, BC)的缝合步长
  computeStrides(planet) {
    if (this.level === 0) return [1, 1, 1];
    const A = [this.A.x, this.A.y, this.A.z], B = [this.B.x, this.B.y, this.B.z], C = [this.C.x, this.C.y, this.C.z];
    const center = [this.centerDir.x, this.centerDir.y, this.centerDir.z];
    const N = planet.params.patchResolution;
    const edges = [[A, B], [A, C], [B, C]];
    const out = [1, 1, 1];
    for (let e = 0; e < 3; e++) {
      const P = edges[e][0], Q = edges[e][1];
      const mid = vnorm(P[0] + Q[0], P[1] + Q[1], P[2] + Q[2]);
      const sample = vnorm(
        mid[0] + (mid[0] - center[0]) * 0.35,
        mid[1] + (mid[1] - center[1]) * 0.35,
        mid[2] + (mid[2] - center[2]) * 0.35
      );
      const nb = planet.targetLevelAt(sample);
      if (nb < this.level) {
        let s = 1 << (this.level - nb);
        if (s > N) s = N;
        out[e] = s;
      }
    }
    return out;
  }

  selectLOD(camPos, frustum, planet) {
    if (!frustum.intersectsSphere(this.bsphere)) { this._hideSubtree(); return true; }
    const dist = camPos.distanceTo(this.centerWorld);
    const wantSplit = this.level < planet.params.maxLevel && dist < this.edgeLen * planet.params.splitFactor;

    if (wantSplit) {
      if (!this.children) this._split(planet);
      const cr = this.children[0].mesh && this.children[1].mesh && this.children[2].mesh && this.children[3].mesh;
      if (cr) {
        if (this.mesh) this.mesh.visible = false;
        for (const c of this.children) c.selectLOD(camPos, frustum, planet);
        return true;
      } else {
        for (const c of this.children) {
          if (!c.mesh && !c.pending) { const ds = c.computeStrides(planet); planet.requestMesh(c, ds, ds.join(',')); }
        }
        for (const c of this.children) c._hideSubtree();
        if (!this.mesh && !this.pending) planet.requestMesh(this, [1, 1, 1], '1,1,1');
        if (this.mesh) { this.mesh.visible = true; planet._count(this); return true; }
        return false;
      }
    } else {
      if (this.children) this._merge(planet);
      if (!this.mesh) {
        if (!this.pending) { const ds = this.computeStrides(planet); planet.requestMesh(this, ds, ds.join(',')); }
      } else if (planet._camMoved && !this.pending) {
        const ds = this.computeStrides(planet);
        const key = ds.join(',');
        if (this._builtKey !== key) planet.requestMesh(this, ds, key);
      }
      if (this.mesh) { this.mesh.visible = true; planet._count(this); return true; }
      return false;
    }
  }

  _hideSubtree() {
    if (this.mesh) this.mesh.visible = false;
    if (this.children) for (const c of this.children) c._hideSubtree();
  }

  _split(planet) {
    const ab = this.A.clone().add(this.B).normalize();
    const bc = this.B.clone().add(this.C).normalize();
    const ca = this.C.clone().add(this.A).normalize();
    const L = this.level + 1;
    this.children = [
      new QNode(planet, this.A, ab, ca, L),
      new QNode(planet, ab, this.B, bc, L),
      new QNode(planet, ca, bc, this.C, L),
      new QNode(planet, ab, bc, ca, L),
    ];
  }

  _merge(planet) {
    for (const c of this.children) c.dispose(planet);
    this.children = null;
  }

  dispose(planet) {
    if (this.mesh) { planet._disposeMesh(this.mesh); this.mesh = null; }
    if (this.pending) { this._cancelled = true; this.pending = false; }
    if (this.children) { for (const c of this.children) c.dispose(planet); this.children = null; }
  }
}
