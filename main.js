// Icosphere Planet + 三角形四叉树 LOD (three.js)
//
// 场景搭建 / 相机 / 光照 / 主循环 / GUI。
// 行星本体(网格生成 + 噪声 + LOD)在 planet.js。

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import GUI from 'lil-gui';
import { Planet } from './planet.js';
import { createOcean, createAtmosphere } from './effects.js';

// ----------------------------------------------------------------------------
// 参数
// ----------------------------------------------------------------------------
const params = {
  radius: 100,
  maxHeight: 8,             // 最大抬升(相对半径)
  seaLevel: 0.0,
  wireframe: false,         // 线框模式

  // 外观
  showOcean: true,
  showAtmosphere: true,
  atmoIntensity: 1.3,
  atmoColor: '#5a99ff',

  // LOD
  maxLevel: 8,             // 四叉树最大细分层数
  splitFactor: 2.5,        // 相机距离 < 边长*splitFactor 时细分(越大越激进)
  patchResolution: 16,     // 每个 patch 的网格分辨率(必须是 2 的幂, 缝合依赖 dyadic 嵌套)

  // 大陆噪声 (fBm)
  continentSeed: 1337,
  continentFreq: 1.2,
  continentOctaves: 5,
  continentGain: 0.5,
  continentLacunarity: 2.0,

  // 山脉噪声 (Ridged)
  mountainSeed: 9001,
  mountainFreq: 3.0,
  mountainOctaves: 5,
  mountainStrength: 0.6,
};

// ----------------------------------------------------------------------------
// 场景 / 相机 / 渲染器
// ----------------------------------------------------------------------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070d);

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 200000);
camera.position.set(0, 80, 320);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = params.radius + params.maxHeight * 2.5;
controls.maxDistance = 8000;

// 光照
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(1, 0.6, 0.8);
scene.add(sun);
scene.add(new THREE.HemisphereLight(0x334466, 0x0a0a12, 0.45));

// 星空
(function addStars() {
  const g = new THREE.BufferGeometry();
  const n = 3000;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(50000);
    pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x8899aa, size: 60 })));
})();

// ----------------------------------------------------------------------------
// 行星
// ----------------------------------------------------------------------------
let planet = new Planet(params);
scene.add(planet);

// 海洋 + 大气
const ocean = createOcean();
const atmosphere = createAtmosphere();
scene.add(ocean, atmosphere);

function layoutEffects() {
  const oceanR = params.radius + params.seaLevel * params.maxHeight;
  ocean.scale.setScalar(oceanR);
  ocean.visible = params.showOcean;
  ocean.material.uniforms.uSunDir.value.copy(sun.position).normalize();

  atmosphere.scale.setScalar(params.radius * 1.22);
  atmosphere.visible = params.showAtmosphere;
  atmosphere.material.uniforms.uIntensity.value = params.atmoIntensity;
  atmosphere.material.uniforms.uColor.value.set(params.atmoColor);
}
layoutEffects();

function rebuild() {
  planet.rebuild();
  controls.minDistance = params.radius + params.maxHeight * 2.5;
  layoutEffects();
}

// ----------------------------------------------------------------------------
// GUI
// ----------------------------------------------------------------------------
const gui = new GUI();

gui.add(params, 'wireframe').name('线框模式').onChange((v) => {
  planet.setWireframe(v);
});

const fApp = gui.addFolder('外观');
fApp.add(params, 'showOcean').name('海洋').onChange((v) => { ocean.visible = v; });
fApp.add(params, 'showAtmosphere').name('大气').onChange((v) => { atmosphere.visible = v; });
fApp.add(params, 'atmoIntensity', 0, 3).name('大气强度').onChange((v) => {
  atmosphere.material.uniforms.uIntensity.value = v;
});
fApp.addColor(params, 'atmoColor').name('大气颜色').onChange((v) => {
  atmosphere.material.uniforms.uColor.value.set(v);
});

const fLod = gui.addFolder('LOD');
fLod.add(params, 'maxLevel', 0, 12, 1).name('最大层数');
fLod.add(params, 'splitFactor', 1, 5).name('细分激进度');
fLod.add(params, 'patchResolution', [4, 8, 16, 32]).name('patch 分辨率').onChange(rebuild);

gui.add(params, 'radius', 10, 500).name('半径').onFinishChange(rebuild);
gui.add(params, 'maxHeight', 0, 30).name('最大高度').onFinishChange(rebuild);
gui.add(params, 'seaLevel', -0.5, 0.5).name('海平面').onFinishChange(rebuild);

const fCont = gui.addFolder('大陆噪声 (fBm)');
fCont.add(params, 'continentSeed', 0, 99999, 1).name('种子').onFinishChange(rebuild);
fCont.add(params, 'continentFreq', 0.2, 4).name('频率').onFinishChange(rebuild);
fCont.add(params, 'continentOctaves', 1, 8, 1).name('八度').onFinishChange(rebuild);
fCont.add(params, 'continentGain', 0.1, 0.9).name('持续度').onFinishChange(rebuild);
fCont.add(params, 'continentLacunarity', 1.5, 3).name('间隙度').onFinishChange(rebuild);

const fMtn = gui.addFolder('山脉噪声 (Ridged)');
fMtn.add(params, 'mountainSeed', 0, 99999, 1).name('种子').onFinishChange(rebuild);
fMtn.add(params, 'mountainFreq', 0.5, 8).name('频率').onFinishChange(rebuild);
fMtn.add(params, 'mountainOctaves', 1, 8, 1).name('八度').onFinishChange(rebuild);
fMtn.add(params, 'mountainStrength', 0, 1.5).name('强度').onFinishChange(rebuild);

// ----------------------------------------------------------------------------
// 主循环
// ----------------------------------------------------------------------------
const info = document.getElementById('info');

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  planet.update(camera);   // LOD 遍历
  renderer.render(scene, camera);

  const altitude = (camera.position.length() - params.radius).toFixed(1);
  const s = planet.stats;
  info.innerHTML =
    `鼠标左键旋转 · 滚轮缩放 · 右键平移<br />` +
    `patch: ${s.patches} · 三角形: ${s.triangles} · 高度: ${altitude}<br />` +
    `队列: ${s.queued} · 生成中: ${s.inflight}`;
}
animate();
