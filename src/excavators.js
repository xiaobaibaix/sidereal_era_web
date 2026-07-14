// 自动施工系统: 挖机(挖掘) + 卡车(运输), 两种角色协作。
//
// 角色分工:
//   挖机(Excavator): 驻扎挖掘区, 空闲时挑一台开到它旁边等待的卡车来装车; 装车时才挖地形
//                    (挖掘区 edit 深度渐增 → 地面下沉成坑), 把土直接装进那台卡车。没车来时
//                    在区内小范围换点推进作业面; 挖到目标深度即停。
//   卡车(Truck):     开到指派挖机旁排队 → 被装满 → 开到填埋区卸土(地面抬升) → 回来找挖机,
//                    循环直到挖掘区挖到目标深度、且自己空车。
//
// 与地形耦合复用 planet.params.edits 管线, 有界 + 守恒:
//   - 只放 2 条受管理 edit: 挖掘区(depth 增大→下沉) 与 填埋区(depth 变负→抬升)。
//   - 挖出总量 = 卡车在途 + 已填(按球冠面积比换算), 体积守恒(挖=装, 一勺不落地)。
//   - mesh 重建(_buildNoise + invalidate)节流(每 ~0.12s 一次), 避免上千次改动打爆 worker。
//
// 渲染: 挖机与卡车各用一个 InstancedMesh(几百个也很便宜), per-instance 颜色表示状态。

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// 挖机状态
const EX = { TO_DIG: 0, IDLE: 1, LOADING: 2, DONE: 3 };
// 卡车状态
const TR = { TO_EXCA: 0, WAITING: 1, LOADING: 2, TO_DUMP: 3, DUMPING: 4, DONE: 5 };

const EX_COLOR = {
  [EX.TO_DIG]: new THREE.Color(0xffd24a),   // 开往挖点: 黄
  [EX.IDLE]: new THREE.Color(0xf0c000),     // 就位待命(等卡车): 深黄
  [EX.LOADING]: new THREE.Color(0xff7a2d),  // 挖掘装车中: 橙
  [EX.DONE]: new THREE.Color(0x59636f),     // 完工: 暗灰
};
const TR_COLOR = {
  [TR.TO_EXCA]: new THREE.Color(0xffe27a),  // 空车开往挖机: 浅黄
  [TR.WAITING]: new THREE.Color(0xffcf5a),  // 在挖机旁排队等装: 黄
  [TR.LOADING]: new THREE.Color(0xffb74a),  // 装载中: 橙黄
  [TR.TO_DUMP]: new THREE.Color(0x9c6b3f),  // 满载去卸: 棕
  [TR.DUMPING]: new THREE.Color(0x6fcf6f),  // 卸土中: 绿
  [TR.DONE]: new THREE.Color(0x59636f),     // 完工: 暗灰
};

const MAX_INSTANCES = 512;

// 基础速率(depth 单位/秒, 会乘以 rate 倍率)
const BASE_LOAD = 0.016;   // 挖机装车(=挖掘)速率: 装满一车约需 TRUCK_CAP/BASE_LOAD 秒
const BASE_DUMP = 0.03;    // 卡车卸载速率
const TRUCK_CAP = 0.02;    // 单车运力(depth 单位)
const LOAD_DIST = 0.05;    // 卡车距挖机多近才算"到位"可被装车(弧度)
const DIG_SPOT_TIME = 3.2; // 挖机没车来时, 在一个挖点待多久后换点(秒)
const DIG_SPOT_JITTER = 1.4; // 换点间隔随机抖动(±秒, 避免所有挖机同步换点)

// ---- 球面小工具 ----
function perpAxis(n, out) {
  if (Math.abs(n.y) < 0.99) out.set(0, 1, 0); else out.set(1, 0, 0);
  return out.crossVectors(out, n).normalize();
}

function buildFrom(boxes) {
  // boxes: [ [w,h,d, x,y,z, rx?] ... ]  底面尽量贴 y=0
  const parts = boxes.map(([w, h, d, x, y, z, rx]) => {
    const g = new THREE.BoxGeometry(w, h, d);
    if (rx) g.rotateX(rx);
    g.translate(x, y, z);
    return g;
  });
  const geo = mergeGeometries(parts, false);
  geo.computeVertexNormals();
  return geo;
}
// 挖机: 底盘 + 车身 + 驾驶室 + 挖臂 + 铲斗(朝 +Z)
function buildExcavatorGeometry() {
  return buildFrom([
    [2.6, 0.5, 3.4, 0, 0.25, 0],
    [2.0, 0.8, 2.4, 0, 0.9, -0.2],
    [1.3, 0.9, 1.1, 0, 1.7, -0.7],
    [0.35, 0.35, 2.2, 0, 1.15, 1.35, -0.35],
    [1.0, 0.6, 0.7, 0, 0.55, 2.5],
  ]);
}
// 指示标记: 一个尖朝下的圆锥(悬在机器头顶指着它)。单位尺寸, 渲染时按距离缩放。
function buildMarkerGeometry() {
  const g = new THREE.ConeGeometry(0.5, 1.3, 6);
  g.rotateX(Math.PI);              // 尖端朝 -Y(向下)
  g.translate(0, 1.3 / 2 + 0.1, 0); // 尖端落在原点略上方, 锥体在上
  return g;
}
// 卡车: 长底盘 + 驾驶室(前) + 货斗(后, 带矮侧壁)
function buildTruckGeometry() {
  return buildFrom([
    [2.4, 0.5, 4.6, 0, 0.25, 0],       // 底盘
    [2.0, 1.1, 1.4, 0, 1.05, 1.5],     // 驾驶室(前 +Z)
    [2.2, 0.3, 2.6, 0, 0.75, -0.8],    // 货斗底
    [2.2, 0.6, 0.2, 0, 1.0, -2.0],     // 货斗后壁
    [0.2, 0.6, 2.6, 1.0, 1.0, -0.8],   // 货斗左壁
    [0.2, 0.6, 2.6, -1.0, 1.0, -0.8],  // 货斗右壁
  ]);
}

export class ExcavatorSystem {
  constructor(planet, scene) {
    this.planet = planet;
    this.scene = scene;
    this.running = false;
    this.onChange = null;   // 地形离散变更(设区/暂停/清除)时回调, 供外部统一持久化到 localStorage

    // 可调
    this.surfaceSpeed = 20;
    this.rate = 1.0;
    this.size = 1.0;
    this.showMarkers = true;   // 头顶指示箭头(帮忙定位机器)
    this._cam = null;          // 当前渲染相机(update 时传入, 用于标记按距离缩放)

    // 区域(受管理 edit)
    this.digZone = null;   // { dir, radius, target, edit }
    this.fillZone = null;  // { dir, radius, edit }
    this._ownedEdits = []; // 本系统产生的全部 edit(含已"烘焙"为永久的旧区域), 供"恢复地形"一次清除

    // 机器
    this.excavators = [];  // { dir, fwd, state, target, phase, digTimer, spotTime, serving, _q }
    this.trucks = [];      // { dir, fwd, state, cargo, target, assigned }

    // 提交节流
    this._dirty = false; this._commitTimer = 0; this._commitEvery = 0.12;
    this._time = 0;

    // 复用向量
    this._v = new THREE.Vector3(); this._axis = new THREE.Vector3();
    this._t1 = new THREE.Vector3(); this._t2 = new THREE.Vector3();
    this._pos = new THREE.Vector3(); this._xA = new THREE.Vector3();
    this._sv = new THREE.Vector3(); this._m = new THREE.Matrix4();

    // 两个 InstancedMesh(机器本体)
    this.excaMesh = this._makeInstanced(buildExcavatorGeometry());
    this.truckMesh = this._makeInstanced(buildTruckGeometry());
    scene.add(this.excaMesh, this.truckMesh);

    // 头顶指示标记(尖朝下的箭头, 单色不受光, 始终可见): 挖机=橙, 卡车=青
    const markerGeo = buildMarkerGeometry();
    this.excaMarker = this._makeMarkerMesh(markerGeo, 0xffa030);
    this.truckMarker = this._makeMarkerMesh(markerGeo, 0x35d0ff);
    scene.add(this.excaMarker, this.truckMarker);

    // 区域环
    this.digRing = this._makeRing(0xff4d4d);
    this.fillRing = this._makeRing(0x4fd873);
    scene.add(this.digRing, this.fillRing);
  }

  _makeInstanced(geo) {
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0.1 });
    const mesh = new THREE.InstancedMesh(geo, mat, MAX_INSTANCES);
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const white = new THREE.Color(0xffffff);
    for (let i = 0; i < MAX_INSTANCES; i++) mesh.setColorAt(i, white);
    mesh.instanceColor.needsUpdate = true;
    return mesh;
  }
  // 标记用: 单色不受光的 InstancedMesh(不需要 per-instance 颜色)
  _makeMarkerMesh(geo, color) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 });
    const mesh = new THREE.InstancedMesh(geo, mat, MAX_INSTANCES);
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.renderOrder = 997;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    return mesh;
  }

  setPlanet(planet) { this.planet = planet; }
  // 换绑到另一颗行星(太阳系换聚焦星时用): 清掉机器/区域/环, 但旧行星地形编辑保持不动; 切换 planet 引用
  rebind(planet) {
    this.clearAgents();
    this.digZone = null; this.fillZone = null;
    this.digRing.visible = false; this.fillRing.visible = false;
    this.running = false;
    this.planet = planet;
  }

  // ---- 地形高度 / 表面坐标 ----
  _groundR(dir) {
    const p = this.planet.params;
    return p.radius + this.planet.heightAt(dir.x, dir.y, dir.z) * p.maxHeight;
  }
  _groundPos(dir, out) { return out.copy(dir).multiplyScalar(this._groundR(dir)).add(this.planet.position); }

  // ---- 区域 edit 管理 ----
  _pushEdit(edit) { this.planet.params.edits.push(edit); this._ownedEdits.push(edit); return edit; }
  // 从 params.edits + _ownedEdits 彻底移除某条 edit
  _discardEdit(edit) {
    let i = this.planet.params.edits.indexOf(edit);
    if (i !== -1) this.planet.params.edits.splice(i, 1);
    i = this._ownedEdits.indexOf(edit);
    if (i !== -1) this._ownedEdits.splice(i, 1);
  }
  // 该 edit 是否已产生地形改变(整平看 progress, 减量看 depth)
  _editChanged(edit) {
    if (!edit) return false;
    return edit.type === 'level' ? (edit.progress > 1e-4) : (Math.abs(edit.depth) > 1e-6);
  }
  // "释放"旧区域: 已产生地形的 edit 保留(烘焙为永久, 仍在 _ownedEdits 里以便日后清除);
  // 没动过的空 edit 直接丢弃, 避免泄漏。
  _releaseZone(zone) {
    if (zone && zone.edit && !this._editChanged(zone.edit)) this._discardEdit(zone.edit);
  }

  _fireChange() { if (this.onChange) this.onChange(); }

  // digDepth: 相对当前地表往下挖的深度(0..1, ×maxHeight)。挖掘区最终被整平成一块位于
  // level = 原地表 h - digDepth 的平地(圆内高于 level 的都削平到 level)。
  setDigZone(dir, radius, digDepth) {
    const d = dir.clone().normalize();
    this._releaseZone(this.digZone);          // 旧坑: 已挖的保留, 空的丢弃
    const h0 = this.planet.heightAt(d.x, d.y, d.z);   // 挖前当前地表 h(含已烘焙的旧编辑)
    const level = h0 - digDepth;              // 目标平面 h
    const total = Math.max(1e-4, digDepth);   // 待挖"深度当量"(定进度/配土方)
    const sea = this.planet.params.seaLevel || 0;
    // dry: 在陆地(原地表高于海平面)上开挖 → 供海洋"干区"遮罩用, 坑挖到海平面下也不露海水
    const edit = { type: 'level', pos: [d.x, d.y, d.z], radius, level, progress: 0, falloff: 'smooth', dry: h0 > sea };
    this.digZone = { dir: d, radius, level, total, removed: 0, edit };
    this._pushEdit(edit);
    this._updateRing(this.digRing, d, radius);
    this._retaskExcavators();                 // 已有挖机重新领新挖点并开过去
    this._commit();                           // 只失效新区; 旧区 edit 未改动, 地形保持
    this._fireChange();
  }
  setFillZone(dir, radius) {
    const d = dir.clone().normalize();
    this._releaseZone(this.fillZone);
    const edit = { pos: [d.x, d.y, d.z], radius, depth: 0, falloff: 'smooth' };  // 抬升: depth 变负
    this.fillZone = { dir: d, radius, edit };
    this._pushEdit(edit);
    this._updateRing(this.fillRing, d, radius);
    this._commit();
    this._fireChange();
  }
  // 给挖机分配挖掘区内的挖点并置为"开往"状态(从当前位置开过去, 不瞬移); 卡车重新找挖机
  _retaskExcavators() {
    if (!this.digZone) return;
    for (const e of this.excavators) {
      this._randInCap(this.digZone.dir, this.digZone.radius * 0.6, e.target);
      e.state = EX.TO_DIG; e.serving = null;
    }
    for (const t of this.trucks) {
      if (t.state === TR.TO_EXCA || t.state === TR.WAITING || t.state === TR.LOADING) { t.state = TR.TO_EXCA; t.assigned = null; }
    }
  }
  hasZones() { return !!(this.digZone && this.fillZone); }

  progress() {
    if (!this.digZone) return 0;
    return Math.min(1, this.digZone.removed / Math.max(1e-6, this.digZone.total));
  }
  digRemaining() {
    if (!this.digZone) return 0;
    return Math.max(0, this.digZone.total - this.digZone.removed);
  }
  _fillK() {
    if (!this.digZone || !this.fillZone) return 1;
    const capA = (r) => 1 - Math.cos(r);
    return capA(this.digZone.radius) / Math.max(1e-6, capA(this.fillZone.radius));
  }

  // ---- 生成机器 ----
  // 挖机在挖掘区"外围"集结, 开始施工后开进挖掘区就位待命(TO_DIG → IDLE)。
  spawnExcavators(n) {
    const base = this.digZone ? this.digZone.dir : new THREE.Vector3(0, 1, 0);
    const rz = this.digZone ? this.digZone.radius : 0.05;
    for (let i = 0; i < n && this.excavators.length < MAX_INSTANCES; i++) {
      // 集结点: 挖区外一圈(1.6~2.4 倍半径处)
      const dir = this._pointAtAngle(base, rz * (1.6 + Math.random() * 0.8), Math.random() * Math.PI * 2, new THREE.Vector3());
      const e = {
        dir, fwd: this._tangentToward(dir, base, new THREE.Vector3()),
        state: EX.TO_DIG, target: new THREE.Vector3().copy(base), phase: Math.random() * 6.28,
        digTimer: 0, spotTime: DIG_SPOT_TIME, serving: null, _q: 0,
      };
      if (this.digZone) this._randInCap(this.digZone.dir, this.digZone.radius * 0.6, e.target);  // 分配挖点
      this.excavators.push(e);
    }
  }
  spawnTrucks(n) {
    const base = this.digZone ? this.digZone.dir : new THREE.Vector3(0, 1, 0);
    const spread = this.digZone ? this.digZone.radius * 1.6 + 0.03 : 0.08;
    for (let i = 0; i < n && this.trucks.length < MAX_INSTANCES; i++) {
      const dir = this._randInCap(base, spread, new THREE.Vector3());
      this.trucks.push({
        dir, fwd: this._tangentToward(dir, base, new THREE.Vector3()),
        state: TR.TO_EXCA, cargo: 0, target: new THREE.Vector3().copy(dir), assigned: null,
      });
    }
  }

  clearAgents() {
    this.excavators.length = 0; this.trucks.length = 0;
    this.excaMesh.count = 0; this.truckMesh.count = 0;
  }
  clearAll() {
    this.clearAgents();
    // 收集所有自有 edit 的区域(含已烘焙的旧区域), 移除后失效这些区域 → 地形全部恢复
    const regions = this._ownedEdits.map((ed) => ({
      dir: new THREE.Vector3(ed.pos[0], ed.pos[1], ed.pos[2]), radius: ed.radius,
    }));
    for (const ed of this._ownedEdits.slice()) this._discardEdit(ed);
    this.digZone = null; this.fillZone = null;
    this.digRing.visible = false; this.fillRing.visible = false;
    this.running = false;
    this._commit(regions);
    this._fireChange();
  }

  start() {
    if (!this.hasZones()) return false;
    this.running = true;
    // 挖机统一去挖掘区就位(没分配挖点的补一个)
    for (const e of this.excavators) {
      if (!e.target) e.target = new THREE.Vector3();
      this._randInCap(this.digZone.dir, this.digZone.radius * 0.6, e.target);
      e.state = EX.TO_DIG; e.serving = null;
    }
    // 空车/排队中的卡车重新去找挖机; 正在卸货(TO_DUMP/DUMPING)的保持
    for (const t of this.trucks) {
      if (t.state === TR.DONE || t.state === TR.WAITING || t.state === TR.LOADING || t.state === TR.TO_EXCA) { t.state = TR.TO_EXCA; t.assigned = null; }
    }
    return true;
  }
  pause() { this.running = false; this._commit(); this._fireChange(); }

  // 是否整体完工: 挖掘区挖到目标 + 所有卡车空车
  allDone() {
    return this.digRemaining() <= 1e-6 && this.trucks.every((t) => t.cargo <= 1e-6);
  }

  // ---- 主循环 ----
  update(dt, cam) {
    if (cam) this._cam = cam;
    this._time += dt;
    if (this.running && this.hasZones()) {
      const r = this.rate;
      const maxAng = (this.surfaceSpeed / this.planet.params.radius) * dt;
      // 统计每台挖机的"指派卡车数"(在途/等待/装载中), 用于负载均衡 + 决定挖机是否可换点
      for (const e of this.excavators) e._q = 0;
      for (const t of this.trucks) {
        if (t.assigned && (t.state === TR.TO_EXCA || t.state === TR.WAITING || t.state === TR.LOADING)) t.assigned._q++;
      }
      for (const e of this.excavators) this._stepExcavator(e, dt, maxAng, r);
      for (const t of this.trucks) this._stepTruck(t, dt, maxAng, r);

      // 提交节流
      this._commitTimer += dt;
      if (this._dirty && this._commitTimer >= this._commitEvery) this._commit();
    }
    this._syncExcavators();
    this._syncTrucks();
  }

  _stepExcavator(e, dt, maxAng, r) {
    const done = this.digRemaining() <= 1e-6;
    switch (e.state) {
      case EX.TO_DIG: {
        if (done) { e.state = EX.DONE; return; }
        if (this._moveTo(e, maxAng)) {   // 开到挖点就位, 转待命
          e.state = EX.IDLE;
          e.digTimer = 0;
          e.spotTime = Math.max(1.0, DIG_SPOT_TIME + (Math.random() - 0.5) * 2 * DIG_SPOT_JITTER);
        }
        return;
      }
      case EX.IDLE: {
        if (done) { e.state = EX.DONE; return; }
        // 挑一台开到我旁边、指派给我、正在等待的卡车 → 开始挖掘装车
        const truck = this._findWaitingTruck(e);
        if (truck) { e.serving = truck; truck.state = TR.LOADING; e.state = EX.LOADING; return; }
        // 没有卡车指派我(_q==0) → 空闲一段后在附近小范围换点(推进作业面); 有车要来则守住位置
        if (e._q === 0) {
          e.digTimer += dt;
          if (e.digTimer >= e.spotTime) { this._nextDigSpot(e, e.target); e.state = EX.TO_DIG; }
        }
        return;
      }
      case EX.LOADING: {
        const t = e.serving;
        if (!t || t.state !== TR.LOADING) { e.serving = null; e.state = EX.IDLE; return; }
        // 挖掘装车: 推进整平进度(地形被削向目标平面) → 土直接进卡车(挖=装, 守恒)
        const amt = Math.min(BASE_LOAD * r * dt, this.digRemaining(), TRUCK_CAP - t.cargo);
        if (amt > 0) {
          this.digZone.removed += amt;
          this.digZone.edit.progress = Math.min(1, this.digZone.removed / this.digZone.total);
          t.cargo += amt;
          this._markDirty();
        }
        if (t.cargo >= TRUCK_CAP - 1e-6 || this.digRemaining() <= 1e-6) {   // 装满 或 没土可挖: 放行
          t.state = t.cargo > 1e-6 ? TR.TO_DUMP : TR.DONE;
          if (t.state === TR.TO_DUMP) this._retargetTruck(t);
          t.assigned = null; e.serving = null;
          e.state = this.digRemaining() <= 1e-6 ? EX.DONE : EX.IDLE;
        }
        return;
      }
      default: return;   // DONE
    }
  }

  // 找一台指派给挖机 e、正在其旁边(LOAD_DIST 内)等待的卡车(取最近的)
  _findWaitingTruck(e) {
    let best = null, bestDot = -2;
    for (const t of this.trucks) {
      if (t.assigned === e && t.state === TR.WAITING) {
        const d = t.dir.dot(e.dir);
        if (d > bestDot) { bestDot = d; best = t; }
      }
    }
    if (best && Math.acos(THREE.MathUtils.clamp(bestDot, -1, 1)) <= LOAD_DIST) return best;
    return null;
  }
  // 为卡车挑一台挖机: 指派数最少者优先, 其次就近
  _pickExcavator(t) {
    let best = null, bestScore = Infinity;
    for (const e of this.excavators) {
      if (e.state === EX.DONE) continue;
      const dist = Math.acos(THREE.MathUtils.clamp(t.dir.dot(e.dir), -1, 1));
      const score = e._q * 10 + dist;
      if (score < bestScore) { bestScore = score; best = e; }
    }
    return best;
  }
  // 卡车停靠点: 挖机旁 ~0.02~0.04 弧度处(随机方位, 避免叠在一起)
  _targetBesideExca(e, t) {
    this._pointAtAngle(e.dir, 0.02 + Math.random() * 0.02, Math.random() * Math.PI * 2, t.target);
  }

  // 在挖机当前位置附近小范围取新挖点, 并夹在挖掘区内(角距中心不超过 0.8×半径)
  _nextDigSpot(e, out) {
    const step = this.digZone.radius * 0.35;
    this._pointAtAngle(e.dir, step * (0.4 + Math.random() * 0.6), Math.random() * Math.PI * 2, out);
    const dot = THREE.MathUtils.clamp(out.dot(this.digZone.dir), -1, 1);
    const fromCenter = Math.acos(dot);
    const maxFromCenter = this.digZone.radius * 0.8;
    if (fromCenter > maxFromCenter) {   // 超出边界: 朝中心拉回到边界处
      this._axis.crossVectors(out, this.digZone.dir);
      if (this._axis.lengthSq() > 1e-12) { this._axis.normalize(); out.applyAxisAngle(this._axis, fromCenter - maxFromCenter).normalize(); }
    }
    return out;
  }

  _stepTruck(t, dt, maxAng, r) {
    switch (t.state) {
      case TR.TO_EXCA: {
        if (!t.assigned || t.assigned.state === EX.DONE) {
          const e = this._pickExcavator(t);
          if (!e) {   // 暂无可用挖机
            if (this.digRemaining() <= 1e-6) { t.state = t.cargo > 1e-6 ? TR.TO_DUMP : TR.DONE; if (t.state === TR.TO_DUMP) this._retargetTruck(t); }
            return;   // 否则原地等(挖机还在赶来/尚未生成)
          }
          t.assigned = e; e._q++;               // 认领(当帧即计入队列, 便于其它卡车分流)
          this._targetBesideExca(e, t);
        }
        if (this._moveTo(t, maxAng)) t.state = TR.WAITING;
        return;
      }
      case TR.WAITING: {
        if (!t.assigned || t.assigned.state === EX.DONE) { t.state = TR.TO_EXCA; t.assigned = null; return; }
        // 挖机挪窝了(离远) → 重新贴近
        if (t.dir.dot(t.assigned.dir) < Math.cos(LOAD_DIST)) { this._targetBesideExca(t.assigned, t); t.state = TR.TO_EXCA; return; }
        return;   // 就位排队, 等挖机来装(由挖机 step 触发 LOADING)
      }
      case TR.LOADING: return;   // 挖机装载中, 原地不动(挖机 step 负责)
      case TR.TO_DUMP: {
        if (this._moveTo(t, maxAng)) t.state = TR.DUMPING;
        return;
      }
      case TR.DUMPING: {
        const amt = Math.min(BASE_DUMP * r * dt, t.cargo);
        if (amt > 0) { t.cargo -= amt; this.fillZone.edit.depth -= amt * this._fillK(); this._markDirty(); }
        if (t.cargo <= 1e-6) {
          t.cargo = 0;
          t.state = this.digRemaining() > 1e-6 ? TR.TO_EXCA : TR.DONE;
          t.assigned = null;
        }
        return;
      }
      default: return;  // DONE
    }
  }

  // 卡车去卸土: 目标 = 填埋区内一点
  _retargetTruck(t) { this._randInCap(this.fillZone.dir, this.fillZone.radius * 0.7, t.target); }

  // 沿大圆走一步; 返回是否到达
  _moveTo(a, maxAng) {
    const dot = THREE.MathUtils.clamp(a.dir.dot(a.target), -1, 1);
    const ang = Math.acos(dot);
    if (ang <= Math.max(0.015, maxAng * 1.2)) return true;
    this._axis.crossVectors(a.dir, a.target);
    if (this._axis.lengthSq() < 1e-12) return true;
    this._axis.normalize();
    a.dir.applyAxisAngle(this._axis, Math.min(maxAng, ang)).normalize();
    this._tangentToward(a.dir, a.target, a.fwd);
    return false;
  }
  _tangentToward(dir, target, out) {
    out.copy(target).addScaledVector(dir, -target.dot(dir));
    if (out.lengthSq() < 1e-10) perpAxis(dir, out); else out.normalize();
    return out;
  }
  // 以 centerDir 为极点, 角距 ang、方位 az 处的球面单位方向
  _pointAtAngle(centerDir, ang, az, out) {
    perpAxis(centerDir, this._t1);
    this._t2.crossVectors(centerDir, this._t1).normalize();
    const s = Math.sin(ang), c = Math.cos(ang);
    return out.copy(centerDir).multiplyScalar(c)
      .addScaledVector(this._t1, s * Math.cos(az))
      .addScaledVector(this._t2, s * Math.sin(az))
      .normalize();
  }
  // 球冠内均匀随机方向
  _randInCap(centerDir, capRadius, out) {
    const u = Math.random();
    const ang = Math.acos(1 - u * (1 - Math.cos(capRadius)));
    return this._pointAtAngle(centerDir, ang, Math.random() * Math.PI * 2, out);
  }

  // ---- 地形提交 ----
  _markDirty(immediate) { this._dirty = true; if (immediate) this._commit(); }
  _invalidateZone(dir, radius) { for (const r of this.planet.roots) this.planet._invalidateAffected(r, dir, radius); }
  _commit(extra) {
    this.planet._buildNoise();
    if (this.digZone) this._invalidateZone(this.digZone.dir, this.digZone.radius);
    if (this.fillZone) this._invalidateZone(this.fillZone.dir, this.fillZone.radius);
    if (extra) for (const z of extra) if (z) this._invalidateZone(z.dir, z.radius);
    this.planet._editPending = true;
    this._dirty = false; this._commitTimer = 0;
  }

  // ---- 渲染 ----
  _writeInstance(mesh, i, dir, fwd, yBob) {
    const n3 = dir;
    this._v.copy(fwd).addScaledVector(n3, -fwd.dot(n3));
    if (this._v.lengthSq() < 1e-10) perpAxis(n3, this._v); else this._v.normalize();
    this._xA.crossVectors(n3, this._v).normalize();      // right = up × forward
    this._m.makeBasis(this._xA, n3, this._v);            // x=right, y=up, z=forward
    if (this.size !== 1) this._m.scale(this._sv.set(this.size, this.size, this.size));
    this._groundPos(n3, this._pos);
    if (yBob) this._pos.addScaledVector(n3, yBob);
    this._m.setPosition(this._pos);
    mesh.setMatrixAt(i, this._m);
  }
  // 头顶指示箭头: 尖朝下悬在机器上方, 按到相机距离缩放(拉远也看得见) + 轻微上下浮动
  _writeMarker(mesh, i, dir, phase) {
    this._groundPos(dir, this._pos);                       // 机器地面位置
    const dist = this._cam ? this._cam.position.distanceTo(this._pos) : 200;
    const ms = THREE.MathUtils.clamp(dist * 0.03, 1.5, this.planet.params.radius * 0.6) * this.size;
    const gap = ms * 0.7 + Math.sin(this._time * 3 + phase) * ms * 0.22;   // 悬浮高度 + bob
    this._pos.addScaledVector(dir, gap);
    perpAxis(dir, this._xA);
    this._v.crossVectors(dir, this._xA).normalize();
    this._m.makeBasis(this._xA, dir, this._v);             // y = 径向上; 圆锥尖朝下指机器
    this._m.scale(this._sv.set(ms, ms, ms));
    this._m.setPosition(this._pos);
    mesh.setMatrixAt(i, this._m);
  }
  _syncExcavators() {
    const n = Math.min(this.excavators.length, MAX_INSTANCES);
    this.excaMesh.count = n;
    const mk = this.showMarkers;
    this.excaMarker.count = mk ? n : 0;
    for (let i = 0; i < n; i++) {
      const e = this.excavators[i];
      // 装车(挖掘)中: 上下小幅 bob, 表示在作业
      const bob = e.state === EX.LOADING ? Math.sin(this._time * 6 + e.phase) * 0.35 * this.size : 0;
      this._writeInstance(this.excaMesh, i, e.dir, e.fwd, bob);
      this.excaMesh.setColorAt(i, EX_COLOR[e.state] || EX_COLOR[EX.IDLE]);
      if (mk) this._writeMarker(this.excaMarker, i, e.dir, e.phase);
    }
    this.excaMesh.instanceMatrix.needsUpdate = true;
    if (this.excaMesh.instanceColor) this.excaMesh.instanceColor.needsUpdate = true;
    if (mk) this.excaMarker.instanceMatrix.needsUpdate = true;
    if (this.digZone) this._updateRing(this.digRing, this.digZone.dir, this.digZone.radius);
    if (this.fillZone) this._updateRing(this.fillRing, this.fillZone.dir, this.fillZone.radius);
  }
  _syncTrucks() {
    const n = Math.min(this.trucks.length, MAX_INSTANCES);
    this.truckMesh.count = n;
    const mk = this.showMarkers;
    this.truckMarker.count = mk ? n : 0;
    for (let i = 0; i < n; i++) {
      const t = this.trucks[i];
      this._writeInstance(this.truckMesh, i, t.dir, t.fwd, 0);
      this.truckMesh.setColorAt(i, TR_COLOR[t.state] || TR_COLOR[TR.TO_EXCA]);
      if (mk) this._writeMarker(this.truckMarker, i, t.dir, i * 1.7);
    }
    this.truckMesh.instanceMatrix.needsUpdate = true;
    if (this.truckMesh.instanceColor) this.truckMesh.instanceColor.needsUpdate = true;
    if (mk) this.truckMarker.instanceMatrix.needsUpdate = true;
  }

  _makeRing(color) {
    const N = 72;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    const m = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false });
    const ring = new THREE.LineLoop(g, m);
    ring.frustumCulled = false; ring.renderOrder = 998; ring.visible = false; ring.userData.N = N;
    return ring;
  }
  _updateRing(ring, centerDir, capRadius) {
    const N = ring.userData.N, p = this.planet.params;
    perpAxis(centerDir, this._t1);
    this._t2.crossVectors(centerDir, this._t1).normalize();
    const sr = Math.sin(capRadius), cr = Math.cos(capRadius);
    const pos = ring.geometry.attributes.position.array;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      this._v.copy(centerDir).multiplyScalar(cr)
        .addScaledVector(this._t1, sr * ca).addScaledVector(this._t2, sr * sa).normalize();
      const rr = (p.radius + this.planet.heightAt(this._v.x, this._v.y, this._v.z) * p.maxHeight) * 1.003;
      pos[i * 3] = this._v.x * rr + this.planet.position.x;
      pos[i * 3 + 1] = this._v.y * rr + this.planet.position.y;
      pos[i * 3 + 2] = this._v.z * rr + this.planet.position.z;
    }
    ring.geometry.attributes.position.needsUpdate = true;
    ring.visible = true;
  }

  dispose() {
    const objs = [this.excaMesh, this.truckMesh, this.excaMarker, this.truckMarker, this.digRing, this.fillRing];
    this.scene.remove(...objs);
    for (const o of objs) { o.geometry.dispose(); o.material.dispose(); }
  }
}
