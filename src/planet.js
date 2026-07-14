// Planet: 正二十面体 + 三角形四叉树 LOD + fBm 噪声位移(three.js)
// 缝合版: 相邻层级的边通过 dyadic 顶点 + 按邻居层级抽稀吸附实现精确对接(无裂缝)。
// patch 网格在 Web Worker 异步生成; skirt 仅作加载过渡兜底。

import * as THREE from 'three';
import { buildPatchArrays } from './patchgeom.js';
import { makeTerrain } from './terrain.js';

// 地形参数字段(供快照传给 worker, 保证主线程/worker 一致)
const TERRAIN_KEYS = [
  'continentSeed', 'continentFreq', 'continentOctaves', 'continentGain', 'continentLacunarity',
  'mountainSeed', 'mountainFreq', 'mountainOctaves', 'mountainStrength', 'seaLevel',
  'warpSeed', 'warpStrength', 'warpFreq', 'plateSeed', 'plateFreq', 'plateStrength',
  'moistureSeed', 'moistureFreq', 'useClimate', 'climateAltRange',
  // 可调调色板(缺省时 terrain.js 用默认色)
  'colOceanShallow', 'colOceanDeep', 'colBeach', 'colDry', 'colWet',
  'colColdDry', 'colColdWet', 'colRock', 'colSnow',
  // 编辑列表(挖掘/抬升等运行时修改, terrain.heightAt 会叠加在噪声之上)
  'edits',
];

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

const _testSphere = new THREE.Sphere();   // 剔除测试用的临时包围球(避免每帧分配)
const _localCam = new THREE.Vector3();    // 相机在行星本地系的位置(支持行星不在原点)

// ============================================================================
// 共享 Worker 池: 所有 Planet 实例复用同一组 worker。
// 之前每颗行星各自 spawn/terminate 一批 worker(每个 worker 都要独立 import terrain.js +
// 从 CDN 拉 simplex-noise), 多行星场景下启动/切换极慢。改为进程级共享池后:
//   - worker 只在首次用到时创建一次, 全局固定数量;
//   - 新增/移除行星不再 spawn/terminate worker(消除卡顿与churn);
//   - 主项目(单行星)行为等同以前。
class WorkerPool {
  constructor(count) {
    this.count = count;
    this.workers = [];
    this.queue = [];            // 待派发 job
    this.jobs = new Map();      // id → job(队列中 + 运行中)
    this.nextId = 1;
    for (let i = 0; i < count; i++) {
      const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      w.busy = false;
      w.onmessage = (e) => this._onDone(w, e.data);
      this.workers.push(w);
    }
  }
  submit(job) {                 // job: { msg, onDispatch, onDone, cancelled, state }
    job.id = this.nextId++;
    job.msg.id = job.id;
    job.state = 'queued';
    this.jobs.set(job.id, job);
    this.queue.push(job);
    this._pump();
    return job.id;
  }
  _pump() {
    for (const w of this.workers) {
      while (!w.busy && this.queue.length > 0) {
        const job = this.queue.shift();
        if (job.cancelled) { this.jobs.delete(job.id); continue; }
        w.busy = true;
        job.state = 'inflight';
        if (job.onDispatch) job.onDispatch();
        w.postMessage(job.msg);
      }
    }
  }
  _onDone(w, data) {
    w.busy = false;
    const job = this.jobs.get(data.id);
    this.jobs.delete(data.id);
    if (job && job.onDone) job.onDone(data);
    this._pump();
  }
}

let _pool = null;
function getPool() {
  if (!_pool) {
    const n = Math.max(2, Math.min((navigator.hardwareConcurrency || 4) - 1, 8));
    _pool = new WorkerPool(n);
  }
  return _pool;
}

// ============================================================================
export class Planet extends THREE.Group {
  constructor(params) {
    super();
    this.params = params;
    this.stats = { patches: 0, triangles: 0, queued: 0, inflight: 0 };
    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.9, metalness: 0.0, side: THREE.FrontSide,
      polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    });
    this.wireMaterial = new THREE.LineBasicMaterial({ color: 0xffffff });
    this._wire = false;
    this._solidColor = 0x05070d;

    this._heightCb = (x, y, z) => this.heightAt(x, y, z);
    this._colorCb = (h, x, y, z) => this.colorFor(h, x, y, z);

    this._gen = 0;
    this._pool = getPool();     // 共享 worker 池
    this._queued = 0;           // 本行星在池队列中的 job 数(HUD)
    this._inflight = 0;         // 本行星正在 worker 上的 job 数(HUD)
    this._camPos = [1e9, 1e9, 1e9];
    this._camMoved = true;   // 相机移动时才重算缝合步长(静止时跳过, 省开销)
    this._remainingSplits = 0;  // 本帧剩余分裂预算(限制 worker 队列瞬时暴涨)
    this._meshArrived = false; // 自上次 selectLOD 后是否有新 mesh 回调(worker 异步完成时新 mesh.visible=wasVisible 可能是 false, 需再跑一次让 _renderLeaf 把可见性落到正确状态)
    this._editPending = false; // 自上次 selectLOD 后是否发生 edit(applyEdit 置 true), 强制下一次 update 把受影响 chunks 重生成
    if (!this.params.edits) this.params.edits = [];   // 运行时编辑列表(initial empty)

    this._buildNoise();
    this._buildRoots();
  }

  // 从 params 快照出地形相关字段(传给 worker + 构建主线程 terrain)
  _terrainParams() {
    const tp = {};
    for (const k of TERRAIN_KEYS) tp[k] = this.params[k];
    return tp;
  }

  _buildNoise() {
    this.terrain = makeTerrain(this._terrainParams());
  }

  // ---- 运行时挖掘/抬升(MVP) ----
  // localPos: 行星本地系坐标(planet.position == 0 时即世界坐标减 planet.position)
  // radius: 角半径(弧度, 球面上刷子范围)
  // depth: 0..1, 在 heightAt 中 ×maxHeight 才是实际高度
  // falloff: 'smooth' | 'linear' | 'sharp'
  applyEdit(localPos, radius, depth, falloff) {
    if (!this.params.edits) this.params.edits = [];
    const dir = localPos.clone().normalize();
    this.params.edits.push({
      pos: [dir.x, dir.y, dir.z],
      radius, depth, falloff: falloff || 'smooth',
    });
    // 主线程 terrain 也要刷新(_buildNoise 重建闭包, heightAt 才会读到新 edits)
    this._buildNoise();
    // 标记受影响 chunks 失效(_builtKey=null → 下次 _renderLeaf 触发 regen)
    for (const r of this.roots) this._invalidateAffected(r, dir, radius);
    // 强制下一次 update 跑 selectLOD + 让 _renderLeaf 进入 regen 分支
    this._editPending = true;
  }

  // 递归标记受 edit 影响的 chunks(角距离 < chunk 角半径 + edit 角半径 → 受影响)
  _invalidateAffected(node, editDir, editRadius) {
    const dot = editDir.x * node.centerDir.x + editDir.y * node.centerDir.y + editDir.z * node.centerDir.z;
    const angDist = Math.acos(Math.max(-1, Math.min(1, dot)));
    const chunkR = Math.acos(node.horizonCosAlpha);
    if (angDist < chunkR + editRadius + 0.005) {       // 0.005 弧度余量(~0.3°)
      if (node.pending) { node._cancelled = true; node.pending = false; this._cancelJob(node); }
      node._builtKey = null;
    }
    if (node.children) for (const c of node.children) this._invalidateAffected(c, editDir, editRadius);
  }

  heightAt(x, y, z) { return this.terrain.heightAt(x, y, z); }
  colorFor(h, x, y, z) { return this.terrain.colorFor(h, x, y, z); }

  displace(dir) {
    const h = this.heightAt(dir.x, dir.y, dir.z);
    return dir.clone().multiplyScalar(this.params.radius + h * this.params.maxHeight);
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

  // ---- Worker 请求调度(共享池; 带缝合参数 + 重生成) ----
  requestMesh(node, strides, key) {
    if (node.pending) return;
    if (node.mesh && node._builtKey === key) return;
    node.pending = true; node._cancelled = false; node._reqStrides = strides; node._reqKey = key;
    const p = this.params;
    const job = {
      msg: {
        gen: this._gen,
        A: [node.A.x, node.A.y, node.A.z], B: [node.B.x, node.B.y, node.B.z], C: [node.C.x, node.C.y, node.C.z],
        N: p.patchResolution, R: p.radius, maxHeight: p.maxHeight,
        strides: node._reqStrides,
        terrain: this._terrainParams(),
      },
      cancelled: false,
      onDispatch: () => { this._queued--; this._inflight++; },
      onDone: (data) => {         // 只有派发过(inflight)的 job 才会收到 onDone
        this._inflight--;
        node._job = null;
        if (!job.cancelled) this._onMesh(node, data);
      },
    };
    node._job = job;
    this._queued++;
    this._pool.submit(job);
  }

  // 取消某节点尚未完成的 job(dispose/rebuild 时)。队列中的立即扣计数; 运行中的等 onDone 扣。
  _cancelJob(node) {
    const job = node._job;
    if (!job || job.cancelled) return;
    job.cancelled = true;
    if (job.state === 'queued') this._queued--;   // 运行中: onDone 会扣 inflight
    node._job = null;
  }

  _onMesh(node, data) {
    if (!node._cancelled && data.gen === this._gen) {
      const newMesh = this._arraysToMesh(data);
      const wasVisible = node.mesh ? node.mesh.visible : false;
      if (node.mesh) this._disposeMesh(node.mesh);   // 重生成: 换掉旧网格
      newMesh.visible = wasVisible;
      node.mesh = newMesh;
      node._builtKey = node._reqKey;
      if (this._wire) this._ensureWire(newMesh);
      this._meshArrived = true;   // 新 mesh 可见性还没经 _renderLeaf 校正(可能 wasVisible=false) → 强制下次 update 跑 selectLOD
    }
    node.pending = false;
  }

  _count(node) {
    this.stats.patches++;
    this.stats.triangles += node.mesh.userData.triangles;
  }

  // camera: 用于计算视锥(剔除用); lodTarget: 可选, LOD 距离判断追踪这个点(角色模式下传 walker.position,
  // 让细分跟着角色而不是相机走 — 相机绕角色转时不会触发重新细分)。
  update(camera, lodTarget) {
    camera.updateMatrixWorld();
    // LOD 追踪点在行星本地系的位置(行星在原点时 this.position=0)
    const lodPos = lodTarget ? lodTarget : camera.position;
    const cp = _localCam.copy(lodPos).sub(this.position);
    this._camMoved = (Math.abs(cp.x - this._camPos[0]) + Math.abs(cp.y - this._camPos[1]) + Math.abs(cp.z - this._camPos[2])) > 1e-3;
    this._camPos[0] = cp.x; this._camPos[1] = cp.y; this._camPos[2] = cp.z;
    // 短路: 追踪点静止、无在途任务、无新到达 mesh、无 pending edit → 跳过整棵 selectLOD 遍历
    if (!this._camMoved && this._queued === 0 && this._inflight === 0 && !this._meshArrived && !this._editPending) {
      this.stats.queued = 0;
      this.stats.inflight = 0;
      return;
    }
    // _editPending 强制 _camMoved=true 一帧, 让 _renderLeaf 进入 regen 分支(_builtKey 已被置 null)
    if (this._editPending) { this._camMoved = true; this._editPending = false; }
    this._meshArrived = false;
    const m = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const frustum = new THREE.Frustum().setFromProjectionMatrix(m);
    this.stats.patches = 0; this.stats.triangles = 0;
    this._remainingSplits = this.params.splitBudget != null ? this.params.splitBudget : 16;
    for (const r of this.roots) r.selectLOD(cp, frustum, this);
    this.stats.queued = this._queued;
    this.stats.inflight = this._inflight;
  }

  rebuild() {
    this._gen++;
    for (const r of this.roots) r.dispose(this);   // 取消未完成 job(gen 变化后旧结果也会被丢弃)
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

    // 地平线剔除预算: chunk 在球面上的角半径(三个顶点到 centerDir 的最小 cos = 最大夹角)
    const minCos = Math.min(this.centerDir.dot(A), this.centerDir.dot(B), this.centerDir.dot(C));
    this.horizonCosAlpha = minCos;
    this.horizonSinAlpha = Math.sqrt(Math.max(0, 1 - minCos * minCos));
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
    const d = camPos.distanceTo(this.centerWorld);

    // 地平线剔除: 行星本体背面的 chunk 直接跳过(移植自 Godot quad.gd:_is_above_horizon)
    if (planet.params.horizonCulling && this._isBelowHorizon(camPos, planet)) {
      this._hideSubtree();
      return false;
    }
    // 近处(预细分球内)不受视锥限制, 始终按距离细分 —— 避免原地环视时背后需要现补细分。
    // 远处用带余量(margin)的视锥测试 —— 屏幕外预留一圈已细分好, 减少旋转时的 pop-in。
    if (d >= planet.params.nearRadius) {
      // frustum 在世界系, centerWorld 是本地系 → 加 planet.position 转世界(原点时不变)
      _testSphere.center.copy(this.centerWorld).add(planet.position);
      _testSphere.radius = this.bsphere.radius + d * planet.params.frustumMargin;
      if (!frustum.intersectsSphere(_testSphere)) { this._hideSubtree(); return true; }
    }

    // 滞回: 分裂/合并用不同阈值, 避免边界 churn(移植自 Godot planet.gd:_compute_lod_thresholds)
    const splitT = this.edgeLen * planet.params.splitFactor;
    const mergeH = planet.params.mergeHysteresis != null ? planet.params.mergeHysteresis : 1.15;
    const wantSplit = this.level < planet.params.maxLevel && d < splitT;
    const wantMerge = d > splitT * mergeH;

    if (wantSplit && !this.children) {
      // 分裂预算: 限制每帧新分裂数, 防止靠近时 worker 队列暴涨(移植自 Godot planet.gd:split_budget)
      if (planet._remainingSplits <= 0) {
        // 预算用完: 本帧退化为叶, 下帧再尝试
        return this._renderLeaf(planet);
      }
      planet._remainingSplits--;
      this._split(planet);
    } else if (wantMerge && this.children) {
      this._merge(planet);
    }
    // 既不应分裂也不应合并 → 维持现状(滞回区, 原 bug: 总是 fall through 到 merge 分支)

    if (this.children) return this._renderInterior(camPos, frustum, planet);
    return this._renderLeaf(planet);
  }

  // 渲染为叶节点(自身 mesh)
  _renderLeaf(planet) {
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

  // 渲染为内部节点(递归 4 子)
  _renderInterior(camPos, frustum, planet) {
    const cr = this.children[0].mesh && this.children[1].mesh && this.children[2].mesh && this.children[3].mesh;
    if (cr) {
      if (this.mesh) this.mesh.visible = false;
      for (const c of this.children) c.selectLOD(camPos, frustum, planet);
      return true;
    }
    // 子节点 mesh 不齐: 派发请求 + 自身兜底渲染
    for (const c of this.children) {
      if (!c.mesh && !c.pending) { const ds = c.computeStrides(planet); planet.requestMesh(c, ds, ds.join(',')); }
    }
    for (const c of this.children) c._hideSubtree();
    if (!this.mesh && !this.pending) planet.requestMesh(this, [1, 1, 1], '1,1,1');
    if (this.mesh) { this.mesh.visible = true; planet._count(this); return true; }
    return false;
  }

  // 地平线剔除: chunk 是否在行星本体背面被完全遮挡
  _isBelowHorizon(camPos, planet) {
    const R = planet.params.radius;
    const H = planet.params.maxHeight;
    const camDist = camPos.length();
    if (camDist <= R) return false;                       // 相机在行星内部 → 全可见
    const cosCamChunk = camPos.dot(this.centerDir) / camDist;
    if (cosCamChunk >= this.horizonCosAlpha) return false; // 相机在 chunk 角范围内 → 可见
    // 总地平线 = 相机地平线 + 地形抬升(cos(a+b) = cos(a)cos(b) - sin(a)sin(b))
    const cosCamHor = R / camDist;
    const sinCamHor = Math.sqrt(Math.max(0, 1 - cosCamHor * cosCamHor));
    const cosTer = R / (R + H);
    const sinTer = Math.sqrt(Math.max(0, 1 - cosTer * cosTer));
    const cosTotHor = cosCamHor * cosTer - sinCamHor * sinTer;
    // chunk 最近边(cos(a-b) = cos(a)cos(b) + sin(a)sin(b))
    const sinAng = Math.sqrt(Math.max(0, 1 - cosCamChunk * cosCamChunk));
    const cosNear = cosCamChunk * this.horizonCosAlpha + sinAng * this.horizonSinAlpha;
    return cosNear <= cosTotHor;
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
    if (this.pending) { this._cancelled = true; this.pending = false; planet._cancelJob(this); }
    if (this.children) { for (const c of this.children) c.dispose(planet); this.children = null; }
  }
}
