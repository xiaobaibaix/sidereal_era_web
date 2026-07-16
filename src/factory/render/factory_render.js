// 工厂渲染层(接 three.js) —— 把 world 里的建筑与移动 agent 渲染成一组 InstancedMesh。
// 每种外形(mesh 名)一个 InstancedMesh:
//   - 建筑(Building+Anchor): 静止, 用 anchor.worldMatrix(dir,yaw) 落地; 采矿机按 Miner.state 染色。
//   - agent(Agent+Mover): 移动, 用 anchor.worldMatrixHeading(dir,fwd) 朝行进方向; 卡车按 Hauler.state 染色。
// 加新外形只需在 GEO_BUILDERS 里加一个几何构建函数 + 在 gamedata 的 mesh 字段引用它。

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { worldMatrix, worldMatrixHeading } from '../core/anchor.js';

const MAX = 512;

// ---- 外形几何(本地系: y=径向朝上, z=前进朝向) ----

// 采矿机: 底座 + 机身 + 钻头(朝下, 象征啃地形)
function buildMinerGeometry() {
  const parts = [];
  const push = (g, x, y, z) => { g.translate(x, y, z); parts.push(g); };
  push(new THREE.BoxGeometry(3.0, 0.6, 3.0), 0, 0.3, 0);            // 底座
  push(new THREE.BoxGeometry(2.0, 1.4, 2.0), 0, 1.2, 0);            // 机身
  push(new THREE.CylinderGeometry(0.15, 0.5, 1.2, 8), 0, -0.3, 0);  // 钻头(锥朝下)
  const geo = mergeGeometries(parts, false);
  geo.computeVertexNormals();
  return geo;
}

// 仓库: 大箱体 + 双坡屋顶(比矿机大一圈, 便于辨认)
function buildWarehouseGeometry() {
  const parts = [];
  const push = (g, x, y, z) => { g.translate(x, y, z); parts.push(g); };
  push(new THREE.BoxGeometry(6.0, 3.0, 8.0), 0, 1.5, 0);           // 主体
  const roof = new THREE.CylinderGeometry(0.01, 3.4, 8.2, 4, 1);   // 四棱锥当屋脊
  roof.rotateZ(Math.PI / 2); roof.rotateY(Math.PI / 4);
  roof.translate(0, 3.6, 0);
  parts.push(roof);
  const geo = mergeGeometries(parts, false);
  geo.computeVertexNormals();
  return geo;
}

// 卡车: 货斗 + 驾驶室(朝 +z) + 四个轮子。前进朝向 = +z。
function buildTruckGeometry() {
  const parts = [];
  const push = (g, x, y, z) => { g.translate(x, y, z); parts.push(g); };
  push(new THREE.BoxGeometry(2.0, 1.2, 2.6), 0, 0.9, -0.6);        // 货斗(后部)
  push(new THREE.BoxGeometry(1.8, 1.0, 1.4), 0, 0.8, 1.4);         // 驾驶室(前部 +z)
  const wheel = () => { const w = new THREE.CylinderGeometry(0.5, 0.5, 0.4, 10); w.rotateZ(Math.PI / 2); return w; };
  push(wheel(), 1.1, 0.4, 1.0); push(wheel(), -1.1, 0.4, 1.0);     // 前轮
  push(wheel(), 1.1, 0.4, -1.0); push(wheel(), -1.1, 0.4, -1.0);   // 后轮
  const geo = mergeGeometries(parts, false);
  geo.computeVertexNormals();
  return geo;
}

// 冶炼炉: 方形炉体 + 烟囱(象征高温冶炼)
function buildSmelterGeometry() {
  const parts = [];
  const push = (g, x, y, z) => { g.translate(x, y, z); parts.push(g); };
  push(new THREE.BoxGeometry(4.0, 3.2, 4.0), 0, 1.6, 0);          // 炉体
  push(new THREE.CylinderGeometry(0.7, 0.9, 2.6, 10), 1.1, 4.3, 1.1);  // 烟囱
  push(new THREE.BoxGeometry(2.2, 0.9, 0.3), 0, 1.0, 2.0);        // 炉门(前壁)
  const geo = mergeGeometries(parts, false);
  geo.computeVertexNormals();
  return geo;
}

// 制造台: 底座 + 装配平台 + 龙门架(象征机械臂加工)
function buildAssemblerGeometry() {
  const parts = [];
  const push = (g, x, y, z) => { g.translate(x, y, z); parts.push(g); };
  push(new THREE.BoxGeometry(4.4, 1.0, 4.4), 0, 0.5, 0);          // 底座
  push(new THREE.BoxGeometry(3.4, 0.8, 3.4), 0, 1.4, 0);          // 装配台面
  push(new THREE.BoxGeometry(0.4, 2.4, 0.4), -1.6, 2.6, 0);       // 龙门左柱
  push(new THREE.BoxGeometry(0.4, 2.4, 0.4), 1.6, 2.6, 0);        // 龙门右柱
  push(new THREE.BoxGeometry(3.8, 0.4, 0.6), 0, 3.7, 0);          // 龙门横梁
  const geo = mergeGeometries(parts, false);
  geo.computeVertexNormals();
  return geo;
}

// 矿场: 宽大的敞口料仓(比其它建筑大, 象征矿石堆场) + 底座圈
function buildDepotGeometry() {
  const parts = [];
  const push = (g, x, y, z) => { g.translate(x, y, z); parts.push(g); };
  push(new THREE.CylinderGeometry(4.6, 5.2, 1.0, 16), 0, 0.5, 0);   // 底座
  push(new THREE.CylinderGeometry(4.4, 4.4, 2.6, 16), 0, 2.2, 0);   // 料仓外壁
  push(new THREE.CylinderGeometry(3.4, 3.4, 2.0, 16), 0, 2.7, 0);   // 内凹开口(暗)
  const geo = mergeGeometries(parts, false);
  geo.computeVertexNormals();
  return geo;
}

// 挖机: 履带底盘 + 车身 + 驾驶室 + 挖臂(朝 +z)
function buildExcavatorGeometry() {
  const parts = [];
  const push = (g, x, y, z, rx) => { if (rx) g.rotateX(rx); g.translate(x, y, z); parts.push(g); };
  push(new THREE.BoxGeometry(2.6, 0.5, 3.4), 0, 0.25, 0);          // 底盘
  push(new THREE.BoxGeometry(2.0, 0.9, 2.4), 0, 0.95, -0.2);       // 车身
  push(new THREE.BoxGeometry(1.3, 0.9, 1.1), 0, 1.75, -0.7);       // 驾驶室
  push(new THREE.BoxGeometry(0.35, 0.35, 2.2), 0, 1.2, 1.35, -0.35); // 挖臂(朝 +z)
  push(new THREE.BoxGeometry(1.0, 0.6, 0.7), 0, 0.6, 2.5);         // 铲斗
  const geo = mergeGeometries(parts, false);
  geo.computeVertexNormals();
  return geo;
}

// 输电塔: 上宽下窄的塔身 + 顶部横担(高, 便于连线)
function buildTowerGeometry() {
  const parts = [];
  const push = (g, x, y, z) => { g.translate(x, y, z); parts.push(g); };
  push(new THREE.BoxGeometry(1.6, 0.4, 1.6), 0, 0.2, 0);          // 底座
  push(new THREE.CylinderGeometry(0.28, 0.6, 6.0, 6), 0, 3.2, 0); // 塔身
  push(new THREE.BoxGeometry(3.0, 0.35, 0.35), 0, 6.1, 0);        // 顶部横担
  push(new THREE.BoxGeometry(0.35, 0.35, 3.0), 0, 6.1, 0);
  const geo = mergeGeometries(parts, false);
  geo.computeVertexNormals();
  return geo;
}

// 发电机: 塔柱 + 机舱 + 三叶(风力发电)
function buildGeneratorGeometry() {
  const parts = [];
  const push = (g, x, y, z, rz) => { if (rz) g.rotateZ(rz); g.translate(x, y, z); parts.push(g); };
  push(new THREE.CylinderGeometry(0.3, 0.5, 5.5, 8), 0, 2.75, 0);   // 塔柱
  push(new THREE.BoxGeometry(1.2, 0.8, 1.6), 0, 5.6, 0.2);          // 机舱
  for (let i = 0; i < 3; i++) {                                     // 三叶
    const b = new THREE.BoxGeometry(0.25, 3.0, 0.12);
    b.translate(0, 1.5, 0); b.rotateZ((i * 2 * Math.PI) / 3);
    b.translate(0, 5.6, 1.05); parts.push(b);
  }
  const geo = mergeGeometries(parts, false);
  geo.computeVertexNormals();
  return geo;
}

// 研究站: 基座 + 半球穹顶 + 天线(象征科研)
function buildLabGeometry() {
  const parts = [];
  const push = (g, x, y, z) => { g.translate(x, y, z); parts.push(g); };
  push(new THREE.BoxGeometry(4.0, 1.6, 4.0), 0, 0.8, 0);                                 // 基座
  push(new THREE.SphereGeometry(2.0, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), 0, 1.6, 0); // 穹顶(半球)
  push(new THREE.CylinderGeometry(0.08, 0.08, 1.8, 6), 0, 4.4, 0);                        // 天线
  const geo = mergeGeometries(parts, false);
  geo.computeVertexNormals();
  return geo;
}

const GEO_BUILDERS = {
  miner: buildMinerGeometry,
  warehouse: buildWarehouseGeometry,
  truck: buildTruckGeometry,
  smelter: buildSmelterGeometry,
  assembler: buildAssemblerGeometry,
  depot: buildDepotGeometry,
  excavator: buildExcavatorGeometry,
  tower: buildTowerGeometry,
  generator: buildGeneratorGeometry,
  lab: buildLabGeometry,
};
// 各外形的基础色(未按状态染色时)
const BASE_COLOR = {
  miner: 0xc9a24a, warehouse: 0x9fb6c9, truck: 0xd9c15a,
  smelter: 0xb56a4a, assembler: 0x7f8aa0,
  depot: 0x8a7a5a, excavator: 0xe0a52e,
  tower: 0x9fb0c0, generator: 0xdfe6ec, lab: 0x6fae9f,
};
// 各建筑的可点击半径(世界单位, 略大于模型底座, 便于点选)。点击拾取 + 范围可视化共用同一数据。
const MESH_PICK_R = {
  miner: 2.6, smelter: 3.2, assembler: 3.4, warehouse: 5.2, depot: 5.6, tower: 2.2, generator: 2.6, lab: 3.4,
};
const DEFAULT_PICK_R = 3.0;

export function createFactoryRenderer(scene, planet, opts = {}) {
  const size = opts.size || 1;
  const white = new THREE.Color(0xffffff);
  const _m = new THREE.Matrix4();

  const minerState = {
    mining: new THREE.Color(0xffc040), full: new THREE.Color(0x66cc66),
    blocked: new THREE.Color(0xd0413f), idle: new THREE.Color(0x8a8f98),
  };
  const haulerState = {
    idle: new THREE.Color(0x8a8f98), to_src: new THREE.Color(0x5ab0ff),
    load: new THREE.Color(0xffc040), to_sink: new THREE.Color(0x66cc66),
    unload: new THREE.Color(0x66cc66),
  };
  const producerState = {
    working: new THREE.Color(0xffb020), starved: new THREE.Color(0xd0704f),
    output_full: new THREE.Color(0x5ab0ff), no_power: new THREE.Color(0x50555f), idle: new THREE.Color(0x8a8f98),
  };
  const labState = {
    researching: new THREE.Color(0x4fd0c0), starved: new THREE.Color(0xd0704f), idle: new THREE.Color(0x8a8f98),
  };
  const excavatorState = {
    digging: new THREE.Color(0xff8a2d), to_zone: new THREE.Color(0xffd24a),
    full: new THREE.Color(0x66cc66), idle: new THREE.Color(0x8a8f98),
  };
  const minetruckState = {
    idle: new THREE.Color(0x8a8f98), to_exca: new THREE.Color(0xffe27a),
    load: new THREE.Color(0xffb74a), to_depot: new THREE.Color(0x9c6b3f),
    unload: new THREE.Color(0x66cc66),
  };

  // 每种外形建一个 InstancedMesh
  const groups = {};
  for (const name in GEO_BUILDERS) {
    const geo = GEO_BUILDERS[name]();
    const mat = new THREE.MeshStandardMaterial({ color: BASE_COLOR[name], roughness: 0.75, metalness: 0.25 });
    const mesh = new THREE.InstancedMesh(geo, mat, MAX);
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < MAX; i++) mesh.setColorAt(i, white);
    scene.add(mesh);
    groups[name] = { mesh, geo, mat, base: new THREE.Color(BASE_COLOR[name]), count: 0, eids: [] };
  }
  const fallbackBuilding = groups.miner;
  const fallbackAgent = groups.truck;
  const _hl = new THREE.Color(0xffffff);   // 选中高亮色
  let selectedEid = null;

  function put(g, matrix, color, eid) {
    if (g.count >= MAX) return;
    g.mesh.setMatrixAt(g.count, matrix);
    g.mesh.setColorAt(g.count, eid === selectedEid ? _hl : color);
    g.eids[g.count] = eid;
    g.count++;
  }

  // ---- 可点击范围可视化(切平面圆环, 半径 = 建筑 pick 半径) ----
  const SEG = 48;
  const ringPos = new Float32Array((SEG + 1) * 3);
  for (let i = 0; i <= SEG; i++) {   // 单位圆在 XZ 平面(y=0), worldMatrix 会把它贴到地表切平面
    const t = (i / SEG) * Math.PI * 2;
    ringPos[i * 3] = Math.cos(t); ringPos[i * 3 + 1] = 0; ringPos[i * 3 + 2] = Math.sin(t);
  }
  const ringGeo = new THREE.BufferGeometry();
  ringGeo.setAttribute('position', new THREE.BufferAttribute(ringPos, 3));
  const ringMat = new THREE.LineBasicMaterial({ color: 0x5ad1ff, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false });
  const ringGroup = new THREE.Group();
  ringGroup.visible = false;
  ringGroup.renderOrder = 999;
  scene.add(ringGroup);
  const ringPool = [];
  function ensureRings(n) {
    while (ringPool.length < n) {
      const l = new THREE.LineLoop(ringGeo, ringMat);
      l.frustumCulled = false; l.matrixAutoUpdate = false; l.renderOrder = 999;
      ringGroup.add(l); ringPool.push(l);
    }
  }
  const pickR = (mesh) => MESH_PICK_R[mesh] || DEFAULT_PICK_R;

  // ---- 矿场挖掘区圆环(红色, 常显; 复用同一单位圆几何) ----
  const zoneMat = new THREE.LineBasicMaterial({ color: 0xff5a5a, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false });
  const zoneGroup = new THREE.Group();
  zoneGroup.renderOrder = 998;
  scene.add(zoneGroup);
  const zonePool = [];
  function ensureZoneRings(n) {
    while (zonePool.length < n) {
      const l = new THREE.LineLoop(ringGeo, zoneMat);
      l.frustumCulled = false; l.matrixAutoUpdate = false; l.renderOrder = 998;
      zoneGroup.add(l); zonePool.push(l);
    }
  }

  // ---- 电力连线(塔↔塔 / 塔↔建筑, 悬于地表上方) ----
  const POWER_MAX = 2048;   // 最多端点数
  const powerPos = new Float32Array(POWER_MAX * 3);
  const powerGeo = new THREE.BufferGeometry();
  powerGeo.setAttribute('position', new THREE.BufferAttribute(powerPos, 3));
  const powerMat = new THREE.LineBasicMaterial({ color: 0x66e0ff, transparent: true, opacity: 0.7, depthTest: false, depthWrite: false });
  const powerLines = new THREE.LineSegments(powerGeo, powerMat);
  powerLines.frustumCulled = false; powerLines.renderOrder = 997;
  scene.add(powerLines);
  const _pp = new THREE.Vector3();
  const POWER_LIFT = 5.0;   // 连线悬空高度(读作架空电线)
  function surfacePos(dir, out) {
    const p = planet.params;
    const rr = p.radius + planet.heightAt(dir[0], dir[1], dir[2]) * p.maxHeight + POWER_LIFT;
    return out.set(dir[0], dir[1], dir[2]).multiplyScalar(rr).add(planet.position);
  }

  return {
    groups,
    setPlanet(p) { planet = p; },
    setSelected(eid) { selectedEid = eid; },        // 选中实体高亮(null 取消)
    update(world) {
      for (const name in groups) groups[name].count = 0;

      // 建筑(静止): 落地 + 采矿机按状态染色
      for (const e of world.query('Building', 'Anchor')) {
        const b = world.get(e, 'Building');
        const a = world.get(e, 'Anchor');
        const g = groups[b.mesh] || fallbackBuilding;
        worldMatrix(a.dir, a.yaw || 0, planet, _m, size);
        const miner = world.get(e, 'Miner');
        const prod = world.get(e, 'Producer');
        const lab = world.get(e, 'Lab');
        let color = g.base;
        if (miner) color = minerState[miner.state] || g.base;
        else if (prod) color = producerState[prod.state] || g.base;
        else if (lab) color = labState[lab.state] || g.base;
        put(g, _m, color, e);
      }

      // agent(移动): 朝行进方向 + 按各自状态染色(物流卡车/挖机/采矿卡车)
      for (const e of world.query('Agent', 'Mover')) {
        const ag = world.get(e, 'Agent');
        const mv = world.get(e, 'Mover');
        const g = groups[ag.mesh] || fallbackAgent;
        worldMatrixHeading(mv.dir, mv.fwd || mv.dir, planet, _m, size);
        const h = world.get(e, 'Hauler');
        const ex = world.get(e, 'Excavator');
        const mtk = world.get(e, 'MineTruck');
        let color = g.base;
        if (h) color = haulerState[h.state] || g.base;
        else if (ex) color = excavatorState[ex.state] || g.base;
        else if (mtk) color = minetruckState[mtk.state] || g.base;
        put(g, _m, color, e);
      }

      for (const name in groups) {
        const g = groups[name];
        g.mesh.count = g.count;
        g.mesh.instanceMatrix.needsUpdate = true;
        if (g.mesh.instanceColor) g.mesh.instanceColor.needsUpdate = true;
      }

      // 可点击范围圆环(仅在开启时): 每个建筑一个环, 半径 = 其 pick 半径
      if (ringGroup.visible) {
        let i = 0;
        for (const e of world.query('Building', 'Anchor')) {
          const a = world.get(e, 'Anchor');
          const b = world.get(e, 'Building');
          ensureRings(i + 1);
          worldMatrix(a.dir, 0, planet, _m, pickR(b.mesh));
          ringPool[i].matrix.copy(_m);
          ringPool[i].visible = true;
          i++;
        }
        for (; i < ringPool.length; i++) ringPool[i].visible = false;
      }

      // 矿场挖掘区圆环(常显): 已圈定挖掘区的矿场画一个红环, 半径 = 挖掘区角半径 × 星球半径
      {
        let i = 0;
        const R = planet.params.radius;
        for (const e of world.query('Depot', 'DigZone')) {
          const z = world.get(e, 'DigZone');
          if (!z.center) continue;
          ensureZoneRings(i + 1);
          worldMatrix(z.center, 0, planet, _m, z.radius * R);   // 角半径→世界半径
          zonePool[i].matrix.copy(_m);
          zonePool[i].visible = true;
          i++;
        }
        for (; i < zonePool.length; i++) zonePool[i].visible = false;
      }
    },
    showPickRanges(on) { ringGroup.visible = !!on; },
    // 更新电力连线; links = [[dirA, dirB], ...](单位方向数组), 由 power 系统写入 ctx.power.links
    setPowerLines(links) {
      let n = 0;
      if (links) {
        for (const seg of links) {
          if (n + 2 > POWER_MAX) break;
          surfacePos(seg[0], _pp); powerPos[n * 3] = _pp.x; powerPos[n * 3 + 1] = _pp.y; powerPos[n * 3 + 2] = _pp.z; n++;
          surfacePos(seg[1], _pp); powerPos[n * 3] = _pp.x; powerPos[n * 3 + 1] = _pp.y; powerPos[n * 3 + 2] = _pp.z; n++;
        }
      }
      powerGeo.setDrawRange(0, n);
      powerGeo.attributes.position.needsUpdate = true;
    },
    // 按方向精确拾取建筑: 只命中"点击方向落在其 pick 圆环内"的建筑, 取最近的一个(未命中 null)
    pickBuilding(world, dir) {
      const R = planet.params.radius;
      let best = null, bestDot = -2;
      for (const e of world.query('Building', 'Anchor')) {
        const a = world.get(e, 'Anchor');
        const b = world.get(e, 'Building');
        const cosR = Math.cos(pickR(b.mesh) / R);   // 世界半径 → 角半径
        const dot = dir[0] * a.dir[0] + dir[1] * a.dir[1] + dir[2] * a.dir[2];
        if (dot >= cosR && dot > bestDot) { bestDot = dot; best = e; }
      }
      return best;
    },
    // 屏幕拾取: 用已配置好的 raycaster 命中最近的建筑/agent, 返回其实体 id(未命中 null)
    pickEntity(raycaster) {
      let bestEid = null, bestDist = Infinity;
      for (const name in groups) {
        const g = groups[name];
        if (g.count === 0) continue;
        const hits = raycaster.intersectObject(g.mesh, false);
        for (const h of hits) {
          if (h.instanceId == null || h.instanceId >= g.count) continue;
          if (h.distance < bestDist) { bestDist = h.distance; bestEid = g.eids[h.instanceId]; }
          break;   // hits 已按距离排序, 取该 mesh 最近的一个即可
        }
      }
      return bestEid;
    },
    dispose() {
      for (const name in groups) {
        const g = groups[name];
        scene.remove(g.mesh); g.geo.dispose(); g.mat.dispose();
      }
      scene.remove(ringGroup); scene.remove(zoneGroup); scene.remove(powerLines);
      ringGeo.dispose(); ringMat.dispose(); zoneMat.dispose(); powerGeo.dispose(); powerMat.dispose();
    },
  };
}
