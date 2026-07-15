// 工厂渲染层(接 three.js) —— 把 world 里的建筑渲染成 InstancedMesh。
// M1: 只有采矿机一种外形; 每帧按各实体 Anchor 写实例矩阵(复用 anchor.worldMatrix + heightAt)。
// 多建筑类型时: 每种 mesh 一个 InstancedMesh, 按 Building.mesh 分组。

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { worldMatrix } from '../core/anchor.js';

const MAX = 512;

// 采矿机外形: 底座 + 机身 + 钻头(朝下, 象征啃地形)
function buildMinerGeometry() {
  const parts = [];
  const push = (g, x, y, z) => { g.translate(x, y, z); parts.push(g); };
  push(new THREE.BoxGeometry(3.0, 0.6, 3.0), 0, 0.3, 0);       // 底座
  push(new THREE.BoxGeometry(2.0, 1.4, 2.0), 0, 1.2, 0);       // 机身
  push(new THREE.CylinderGeometry(0.15, 0.5, 1.2, 8), 0, -0.3, 0);   // 钻头(锥朝下)
  const geo = mergeGeometries(parts, false);
  geo.computeVertexNormals();
  return geo;
}

export function createFactoryRenderer(scene, planet, opts = {}) {
  const size = opts.size || 1;
  const geo = buildMinerGeometry();
  const mat = new THREE.MeshStandardMaterial({ color: 0xc9a24a, roughness: 0.75, metalness: 0.25 });
  const mesh = new THREE.InstancedMesh(geo, mat, MAX);
  mesh.frustumCulled = false;
  mesh.count = 0;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const white = new THREE.Color(0xffffff);
  for (let i = 0; i < MAX; i++) mesh.setColorAt(i, white);
  scene.add(mesh);
  const _m = new THREE.Matrix4();
  const stateColor = {
    mining: new THREE.Color(0xffc040), full: new THREE.Color(0x66cc66),
    blocked: new THREE.Color(0xd0413f), idle: new THREE.Color(0x8a8f98),
  };

  return {
    mesh,
    setPlanet(p) { planet = p; },
    update(world) {
      let i = 0;
      for (const e of world.query('Building', 'Anchor')) {
        if (i >= MAX) break;
        const a = world.get(e, 'Anchor');
        worldMatrix(a.dir, a.yaw || 0, planet, _m, size);
        mesh.setMatrixAt(i, _m);
        const miner = world.get(e, 'Miner');
        mesh.setColorAt(i, (miner && stateColor[miner.state]) || white);
        i++;
      }
      mesh.count = i;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    },
    dispose() { scene.remove(mesh); geo.dispose(); mat.dispose(); },
  };
}
