// Planet: 正二十面体 + 三角形四叉树 LOD + fBm 噪声位移(three.js)
// 优化版: patch 网格在 Web Worker 线程池异步生成; 加载未完成时显示父块兜底, 避免空洞。

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

// ============================================================================
export class Planet extends THREE.Group {
  constructor(params) {
    super();
    this.params = params;
    this.stats = { patches: 0, triangles: 0, queued: 0, inflight: 0 };
    // 实体表面材质。polygonOffset 只在线框模式开启(让线框浮在表面上), 平时关闭避免干扰。
    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.9, metalness: 0.0, side: THREE.DoubleSide,
      polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    });
    // 线框叠加材质(白线)
    this.wireMaterial = new THREE.LineBasicMaterial({ color: 0xffffff });
    this._wire = false;         // 当前是否线框模式
    this._solidColor = 0x05070d; // 线框模式下实体填成接近背景色, 只用来遮挡背面

    this._heightCb = (x, y, z) => this.heightAt(x, y, z);
    this._colorCb = (h) => this.colorFor(h);

    this._gen = 0;            // 重建代号(丢弃过期的 worker 结果)
    this._queue = [];         // 待生成节点
    this._pending = new Map();// id -> node
    this._nextId = 1;

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
    const V = raw.map((v) => new THREE.Vector3(v[0], v[1], v[2]).normalize());
    const faces = [
      [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
      [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
      [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
      [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
    ];
    this.roots = faces.map((f) => new QNode(this, V[f[0]], V[f[1]], V[f[2]], 0));
    // 根 patch 同步生成, 保证开局就有一颗完整(粗糙)的行星, 并作为兜底
    for (const r of this.roots) r.mesh = this._genMeshSync(r);
  }

  // ---- 网格创建 ----
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
    if (this._wire) this._ensureWire(m);
    return m;
  }

  // ---- 线框叠加 ----
  setWireframe(on) {
    this._wire = on;
    // 线框模式: 实体填成接近背景色(仍不透明, 用于写深度遮挡背面); 否则显示顶点色
    this.material.vertexColors = !on;
    this.material.color.setHex(on ? this._solidColor : 0xffffff);
    this.material.polygonOffset = on; // 只在线框模式推后实体, 让线框浮在表面上
    this.material.needsUpdate = true;
    for (const m of this.children) {
      if (!m.isMesh) continue;
      if (on) this._ensureWire(m);
      else this._removeWire(m);
    }
  }

  // 只取主网格的边(排除 skirt 裙边)构建线框
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

  _genMeshSync(node) {
    const p = this.params;
    const a = buildPatchArrays(
      [node.A.x, node.A.y, node.A.z], [node.B.x, node.B.y, node.B.z], [node.C.x, node.C.y, node.C.z],
      p.patchResolution, p.radius, p.maxHeight, p.seaLevel, this._heightCb, this._colorCb
    );
    return this._arraysToMesh(a);
  }

  // ---- Worker 请求调度 ----
  ensureMesh(node) {
    if (node.mesh || node.pending) return;
    node.pending = true;
    node._cancelled = false;
    this._queue.push(node);
    this._pump();
  }

  _pump() {
    for (const w of this.workers) {
      while (!w.busy && this._queue.length > 0) {
        const node = this._queue.shift();
        if (node._cancelled || node.mesh) { node.pending = false; continue; }
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
      node.mesh = this._arraysToMesh(data);
      node.pending = false;
    }
    this._pump();
  }

  _count(node) {
    this.stats.patches++;
    this.stats.triangles += node.mesh.userData.triangles;
  }

  // 每帧: LOD 遍历
  update(camera) {
    camera.updateMatrixWorld();
    const m = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const frustum = new THREE.Frustum().setFromProjectionMatrix(m);
    this.stats.patches = 0;
    this.stats.triangles = 0;
    for (const r of this.roots) r.selectLOD(camera.position, frustum, this);
    this.stats.queued = this._queue.length;
    let busy = 0;
    for (const w of this.workers) if (w.busy) busy++;
    this.stats.inflight = busy;
  }

  rebuild() {
    this._gen++;
    for (const r of this.roots) r.dispose(this);
    this._queue.length = 0;
    this.clear();
    this._buildNoise();
    this._buildRoots();
  }
}

// ============================================================================
// 四叉树节点(一个球面三角形 patch)
class QNode {
  constructor(planet, A, B, C, level) {
    this.A = A; this.B = B; this.C = C;
    this.level = level;
    this.children = null;
    this.mesh = null;
    this.pending = false;
    this._cancelled = false;
    this._id = 0;

    this.centerDir = A.clone().add(B).add(C).normalize();
    this.centerWorld = planet.displace(this.centerDir);
    const wa = planet.displace(A), wb = planet.displace(B), wc = planet.displace(C);
    this.edgeLen = wa.distanceTo(wb);
    const r = Math.max(this.centerWorld.distanceTo(wa), this.centerWorld.distanceTo(wb), this.centerWorld.distanceTo(wc));
    this.bsphere = new THREE.Sphere(this.centerWorld.clone(), r + planet.params.maxHeight * 2 + 1);
  }

  // 返回 true 表示本区域已有(可显示的)覆盖; false 表示需要祖先兜底显示
  selectLOD(camPos, frustum, planet) {
    if (!frustum.intersectsSphere(this.bsphere)) {
      this._hideSubtree();
      return true; // 屏幕外, 无需覆盖, 也不强制祖先变粗
    }
    planet.ensureMesh(this); // 请求自身网格(作为兜底)

    const dist = camPos.distanceTo(this.centerWorld);
    const wantSplit = this.level < planet.params.maxLevel && dist < this.edgeLen * planet.params.splitFactor;

    if (wantSplit) {
      if (!this.children) this._split(planet);
      const childrenReady = this.children[0].mesh && this.children[1].mesh && this.children[2].mesh && this.children[3].mesh;
      if (childrenReady) {
        if (this.mesh) this.mesh.visible = false;
        for (const c of this.children) c.selectLOD(camPos, frustum, planet);
        return true;
      } else {
        // 子块未就绪: 先请求它们, 本帧显示自身兜底
        for (const c of this.children) planet.ensureMesh(c);
        for (const c of this.children) c._hideSubtree();
        if (this.mesh) { this.mesh.visible = true; planet._count(this); return true; }
        return false;
      }
    } else {
      if (this.children) this._merge(planet); // 远离 → 合并回收
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
