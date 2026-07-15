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

const GEO_BUILDERS = {
  miner: buildMinerGeometry,
  warehouse: buildWarehouseGeometry,
  truck: buildTruckGeometry,
  smelter: buildSmelterGeometry,
  assembler: buildAssemblerGeometry,
};
// 各外形的基础色(未按状态染色时)
const BASE_COLOR = {
  miner: 0xc9a24a, warehouse: 0x9fb6c9, truck: 0xd9c15a,
  smelter: 0xb56a4a, assembler: 0x7f8aa0,
};

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
    output_full: new THREE.Color(0x5ab0ff), idle: new THREE.Color(0x8a8f98),
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
    groups[name] = { mesh, geo, mat, base: new THREE.Color(BASE_COLOR[name]), count: 0 };
  }
  const fallbackBuilding = groups.miner;
  const fallbackAgent = groups.truck;

  function put(g, matrix, color) {
    if (g.count >= MAX) return;
    g.mesh.setMatrixAt(g.count, matrix);
    g.mesh.setColorAt(g.count, color);
    g.count++;
  }

  return {
    groups,
    setPlanet(p) { planet = p; },
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
        let color = g.base;
        if (miner) color = minerState[miner.state] || g.base;
        else if (prod) color = producerState[prod.state] || g.base;
        put(g, _m, color);
      }

      // agent(移动): 朝行进方向 + 卡车按状态染色
      for (const e of world.query('Agent', 'Mover')) {
        const ag = world.get(e, 'Agent');
        const mv = world.get(e, 'Mover');
        const g = groups[ag.mesh] || fallbackAgent;
        worldMatrixHeading(mv.dir, mv.fwd || mv.dir, planet, _m, size);
        const h = world.get(e, 'Hauler');
        put(g, _m, (h && haulerState[h.state]) || g.base);
      }

      for (const name in groups) {
        const g = groups[name];
        g.mesh.count = g.count;
        g.mesh.instanceMatrix.needsUpdate = true;
        if (g.mesh.instanceColor) g.mesh.instanceColor.needsUpdate = true;
      }
    },
    dispose() {
      for (const name in groups) {
        const g = groups[name];
        scene.remove(g.mesh); g.geo.dispose(); g.mat.dispose();
      }
    },
  };
}
