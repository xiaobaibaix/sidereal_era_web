// Icosphere Planet + 三角形四叉树 LOD (three.js)
//
// 场景搭建 / 相机 / 光照 / 主循环 / GUI。
// 行星本体(网格生成 + 噪声 + LOD)在 planet.js。

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import GUI from 'lil-gui';
import { Planet } from './planet.js';
import { createOcean, createAtmospherePass } from './effects.js';
import { PlanetWalker } from './character.js';

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

  // 角色模式(登陆行星, 第三人称)
  characterMode: false,
  walkSpeed: 25,
  invertY: true,

  // 外观
  showOcean: true,

  // 大气(瑞利 + 米氏单次散射)
  showAtmosphere: true,
  atmoScale: 1.20,          // 大气顶半径 = radius * atmoScale
  atmoRayleigh: 0.08,       // 瑞利散射强度
  atmoMie: 0.03,            // 米氏散射强度
  atmoMieG: 0.76,           // 米氏前向峰(0.5~0.95)
  atmoDensityFalloff: 6.0,  // 瑞利密度衰减(越大大气越贴地)
  atmoMieFalloff: 16.0,     // 米氏密度衰减
  atmoSunIntensity: 22.0,
  atmoExposure: 1.0,
  atmoSteps: 16,            // 视线积分步数
  atmoLightSteps: 8,        // 太阳方向外散射步数
  atmoShadowSoftness: 0.6,  // 晨昏过渡带宽度(越大越柔和)
  atmoTwilight: 0.3,        // 暮光弧强度(0=辉光贴地表, 1=完整地平下沉, 越大越"上翘")

  // 太阳(方向 = 平行光方向, 同时驱动地形光照/海面高光/大气)
  sunElevation: 35,         // 仰角(度)
  sunAzimuth: 40,           // 方位角(度)
  autoSun: false,           // 自动公转(看日出日落)
  sunSpeed: 6,              // 度/秒

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

  // 结构增强 (Tier 1)
  warpSeed: 777,
  warpStrength: 0.2,      // 域扭曲强度(0=关)
  warpFreq: 1.0,
  plateSeed: 555,
  plateFreq: 1.6,         // Worley 板块频率(越大板块越多越小)
  plateStrength: 0.5,     // 板块边界山脉带强度(0=关)
  moistureSeed: 333,
  moistureFreq: 1.2,
  useClimate: true,       // 气候配色(温湿度→生物群系)
  climateAltRange: 1.0,
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

// 相机状态模型:
//   主体相机 primary = 角色模式 ? 角色 : 轨道; 旁观相机始终是"另一个"(alt)。
//   主画面 = mainIsSpectator ? 旁观 : 主体; 小窗 = 另一个。
//   LOD 永远由主体相机驱动; 控制权只给当前主画面相机(避免滚轮等误操作影响其它相机)。
let characterMode = false;
let walker = null;             // 稍后创建(需要 planet)
let mainIsSpectator = false;   // 旁观相机是否在主画面槽
const keys = {};
const clock = new THREE.Clock();
const _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _move = new THREE.Vector3();
const _worldUp = new THREE.Vector3(0, 1, 0);

function primaryCam() { return characterMode ? walker.camera : camera; }
function mainCam() { return mainIsSpectator ? spectatorCamera : primaryCam(); }
function insetCam() { return mainIsSpectator ? primaryCam() : spectatorCamera; }
function lodCam() { return primaryCam(); }

// 依据当前主画面相机, 独占式启用对应控制, 关闭其它(修复滚轮等误操作影响正常镜头)
function applyControls() {
  const main = mainCam();
  controls.enabled = (main === camera);                       // 轨道控制仅在轨道为主画面
  if (main === spectatorCamera) { if (plControls.connect) plControls.connect(); }
  else { plControls.unlock(); if (plControls.disconnect) plControls.disconnect(); }
  if (walker) walker.setActive(characterMode && main === walker.camera);  // 角色输入仅在角色为主画面
  const showHelper = (!characterMode && main === spectatorCamera);        // 冻结轨道相机时显示其视锥+标记
  camHelper.visible = showHelper;
  camMarker.visible = showHelper;
  if (showHelper) syncHelperCam();
}

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
  if (mainIsSpectator) insetLabel.textContent = (characterMode ? '角色' : '主相机 LOD') + ' (点击放大)';
  else insetLabel.textContent = '旁观相机 (点击放大)';
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
  applyControls();
  updateInsetLabel();
}

// 点主画面: 若主画面是旁观相机, 锁定鼠标控制视角; ESC 解锁(角色的锁定在 character.js 内处理)
renderer.domElement.addEventListener('click', () => {
  if (mainCam() === spectatorCamera && !plControls.isLocked) plControls.lock();
});
addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (mainCam() === spectatorCamera && plControls.isLocked && e.code === 'Space') e.preventDefault();
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

// 海洋(场景内) + 大气(深度感知全屏后处理, 不加入场景)
const ocean = createOcean();
scene.add(ocean);
const atmoPass = createAtmospherePass();

// 场景渲染目标(带深度纹理), 供大气 pass 采样。主画面 + 小窗各一张。
function makeSceneRT(w, h) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
    depthTexture: new THREE.DepthTexture(Math.max(1, w), Math.max(1, h)),
  });
  rt.texture.colorSpace = THREE.SRGBColorSpace;   // 与屏幕一致, 直通不变色
  rt.depthTexture.type = THREE.UnsignedIntType;
  return rt;
}
const _pr = renderer.getPixelRatio();
const rtMain = makeSceneRT(innerWidth * _pr, innerHeight * _pr);
const rtInset = makeSceneRT(1, 1);   // 尺寸随小窗动态调整
const _pv = new THREE.Matrix4();

function resizeSceneRTs() {
  const pr = renderer.getPixelRatio();
  rtMain.setSize(Math.floor(innerWidth * pr), Math.floor(innerHeight * pr));
}
resizeSceneRTs();

// 瑞利散射 RGB 比值(∝ 1/λ⁴, 波长 700/530/440nm), 乘以强度得到散射系数
const RAY_RATIO = new THREE.Vector3(0.1066, 0.3245, 0.6830);

function layoutEffects() {
  const oceanR = params.radius + params.seaLevel * params.maxHeight;
  ocean.scale.setScalar(oceanR);
  ocean.visible = params.showOcean;
  ocean.material.uniforms.uSunDir.value.copy(sun.position).normalize();

  const Rground = params.radius + params.seaLevel * params.maxHeight;
  const Ratmo = params.radius * params.atmoScale;
  const u = atmoPass.uniforms;
  u.uRground.value = Rground;
  u.uRatmo.value = Ratmo;
  u.uDensityFalloff.value = params.atmoDensityFalloff;
  u.uMieFalloff.value = params.atmoMieFalloff;
  u.uScatterR.value.copy(RAY_RATIO).multiplyScalar(params.atmoRayleigh);
  u.uScatterM.value = params.atmoMie;
  u.uMieG.value = params.atmoMieG;
  u.uSunIntensity.value = params.atmoSunIntensity;
  u.uExposure.value = params.atmoExposure;
  u.uSteps.value = params.atmoSteps;
  u.uLightSteps.value = params.atmoLightSteps;
  u.uShadowSoftness.value = params.atmoShadowSoftness;
  u.uTwilight.value = params.atmoTwilight;
}
layoutEffects();

// 太阳方向: 由仰角/方位角算出, 同步到平行光 + 海面 + 大气
function updateSun() {
  const el = THREE.MathUtils.degToRad(params.sunElevation);
  const az = THREE.MathUtils.degToRad(params.sunAzimuth);
  const dir = new THREE.Vector3(
    Math.cos(el) * Math.cos(az),
    Math.sin(el),
    Math.cos(el) * Math.sin(az)
  ).normalize();
  sun.position.copy(dir);
  ocean.material.uniforms.uSunDir.value.copy(dir);
  atmoPass.uniforms.uSunDir.value.copy(dir);
}
updateSun();

// 角色(登陆行星, 第三人称)
walker = new PlanetWalker(planet, renderer.domElement);
scene.add(walker.mesh);
applyControls();   // 初始: 轨道为主画面

function setCharacterMode(on) {
  characterMode = on;
  mainIsSpectator = false;   // 进入角色: 角色为主画面, 旁观在小窗; 退出: 轨道为主画面
  if (on) {
    walker.speed = params.walkSpeed;
    walker.enable(camera.position.clone().normalize());   // 在轨道相机对着的地表处出生
  } else {
    walker.disable();
  }
  applyControls();
  layoutInset();
  updateInsetLabel();
}

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

const fChar = gui.addFolder('角色 (登陆行星)');
fChar.add(params, 'characterMode').name('进入角色模式').onChange((v) => setCharacterMode(v));
fChar.add(params, 'walkSpeed', 5, 120).name('移动速度').onChange((v) => { walker.speed = v; });
fChar.add(params, 'invertY').name('反转上下视角').onChange((v) => { walker.invertY = v; });

const fApp = gui.addFolder('外观');
fApp.add(params, 'showOcean').name('海洋').onChange((v) => { ocean.visible = v; });
fApp.add(params, 'showAtmosphere').name('大气');

const fSun = gui.addFolder('太阳');
fSun.add(params, 'sunElevation', -20, 90).name('仰角°').onChange(updateSun);
const sunAzCtrl = fSun.add(params, 'sunAzimuth', 0, 360).name('方位角°').onChange(updateSun);
fSun.add(params, 'autoSun').name('自动公转(日出日落)');
fSun.add(params, 'sunSpeed', 1, 60).name('公转速度°/s');

const fAtmo = gui.addFolder('大气散射');
fAtmo.add(params, 'atmoScale', 1.02, 1.6).name('大气顶比例').onChange(layoutEffects);
fAtmo.add(params, 'atmoRayleigh', 0, 0.4).name('瑞利强度').onChange(layoutEffects);
fAtmo.add(params, 'atmoMie', 0, 0.2).name('米氏强度').onChange(layoutEffects);
fAtmo.add(params, 'atmoMieG', 0.3, 0.95).name('米氏g(光晕)').onChange(layoutEffects);
fAtmo.add(params, 'atmoDensityFalloff', 1, 20).name('瑞利密度衰减').onChange(layoutEffects);
fAtmo.add(params, 'atmoMieFalloff', 2, 40).name('米氏密度衰减').onChange(layoutEffects);
fAtmo.add(params, 'atmoSunIntensity', 1, 60).name('太阳强度').onChange(layoutEffects);
fAtmo.add(params, 'atmoExposure', 0.2, 4).name('曝光').onChange(layoutEffects);
fAtmo.add(params, 'atmoSteps', 4, 32, 1).name('视线步数').onChange(layoutEffects);
fAtmo.add(params, 'atmoLightSteps', 2, 16, 1).name('太阳步数').onChange(layoutEffects);
fAtmo.add(params, 'atmoShadowSoftness', 0.05, 1.5).name('晨昏柔和度').onChange(layoutEffects);
fAtmo.add(params, 'atmoTwilight', 0.0, 1.0).name('暮光弧(上翘)').onChange(layoutEffects);

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

const fStruct = gui.addFolder('结构增强 (Tier1)');
fStruct.add(params, 'warpStrength', 0, 0.6).name('域扭曲强度').onFinishChange(rebuild);
fStruct.add(params, 'warpFreq', 0.3, 3).name('域扭曲频率').onFinishChange(rebuild);
fStruct.add(params, 'warpSeed', 0, 99999, 1).name('域扭曲种子').onFinishChange(rebuild);
fStruct.add(params, 'plateStrength', 0, 1.2).name('板块带强度').onFinishChange(rebuild);
fStruct.add(params, 'plateFreq', 0.5, 5).name('板块频率').onFinishChange(rebuild);
fStruct.add(params, 'plateSeed', 0, 99999, 1).name('板块种子').onFinishChange(rebuild);
fStruct.add(params, 'useClimate').name('气候配色').onFinishChange(rebuild);
fStruct.add(params, 'moistureFreq', 0.3, 3).name('湿度频率').onFinishChange(rebuild);
fStruct.add(params, 'moistureSeed', 0, 99999, 1).name('湿度种子').onFinishChange(rebuild);
fStruct.add(params, 'climateAltRange', 0.3, 2).name('气候海拔范围').onFinishChange(rebuild);

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
  walker.camera.aspect = aspect;
  walker.camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  resizeSceneRTs();
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

// 渲染一个视口: 场景 → RT(带深度), 再用大气 pass 合成到屏幕对应视口。
function renderView(cam, rt, vpX, vpY, vpW, vpH, scissor) {
  // 1) 场景(行星 + 海洋)渲染到 RT。绑定 RT 后 three 会自动用整张 RT 作为视口。
  renderer.setScissorTest(false);
  renderer.setRenderTarget(rt);
  renderer.clear();
  renderer.render(scene, cam);   // 这一步会刷新 cam.matrixWorldInverse
  renderer.setRenderTarget(null);

  // 2) 大气 pass 合成到屏幕
  const u = atmoPass.uniforms;
  u.tDiffuse.value = rt.texture;
  u.tDepth.value = rt.depthTexture;
  _pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  u.uInvViewProj.value.copy(_pv).invert();
  cam.getWorldPosition(u.uCamPos.value);
  u.uEnabled.value = params.showAtmosphere ? 1.0 : 0.0;

  renderer.setViewport(vpX, vpY, vpW, vpH);
  if (scissor) {
    renderer.setScissorTest(true);
    renderer.setScissor(vpX, vpY, vpW, vpH);
  }
  atmoPass.render(renderer);
  renderer.setScissorTest(false);
}

// 动态近/远裁剪面: 相机离行星越远, 近平面抬得越高 → far/near 比变小, 深度精度大幅提升,
// 消除海洋球与海岸线地形深度几乎相等时的 z-fighting 闪烁。贴近地表(角色)时近平面自动
// 回落到很小, 不裁近处地形。远平面收紧到刚好包住星空(50000)。
const _clipPos = new THREE.Vector3();
function updateClip(cam) {
  cam.getWorldPosition(_clipPos);
  const d = _clipPos.length();                         // 行星在原点
  const clearance = d - (params.radius + params.maxHeight);
  cam.near = THREE.MathUtils.clamp(clearance * 0.4, 0.1, 5000);
  cam.far = Math.max(d + params.radius * 4.0, 60000);
  cam.updateProjectionMatrix();
}
function updateClips() {
  updateClip(camera);
  updateClip(spectatorCamera);
  if (walker) updateClip(walker.camera);
}

function renderViews() {
  const pr = renderer.getPixelRatio();
  const w = innerWidth, h = innerHeight;

  // 主画面(全屏)
  renderView(mainCam(), rtMain, 0, 0, w, h, false);

  // 小窗(左上角): 独立视口 + 独立 RT(尺寸随小窗)
  if (params.showInset) {
    const iw = Math.max(1, Math.floor(insetW * pr));
    const ih = Math.max(1, Math.floor(insetH * pr));
    if (rtInset.width !== iw || rtInset.height !== ih) rtInset.setSize(iw, ih);
    const x = INSET_MARGIN, y = h - insetH - INSET_MARGIN;
    renderView(insetCam(), rtInset, x, y, insetW, insetH, true);
  }
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);   // 限制步长, 防止掉帧时穿地
  const main = mainCam();

  if (params.autoSun) {
    params.sunAzimuth = (params.sunAzimuth + params.sunSpeed * dt) % 360;
    sunAzCtrl.updateDisplay();
    updateSun();
  }

  // 只更新当前主画面相机的控制
  if (main === camera) controls.update();
  else if (main === spectatorCamera) updateSpectator(dt);
  if (characterMode) walker.update(dt);           // 角色始终更新(输入由 active 门控)

  updateClips();                                  // 动态近/远面, 消除 z-fighting
  planet.update(lodCam());                        // LOD 由主体相机(轨道/角色)驱动
  renderViews();

  const s = planet.stats;
  const base = `patch: ${s.patches} · 三角形: ${s.triangles} · 队列: ${s.queued} · 生成中: ${s.inflight}`;
  let hint;
  if (main === spectatorCamera) hint = '旁观相机(主画面) · 点击锁定 · WASD 移动 · 空格/Shift 升降 · ESC 释放';
  else if (walker && main === walker.camera) hint = '角色(主画面) · 点击锁定 · WASD 移动 · 空格跳 · ESC 释放';
  else hint = '鼠标左键旋转 · 滚轮缩放 · 右键平移';
  info.innerHTML = `${hint} · 点左上小窗切换<br />${base}`;
}
animate();
