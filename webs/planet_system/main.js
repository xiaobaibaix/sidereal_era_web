// Icosphere Planet + 三角形四叉树 LOD (three.js)
//
// 场景搭建 / 相机 / 光照 / 主循环 / GUI。
// 行星本体(网格生成 + 噪声 + LOD)在 planet.js。

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import GUI from 'lil-gui';
import { Planet } from '../../src/planet.js';
import { createOcean, createAtmospherePass, createCompositePass, createGodrayPass, createTransmittanceLUT } from '../../src/effects.js';
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
  atmoScale: 1.08,          // 大气顶半径 = radius * atmoScale(≈厚度8%, 接近地球薄大气)
  atmoRayleigh: 0.08,       // 瑞利散射强度
  atmoMie: 0.03,            // 米氏散射强度
  atmoMieG: 0.76,           // 米氏前向峰(0.5~0.95)
  atmoDensityFalloff: 6.0,  // 瑞利密度衰减(越大大气越贴地)
  atmoMieFalloff: 16.0,     // 米氏密度衰减
  atmoSunIntensity: 22.0,
  atmoExposure: 1.0,
  atmoSteps: 24,            // 视线积分步数(越高越少噪点/色带, 越耗性能)
  atmoLightSteps: 8,        // 太阳方向外散射步数
  atmoShadowSoftness: 0.6,  // 晨昏过渡带宽度(越大越柔和)
  atmoTwilight: 0.3,        // 暮光弧强度(0=辉光贴地表, 1=完整地平下沉, 越大越"上翘")
  atmoACES: true,           // true=ACES filmic tonemap, false=Reinhard
  atmoOzone: 0.02,          // 臭氧吸收强度(0=关, 日落品红/天空更纯净蓝)
  atmoDither: 0.5,          // raymarch 抖动强度(去同心圆 banding; 太高会变颗粒噪点)
  atmoLUT: true,            // 透射率 LUT 加速(省太阳方向内循环; 关=实时 raymarch)
  atmoResolutionScale: 0.5, // 大气+云 pass 的(L, T)输出分辨率(地形细节走全分辨率 composite, 不糊; 仅云边缘略软)

  // 体积云(全屏 raymarch pass)
  showClouds: true,
  cloudBottom: 1.01,        // 云底 = radius * 此值
  cloudTop: 1.06,           // 云顶 = radius * 此值
  cloudCoverage: 0.5,       // 覆盖率
  cloudDensity: 1.2,        // 密度(消光)
  cloudFreq: 0.06,          // 噪声频率(越大越碎)
  cloudWarp: 0.5,           // 域扭曲(飘逸)
  cloudWindSpeed: 0.6,      // 飘动速度
  cloudSteps: 24,           // 云壳内细步数(视线穿过云层时的采样密度; 越高云越细腻越耗)
  cloudLightSteps: 6,       // 太阳方向步数
  cloudAbsorb: 1.0,         // 自阴影强度
  cloudSilver: 1.0,         // 银边(前向散射)强度
  cloudPowder: 0.6,         // powder 暗边强度
  cloudShadow: 0.7,         // 云影投到地表强度(0=关)

  // 体积光 God rays(屏幕空间光束)
  showGodrays: true,
  godrayStrength: 0.6,      // 光束强度
  godrayDensity: 0.7,       // 扩散
  godraySamples: 48,        // 采样数
  godrayThreshold: 0.45,    // 亮度阈值

  // 太阳(方向 = 平行光方向, 同时驱动地形光照/海面高光/大气)
  sunElevation: 35,         // 仰角(度)
  sunAzimuth: 40,           // 方位角(度)
  autoSun: false,           // 自动公转(看日出日落)
  sunSpeed: 6,              // 度/秒

  // LOD
  maxLevel: 10,            // 四叉树最大细分层数
  splitFactor: 2.5,        // 相机距离 < 边长*splitFactor 时细分(越大越激进)
  patchResolution: 16,     // 每个 patch 的网格分辨率(必须是 2 的幂, 缝合依赖 dyadic 嵌套)
  frustumMargin: 0.15,     // 视锥外扩余量(屏幕外预细分一圈, 减少旋转 pop-in)
  nearRadius: 50,          // 相机周围此半径内一律细分(不受视锥限制, 环视不卡)
  splitBudget: 16,         // 每帧新分裂上限(防止靠近时 worker 队列暴涨)
  mergeHysteresis: 1.15,   // 合并阈值 = splitFactor × 此值(避免边界 churn)
  horizonCulling: true,    // 地平线剔除(跳过行星本体背面的 chunk)

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

// powerPreference: 'high-performance' — 在双 GPU 机器(独显+集显)上请求用独显,
// 否则浏览器默认走集显省电。注意这只是"提示", 最终仍受系统图形设置/驱动控制。
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
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

// 角色模式下滚轮调相机距离(轨道模式滚轮由 OrbitControls 自己处理)
addEventListener('wheel', (e) => {
  if (!characterMode || !walker) return;
  const step = Math.sign(e.deltaY) * Math.max(1, walker.camDist * 0.1);
  walker.camDist = THREE.MathUtils.clamp(walker.camDist + step, 4, 500);
}, { passive: true });

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
    type: THREE.HalfFloatType,            // HDR: 保留 >1 的高光, 供大气 pass 做 tonemap
  });
  rt.texture.colorSpace = THREE.LinearSRGBColorSpace;  // 场景以线性 HDR 写入(不提前编码)
  rt.depthTexture.type = THREE.UnsignedIntType;
  return rt;
}
// 大气/God rays 的中转 RT(HalfFloat 线性, 无深度): 场景→rtScene→大气(含云, 输出 L+T)→rtLit→composite→God rays→屏幕
// 注: 云不再单独成 pass, 而是与大气在同一条 raymarch 里统一积分(uCloudsOn=1)。
function makeColorRT(w, h) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    type: THREE.HalfFloatType,
  });
  rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
  return rt;
}
// 同上但 RGBA(存 L+T.gray): 大气 pass 输出 vec4(L.rgb, T.gray), 半分辨率
function makeColorRT4(w, h) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
  });
  rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
  return rt;
}

const godrayPass = createGodrayPass();
const compositePass = createCompositePass();   // 全分辨率合成: rtMain + rtLit(L+T) → rtComposite
// 升采样 blit pass: 全分辨率 rtComposite → 屏幕视口(God rays 关时的直通路径)
const blitPass = (() => {
  const u = { tLit: { value: null } };
  const mat = new THREE.ShaderMaterial({
    uniforms: u,
    depthTest: false, depthWrite: false,
    vertexShader: /* glsl */`varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */`precision highp float; varying vec2 vUv; uniform sampler2D tLit;
      void main() { gl_FragColor = texture2D(tLit, vUv); }`,
  });
  const s = new THREE.Scene(); const c = new THREE.Camera();
  const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat); q.frustumCulled = false; s.add(q);
  return { uniforms: u, material: mat, render(renderer) { renderer.render(s, c); } };
})();
const transLUT = createTransmittanceLUT();
// 透射率 LUT 目标(x=太阳天顶余弦, y=高度), 大气参数变化时重烘
const lutRT = new THREE.WebGLRenderTarget(256, 64, {
  type: THREE.HalfFloatType, depthBuffer: false,
  minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
});
lutRT.texture.colorSpace = THREE.LinearSRGBColorSpace;
atmoPass.uniforms.uTransLUT.value = lutRT.texture;
atmoPass.uniforms.uOutputLT.value = 1.0;   // LT 模式: 半分辨率输出 (L, T.gray), 由 composite 全分辨率合成

const _pr = renderer.getPixelRatio();
const rtMain = makeSceneRT(innerWidth * _pr, innerHeight * _pr);
const rtInset = makeSceneRT(1, 1);   // 尺寸随小窗动态调整
// rtLit = 半分辨率 (L, T.gray) 缓冲, 由 atmoPass 输出; composite 在全分辨率上把它和 rtMain 合成
const rtLitMain = makeColorRT4(1, 1);
const rtLitInset = makeColorRT4(1, 1);
// rtComposite = 全分辨率合成结果(线性 HDR + tonemap 后), 供 God rays 或直接到屏幕
const rtCompositeMain = makeColorRT(innerWidth * _pr, innerHeight * _pr);
const rtCompositeInset = makeColorRT(1, 1);
const _sunProj = new THREE.Vector3(), _camFwd = new THREE.Vector3();
const _pv = new THREE.Matrix4();
const _invVP = new THREE.Matrix4();
const _camPos = new THREE.Vector3();

function resizeSceneRTs() {
  const pr = renderer.getPixelRatio();
  const w = Math.floor(innerWidth * pr), h = Math.floor(innerHeight * pr);
  rtMain.setSize(w, h);
  rtCompositeMain.setSize(w, h);                       // composite 走全分辨率, 保留地形细节
  // 大气+云 pass 渲染分辨率(只 L+T 半分辨率, scene*T 在 composite 全分辨率上做 → 不糊地形)
  const sw = Math.max(1, Math.floor(w * params.atmoResolutionScale));
  const sh = Math.max(1, Math.floor(h * params.atmoResolutionScale));
  rtLitMain.setSize(sw, sh);
}
resizeSceneRTs();

// 瑞利散射 RGB 比值(∝ 1/λ⁴, 波长 700/530/440nm), 乘以强度得到散射系数
const RAY_RATIO = new THREE.Vector3(0.1066, 0.3245, 0.6830);
// 臭氧吸收 RGB 比值(绿最强, 蓝最弱; 归一到绿=1), 乘以强度得到吸收系数
const OZONE_RATIO = new THREE.Vector3(0.35, 1.0, 0.045);

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
  u.uTonemap.value = params.atmoACES ? 1 : 0;
  u.uOzone.value.copy(OZONE_RATIO).multiplyScalar(params.atmoOzone);
  u.uDither.value = params.atmoDither;
  u.uUseLUT.value = params.atmoLUT ? 1.0 : 0.0;

  // 重烘透射率 LUT(依赖半径/大气顶/密度衰减)
  const lu = transLUT.uniforms;
  lu.uRground.value = Rground;
  lu.uRatmo.value = Ratmo;
  lu.uDensityFalloff.value = params.atmoDensityFalloff;
  lu.uMieFalloff.value = params.atmoMieFalloff;
  transLUT.render(renderer, lutRT);

  // 云层 uniforms(与大气统一积分: uCloudsOn=1 时大气 pass 在同一 raymarch 里叠云,
  // 不再单独跑云 pass, 消除“云底硬切大气”的分界线)
  u.uCloudsOn.value = params.showClouds ? 1.0 : 0.0;
  u.uBottom.value = params.radius * params.cloudBottom;
  u.uTop.value = params.radius * params.cloudTop;
  u.uCoverage.value = params.cloudCoverage;
  u.uCloudDensity.value = params.cloudDensity;
  u.uFreq.value = params.cloudFreq / params.radius * 100.0;   // 频率随半径归一(基准 radius=100)
  u.uWarp.value = params.cloudWarp;
  u.uWindSpeed.value = params.cloudWindSpeed;
  u.uCloudLightSteps.value = params.cloudLightSteps;
  u.uAbsorb.value = params.cloudAbsorb;
  u.uSilver.value = params.cloudSilver;
  u.uPowder.value = params.cloudPowder;
  u.uCloudShadow.value = params.cloudShadow;
  // 步数: 大气段用 atmoSteps(粗步); 云壳段用 cloudSteps(细步, 保云细节)。二者在同一条 march 里连续积分。
  u.uSteps.value = params.atmoSteps;
  u.uCloudSteps.value = params.cloudSteps;

  // God rays uniforms
  const g = godrayPass.uniforms;
  g.uStrength.value = params.godrayStrength;
  g.uDensity.value = params.godrayDensity;
  g.uSamples.value = params.godraySamples;
  g.uThreshold.value = params.godrayThreshold;
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
  atmoPass.uniforms.uSunDir.value.copy(dir);   // 云已并入大气 pass, 共用此方向
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

// 记录上次半径, 半径变化时按比例缩放相机到球心的距离(保持方向/构图), 避免相机卡进球里
let lastRadius = params.radius;
function rebuild() {
  const ratio = params.radius / lastRadius;
  if (isFinite(ratio) && ratio > 0 && Math.abs(ratio - 1) > 1e-6) {
    camera.position.multiplyScalar(ratio);          // 轨道相机(target 为球心)按比例外扩
    spectatorCamera.position.multiplyScalar(ratio);  // 旁观相机同步
  }
  lastRadius = params.radius;

  planet.rebuild();
  controls.minDistance = params.radius + params.maxHeight * 2.5;
  controls.maxDistance = Math.max(8000, params.radius * 40);
  controls.update();
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
fAtmo.add(params, 'atmoACES').name('ACES 电影色调').onChange(layoutEffects);
fAtmo.add(params, 'atmoOzone', 0.0, 0.1).name('臭氧(日落品红)').onChange(layoutEffects);
fAtmo.add(params, 'atmoDither', 0.0, 1.0).name('抖动去带').onChange(layoutEffects);
fAtmo.add(params, 'atmoLUT').name('LUT 加速').onChange(layoutEffects);
fAtmo.add(params, 'atmoResolutionScale', 0.25, 1.0, 0.05).name('大气渲染比例(性能↑)').onChange(resizeSceneRTs);

const fCloud = gui.addFolder('体积云');
fCloud.add(params, 'showClouds').name('云层开关').onChange(layoutEffects);
fCloud.add(params, 'cloudCoverage', 0.0, 1.0).name('覆盖率').onChange(layoutEffects);
fCloud.add(params, 'cloudDensity', 0.1, 4.0).name('密度').onChange(layoutEffects);
fCloud.add(params, 'cloudFreq', 0.01, 0.2).name('噪声频率').onChange(layoutEffects);
fCloud.add(params, 'cloudWarp', 0.0, 1.5).name('域扭曲(飘逸)').onChange(layoutEffects);
fCloud.add(params, 'cloudWindSpeed', 0.0, 3.0).name('飘动速度').onChange(layoutEffects);
fCloud.add(params, 'cloudBottom', 1.0, 1.1).name('云底比例').onChange(layoutEffects);
fCloud.add(params, 'cloudTop', 1.02, 1.2).name('云顶比例').onChange(layoutEffects);
fCloud.add(params, 'cloudAbsorb', 0.2, 3.0).name('自阴影强度').onChange(layoutEffects);
fCloud.add(params, 'cloudSteps', 8, 48, 1).name('云层步数').onChange(layoutEffects);
fCloud.add(params, 'cloudLightSteps', 2, 12, 1).name('光照步数').onChange(layoutEffects);
fCloud.add(params, 'cloudSilver', 0.0, 3.0).name('银边(前向散射)').onChange(layoutEffects);
fCloud.add(params, 'cloudPowder', 0.0, 1.0).name('powder 暗边').onChange(layoutEffects);
fCloud.add(params, 'cloudShadow', 0.0, 1.0).name('云影投地表').onChange(layoutEffects);

const fGod = gui.addFolder('体积光 God rays');
fGod.add(params, 'showGodrays').name('开关');
fGod.add(params, 'godrayStrength', 0.0, 2.0).name('强度').onChange(layoutEffects);
fGod.add(params, 'godrayDensity', 0.2, 1.2).name('扩散').onChange(layoutEffects);
fGod.add(params, 'godrayThreshold', 0.0, 1.0).name('亮度阈值').onChange(layoutEffects);
fGod.add(params, 'godraySamples', 16, 96, 1).name('采样数').onChange(layoutEffects);

const fLod = gui.addFolder('LOD');
fLod.add(params, 'maxLevel', 0, 14, 1).name('最大层数');
fLod.add(params, 'splitFactor', 1, 5).name('细分激进度');
fLod.add(params, 'patchResolution', [4, 8, 16, 32]).name('patch 分辨率').onChange(rebuild);
fLod.add(params, 'frustumMargin', 0, 0.5).name('视锥余量');
fLod.add(params, 'nearRadius', 0, 300).name('预细分半径');
fLod.add(params, 'splitBudget', 1, 64, 1).name('每帧分裂预算');
fLod.add(params, 'mergeHysteresis', 1.0, 2.0, 0.05).name('合并滞回');
fLod.add(params, 'horizonCulling').name('地平线剔除');

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
// 参数预设: 自动持久化到 localStorage(刷新后自动恢复) + 导出/导入 JSON + 重置默认
// ----------------------------------------------------------------------------
const DEFAULTS = JSON.parse(JSON.stringify(params));   // 启动时的代码默认值(供重置)
const LS_KEY = 'planet.params.v1';
const NO_PERSIST = ['characterMode'];                  // 运行态, 不持久化

function collectParams() {
  const o = {};
  for (const k in params) if (!NO_PERSIST.includes(k)) o[k] = params[k];
  return o;
}
function saveParams() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(collectParams())); } catch (e) { /* 隐私模式等 */ }
}
// 把一组参数应用到 params 并驱动场景全部刷新
function applyParams(src) {
  for (const k in src) if (k in params && !NO_PERSIST.includes(k)) params[k] = src[k];
  gui.controllersRecursive().forEach((c) => c.updateDisplay());   // 同步滑块显示
  planet.setWireframe(params.wireframe);
  if (walker) { walker.speed = params.walkSpeed; walker.invertY = params.invertY; }
  updateSun();
  rebuild();          // 重建地形 + layoutEffects(海洋/大气全部 uniform)
  layoutInset();
}
function loadParams() {
  try {
    const s = localStorage.getItem(LS_KEY);
    if (s) { applyParams(JSON.parse(s)); return true; }
  } catch (e) { /* 忽略损坏数据 */ }
  return false;
}
function resetParams() { applyParams(DEFAULTS); saveParams(); }

// 项目内置预设文件(可提交到 git, 跟着项目走)。用服务器根绝对路径(/presets/), 因页面已挪到 webs/ 下, 相对路径会算错。
const PRESET_URL = '/presets/default.json';
async function loadProjectPreset() {
  try {
    const res = await fetch(PRESET_URL, { cache: 'no-store' });
    if (!res.ok) return false;
    applyParams(await res.json());
    return true;
  } catch (e) { return false; }
}
function exportParams() {
  const blob = new Blob([JSON.stringify(collectParams(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'planet-params.json';
  a.click();
  URL.revokeObjectURL(url);
}
function importParams() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'application/json,.json';
  inp.onchange = () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try { applyParams(JSON.parse(r.result)); saveParams(); }
      catch (e) { alert('参数文件解析失败: ' + e.message); }
    };
    r.readAsText(f);
  };
  inp.click();
}

// 项目预设: 直接读写 three_planet/presets/(需用 serve.py 启动才能"保存到项目")
const projState = { name: 'default', selected: '' };
let projLoadCtrl = null;

function attachProjDropdown(opts) {
  const list = opts.length ? opts : ['(无)'];
  projLoadCtrl = projLoadCtrl ? projLoadCtrl.options(list) : fPreset.add(projState, 'selected', list);
  projLoadCtrl.name('项目预设 → 选择加载').onChange((v) => {
    if (v && v !== '(无)') loadProjectNamed(v);
  });
}
async function refreshPresetList() {
  try {
    const res = await fetch('/api/presets', { cache: 'no-store' });
    if (!res.ok) throw new Error();
    const { presets } = await res.json();
    attachProjDropdown(presets);
    return true;
  } catch (e) { return false; }   // 后端不可用(普通静态服务器): 保持占位
}
async function loadProjectNamed(name) {
  try {
    const res = await fetch('/presets/' + encodeURIComponent(name) + '.json', { cache: 'no-store' });
    if (res.ok) { applyParams(await res.json()); saveParams(); }
  } catch (e) { /* ignore */ }
}
async function saveToProject() {
  const name = (projState.name || 'default').trim();
  try {
    const res = await fetch('/api/presets/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, params: collectParams() }),
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok) { projState.selected = name; await refreshPresetList(); }
    else alert('保存失败: ' + (j.error || res.status));
  } catch (e) {
    alert('“保存到项目”需要用 serve.py 启动服务器:\n  python3 serve.py\n(当前是只读静态服务器)');
  }
}

const fPreset = gui.addFolder('参数预设');
fPreset.add(projState, 'name').name('预设名(存到项目)');
fPreset.add({ f: saveToProject }, 'f').name('▸ 保存到项目 presets/');
attachProjDropdown([]);        // 占位, 启动后由 refreshPresetList 填充
fPreset.add({ f: refreshPresetList }, 'f').name('刷新项目预设列表');
fPreset.add({ f: () => saveParams() }, 'f').name('保存到浏览器');
fPreset.add({ f: () => { loadProjectPreset().then(saveParams); } }, 'f').name('加载 default.json');
fPreset.add({ f: resetParams }, 'f').name('重置为出厂默认');
fPreset.add({ f: exportParams }, 'f').name('导出 JSON(下载)');
fPreset.add({ f: importParams }, 'f').name('导入 JSON(上传)');

// 启动加载顺序: 浏览器上次调的(localStorage) > 项目内置预设(default.json) > 代码默认。
// 只要没在本地改过参数, 每次都会拿最新的 default.json; 一旦调过则以本地为准。
(async function initParams() {
  if (!loadParams()) await loadProjectPreset();
  await refreshPresetList();
  gui.onFinishChange(() => saveParams());   // 之后每次调完自动持久化
})();

// ----------------------------------------------------------------------------
// 主循环
// ----------------------------------------------------------------------------
const info = document.getElementById('info');

// FPS: 0.5s 滑动窗口(frames / 累计时长), 比 1/dt 稳、比 EMA 直观
let fpsFrames = 0, fpsAccum = 0, fpsValue = 0;

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
  // 地表夹紧: 防止飞入行星内部(内部看 FrontSide 会把面朝外的表面全部剔除, 只剩裙边墙)
  const pos = spectatorCamera.position;
  const r = pos.length();
  if (r > 1e-4) {
    const inv = 1 / r;
    const nx = pos.x * inv, ny = pos.y * inv, nz = pos.z * inv;
    const groundR = params.radius + planet.heightAt(nx, ny, nz) * params.maxHeight + 2;
    if (r < groundR) pos.set(nx * groundR, ny * groundR, nz * groundR);
  }
}

// 渲染一个视口: 场景 → RT(带深度) → 大气 pass(半分辨率输出 L+T) → composite(全分辨率合成)→ God rays/屏幕。
function renderView(cam, rt, rtLit, rtComposite, vpX, vpY, vpW, vpH, scissor) {
  // 1) 场景(行星 + 海洋)渲染到 RT(全分辨率, 带深度)。
  renderer.setScissorTest(false);
  renderer.setRenderTarget(rt);
  renderer.clear();
  renderer.render(scene, cam);   // 这一步会刷新 cam.matrixWorldInverse
  renderer.setRenderTarget(null);

  // 相机矩阵(大气 pass 共用)
  _pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  _invVP.copy(_pv).invert();
  cam.getWorldPosition(_camPos);

  // 2) 大气 pass(云已并入同一 raymarch)。半分辨率输出 (L, T.gray) 到 rtLit。
  //    rtLit 尺寸在 resizeSceneRTs 中按 atmoResolutionScale 缩放(半分辨率时像素数 1/4, raymarch 大幅加速)。
  const u = atmoPass.uniforms;
  u.tDiffuse.value = rt.texture;
  u.tDepth.value = rt.depthTexture;
  u.uInvViewProj.value.copy(_invVP);
  u.uCamPos.value.copy(_camPos);
  u.uEnabled.value = params.showAtmosphere ? 1.0 : 0.0;

  renderer.setRenderTarget(rtLit);
  atmoPass.render(renderer);
  renderer.setRenderTarget(null);

  // 3) composite pass(全分辨率): rtMain(场景线性 HDR) × T(半分辨率双线性) + L(半分辨率) → tonemap → rtComposite
  //    地形细节(高频边缘)在 scene*T 中保留全分辨率锐度; 只有软效果(L, T)承受半分辨率插值。
  const cu = compositePass.uniforms;
  cu.tScene.value = rt.texture;
  cu.tAtmo.value = rtLit.texture;
  cu.uExposure.value = params.atmoExposure;
  cu.uTonemap.value = params.atmoACES ? 1 : 0;
  renderer.setRenderTarget(rtComposite);
  compositePass.render(renderer);
  renderer.setRenderTarget(null);

  renderer.setViewport(vpX, vpY, vpW, vpH);
  if (scissor) { renderer.setScissorTest(true); renderer.setScissor(vpX, vpY, vpW, vpH); }

  if (params.showGodrays) {
    // God rays 读全分辨率 rtComposite(自然清晰), 加光束
    const g = godrayPass.uniforms;
    g.tLit.value = rtComposite.texture;
    _sunProj.copy(sun.position).multiplyScalar(1e7).project(cam);
    g.uSunUV.value.set(_sunProj.x * 0.5 + 0.5, _sunProj.y * 0.5 + 0.5);
    cam.getWorldDirection(_camFwd);
    g.uSunVis.value = THREE.MathUtils.smoothstep(_camFwd.dot(sun.position), 0.0, 0.35);
    godrayPass.render(renderer);
  } else {
    // 直接把 rtComposite 显示到屏幕视口(全分辨率, 锐)
    blitPass.uniforms.tLit.value = rtComposite.texture;
    blitPass.render(renderer);
  }
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
  renderView(mainCam(), rtMain, rtLitMain, rtCompositeMain, 0, 0, w, h, false);

  // 小窗(左上角): 独立视口 + 独立 RT(尺寸随小窗)
  if (params.showInset) {
    const iw = Math.max(1, Math.floor(insetW * pr));
    const ih = Math.max(1, Math.floor(insetH * pr));
    if (rtInset.width !== iw || rtInset.height !== ih) {
      rtInset.setSize(iw, ih);
      rtCompositeInset.setSize(iw, ih);   // composite 走全分辨率(同场景 RT)
    }
    const sw = Math.max(1, Math.floor(iw * params.atmoResolutionScale));
    const sh = Math.max(1, Math.floor(ih * params.atmoResolutionScale));
    if (rtLitInset.width !== sw || rtLitInset.height !== sh) {
      rtLitInset.setSize(sw, sh);         // rtLit 半分辨率(L+T)
    }
    const x = INSET_MARGIN, y = h - insetH - INSET_MARGIN;
    renderView(insetCam(), rtInset, rtLitInset, rtCompositeInset, x, y, insetW, insetH, true);
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

  atmoPass.uniforms.uTime.value = clock.elapsedTime;   // 云飘动(云已并入大气 pass)
  updateClips();                                  // 动态近/远面, 消除 z-fighting
  // 角色模式: LOD 追踪角色本身(walker.position), 相机绕角色转时不会触发 chunk 重新细分
  planet.update(lodCam(), characterMode && walker ? walker.position : null);
  renderViews();

  const s = planet.stats;
  // FPS 累计: 满 0.5s 结算一次, 避免每帧抖动
  fpsFrames++; fpsAccum += dt;
  if (fpsAccum >= 0.5) { fpsValue = fpsFrames / fpsAccum; fpsFrames = 0; fpsAccum = 0; }
  const base = `FPS: ${fpsValue.toFixed(0)} · patch: ${s.patches} · 三角形: ${s.triangles} · 队列: ${s.queued} · 生成中: ${s.inflight}`;
  let hint;
  if (main === spectatorCamera) hint = '旁观相机(主画面) · 点击锁定 · WASD 移动 · 空格/Shift 升降 · ESC 释放';
  else if (walker && main === walker.camera) hint = '角色(主画面) · 点击锁定 · WASD 移动 · 空格跳 · ESC 释放';
  else hint = '鼠标左键旋转 · 滚轮缩放 · 右键平移';
  info.innerHTML = `${hint} · 点左上小窗切换<br />${base}`;
}
animate();
