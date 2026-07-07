// Icosphere Planet + 三角形四叉树 LOD (three.js)
//
// 场景搭建 / 相机 / 光照 / 主循环 / GUI。
// 行星本体(网格生成 + 噪声 + LOD)在 planet.js。

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
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

  // 旁观相机(WASD 自由飞行, 不影响 LOD 细分; 画中画小窗一直显示)
  showInset: true,
  spectatorSpeed: 80,

  // 外观
  showOcean: true,
  showAtmosphere: true,
  atmoIntensity: 1.3,
  atmoColor: '#5a99ff',

  // LOD
  maxLevel: 8,             // 四叉树最大细分层数
  splitFactor: 2.5,        // 相机距离 < 边长*splitFactor 时细分(越大越激进)
  patchResolution: 16,     // 每个 patch 的网格分辨率(必须是 2 的幂, 缝合依赖 dyadic 嵌套)
  frustumMargin: 0.15,     // 视锥外扩余量(屏幕外预细分一圈, 减少旋转 pop-in)
  nearRadius: 50,          // 相机周围此半径内一律细分(不受视锥限制, 环视不卡)

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

// ----------------------------------------------------------------------------
// 旁观相机: WASD 自由飞行, 仅用于观察; LOD 始终由上面的 camera(轨道相机)驱动。
// 切到旁观模式时轨道相机冻结, 可从任意角度观察当前细分结构。
// ----------------------------------------------------------------------------
const spectatorCamera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 200000);
const plControls = new PointerLockControls(spectatorCamera, renderer.domElement);
// 用代理相机画 LOD 相机视锥(远平面截到行星附近, 否则视锥会大到铺满屏幕)
const helperCam = new THREE.PerspectiveCamera();
const camHelper = new THREE.CameraHelper(helperCam);
camHelper.visible = false;
scene.add(camHelper);

// 轨道相机(LOD 相机)的位置标记, 旁观模式下显示
const camMarker = new THREE.Mesh(
  new THREE.SphereGeometry(1, 16, 12),
  new THREE.MeshBasicMaterial({ color: 0xff5566 })
);
camMarker.visible = false;
scene.add(camMarker);

function syncHelperCam() {
  helperCam.fov = camera.fov;
  helperCam.aspect = camera.aspect;
  helperCam.near = 0.1;
  helperCam.far = Math.max(camera.position.length(), params.radius * 1.2);
  helperCam.position.copy(camera.position);
  helperCam.quaternion.copy(camera.quaternion);
  helperCam.updateProjectionMatrix();
  helperCam.updateMatrixWorld(true);
  camHelper.update();
  camMarker.position.copy(camera.position);
  camMarker.scale.setScalar(Math.max(2, params.radius * 0.03));
}

// 旁观相机初始摆到侧面观察
spectatorCamera.position.set(260, 130, 220);
spectatorCamera.lookAt(0, 0, 0);

let mainIsSpectator = false;   // false: 主画面=轨道相机, 小窗=旁观相机; true: 互换
const keys = {};
const clock = new THREE.Clock();
const _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _move = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 1, 0);

// 画中画小窗(DOM 覆盖层: 边框 + 标签 + 点击切换; 内部透明, 露出 WebGL 渲染的小窗视口)
const INSET_FRAC = 0.26, INSET_MARGIN = 12;
let insetW = 0, insetH = 0;
const insetEl = document.createElement('div');
insetEl.style.cssText =
  'position:fixed;left:' + INSET_MARGIN + 'px;top:' + INSET_MARGIN + 'px;' +
  'border:2px solid #66ccff;border-radius:4px;box-sizing:border-box;cursor:pointer;z-index:20;overflow:hidden;';
const insetLabel = document.createElement('div');
insetLabel.style.cssText =
  'position:absolute;left:0;bottom:0;width:100%;background:rgba(0,0,0,0.5);color:#cfe8ff;' +
  'font:11px/1.5 monospace;padding:2px 5px;box-sizing:border-box;pointer-events:none;';
insetEl.appendChild(insetLabel);
document.body.appendChild(insetEl);
insetEl.addEventListener('click', (e) => { e.stopPropagation(); swapView(); });

function updateInsetLabel() {
  insetLabel.textContent = mainIsSpectator ? '主相机 · LOD (点击放大)' : '旁观相机 (点击放大)';
}

function layoutInset() {
  insetW = Math.round(innerWidth * INSET_FRAC);
  insetH = Math.round(innerHeight * INSET_FRAC);
  insetEl.style.width = insetW + 'px';
  insetEl.style.height = insetH + 'px';
  insetEl.style.display = params.showInset ? 'block' : 'none';
}
layoutInset();
updateInsetLabel();

function swapView() {
  mainIsSpectator = !mainIsSpectator;
  // 旁观相机做主画面时: 冻结轨道相机(LOD 定格), 显示其视锥框, 允许 WASD 飞行
  controls.enabled = !mainIsSpectator;
  camHelper.visible = mainIsSpectator;
  camMarker.visible = mainIsSpectator;
  if (mainIsSpectator) syncHelperCam();
  else plControls.unlock();
  updateInsetLabel();
}

// 点主画面: 若主画面是旁观相机, 锁定鼠标以便 WASD + 视角控制; ESC 解锁
renderer.domElement.addEventListener('click', () => {
  if (mainIsSpectator && !plControls.isLocked) plControls.lock();
});
addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (mainIsSpectator && plControls.isLocked && e.code === 'Space') e.preventDefault();
});
addEventListener('keyup', (e) => { keys[e.code] = false; });

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

const fSpec = gui.addFolder('旁观相机');
fSpec.add(params, 'showInset').name('小窗预览').onChange(layoutInset);
fSpec.add({ swap: swapView }, 'swap').name('切换主/小窗');
fSpec.add(params, 'spectatorSpeed', 5, 400).name('飞行速度');

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
fLod.add(params, 'frustumMargin', 0, 0.5).name('视锥余量');
fLod.add(params, 'nearRadius', 0, 300).name('预细分半径');

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
  const aspect = innerWidth / innerHeight;
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
  spectatorCamera.aspect = aspect;
  spectatorCamera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  layoutInset();
});

function updateSpectator(dt) {
  if (!plControls.isLocked) return;
  spectatorCamera.getWorldDirection(_fwd);
  _right.crossVectors(_fwd, _worldUp).normalize();
  _move.set(0, 0, 0);
  if (keys['KeyW']) _move.add(_fwd);
  if (keys['KeyS']) _move.sub(_fwd);
  if (keys['KeyD']) _move.add(_right);
  if (keys['KeyA']) _move.sub(_right);
  if (keys['Space']) _move.add(_worldUp);
  if (keys['ShiftLeft'] || keys['ShiftRight']) _move.sub(_worldUp);
  if (_move.lengthSq() > 0) {
    _move.normalize().multiplyScalar(params.spectatorSpeed * dt);
    spectatorCamera.position.add(_move);
  }
}

function renderViews() {
  const w = innerWidth, h = innerHeight;
  const mainCam = mainIsSpectator ? spectatorCamera : camera;
  // 主画面(全屏)
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, w, h);
  renderer.render(scene, mainCam);
  // 小窗(左上角), 独立视口
  if (params.showInset) {
    const insetCam = mainIsSpectator ? camera : spectatorCamera;
    const x = INSET_MARGIN, y = h - insetH - INSET_MARGIN;
    renderer.setScissorTest(true);
    renderer.setViewport(x, y, insetW, insetH);
    renderer.setScissor(x, y, insetW, insetH);
    renderer.render(scene, insetCam);
    renderer.setScissorTest(false);
  }
}

function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();

  if (mainIsSpectator) updateSpectator(dt);
  else controls.update();

  planet.update(camera);   // LOD 始终由轨道相机驱动(旁观相机不影响细分)
  renderViews();

  const s = planet.stats;
  const base = `patch: ${s.patches} · 三角形: ${s.triangles} · 队列: ${s.queued} · 生成中: ${s.inflight}`;
  if (mainIsSpectator) {
    info.innerHTML =
      `旁观相机(主画面) · 点击锁定视角 · WASD 移动 · 空格/Shift 升降 · ESC 释放<br />` +
      `LOD 冻结在轨道相机(白色视锥) · ${base}`;
  } else {
    info.innerHTML =
      `鼠标左键旋转 · 滚轮缩放 · 右键平移 · 点左上小窗切换<br />${base}`;
  }
}
animate();
