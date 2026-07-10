// 太阳系 P1 — N-body 物理内核可视化(独立于主行星项目)。
//
// float64 物理(nbody.js) + 浮动原点渲染: 每帧把所有天体减去"聚焦天体"的位置, 送进 GPU 的
// 只是聚焦点附近的小坐标 → 即使真实坐标很大也不丢精度。对数深度处理巨大景深。
// GUI 可调 G(演示: 同质量下调 G → 轨道整体缩放)、时间倍率、软化、聚焦切换、轨迹、暂停。

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import GUI from 'lil-gui';
import { Body, NBodySystem } from './nbody.js';
import { Planet } from '../../src/planet.js';       // 复用主项目的 LOD 地形行星(近距详细表现)
import { PlanetWalker } from '../planet_system/character.js';   // 复用主项目的登陆行星角色控制器
import { createAtmospherePass, createCloudPass, createOcean, createGasGiant } from '../../src/effects.js';   // 复用深度感知大气 + 体积云 + 海洋 海洋

// ----------------------------------------------------------------------------
// 星系配置(初始条件; 之后可纳入预设)
// ----------------------------------------------------------------------------
// 卫星距离用"希尔半径的比例"给(hillFrac≤~0.35 才稳定), 保证在行星引力主导区内,
// 不会被恒星剥离。质量比选得让行星 Hill 球足够大以容纳可见卫星。
const CONFIG = {
  softening: 2,
  star: { name: '恒星', mass: 2e5, radius: 60, color: 0xffcc66 },
  planets: [
    { name: '行星1', mass: 1400, radius: 13, dist: 600, phase: 0.0, incl: 0.0, color: 0x4aa3ff, moons: [
      { name: '卫星1a', mass: 2, radius: 3, hillFrac: 0.30, phase: 0.0, incl: 0.3, color: 0xcfcfcf },
    ] },
    { name: '行星2', mass: 2600, radius: 20, dist: 1150, phase: 1.9, incl: 0.05, color: 0xff7a44, moons: [
      { name: '卫星2a', mass: 4, radius: 4.5, hillFrac: 0.24, phase: 0.5, incl: 0.2, color: 0xdddddd },
      { name: '卫星2b', mass: 2, radius: 3.5, hillFrac: 0.34, phase: 2.4, incl: -0.22, color: 0xa9b4d0 },
    ] },
    { name: '行星3', mass: 1600, radius: 16, dist: 1850, phase: 3.6, incl: 0.02, color: 0x66d9a6, moons: [] },
    { name: '行星4', mass: 5200, radius: 34, dist: 2650, phase: 5.1, incl: 0.03, color: 0xd9b38c, moons: [
      { name: '卫星4a', mass: 3, radius: 4, hillFrac: 0.22, phase: 1.1, incl: 0.15, color: 0xcbb8a0 },
    ] },
  ],
  // 小行星带(绕恒星, 在行星2与行星3之间) + 行星环(绕某行星)。都是测试粒子。
  belt: { count: 1600, inner: 1380, outer: 1620, thickness: 28 },
  ring: { planet: '行星2', count: 1400, inner: 30, outer: 46, thickness: 2.5, tilt: 0.4 },
};

const params = {
  G: 2.0,
  timeScale: 1.0,     // 模拟速度倍率
  softening: 2,
  paused: false,
  orbits: true,
  showBelt: true,
  detail: true,        // 近距 LOD 地形行星(常驻)
  detailAtmo: true,    // 近距行星大气(总开关)
  detailClouds: true,  // 近距行星体积云(总开关)
  wireframe: 'off',    // 线框模式: 'off' 关 / 'current' 仅当前聚焦行星 / 'all' 全部行星
  worldScale: 1,       // 全局尺度: 距离/半径×S, 质量×S³(轨道周期不变) → 试 1e6 米级
  character: false,    // 角色模式: 登陆当前聚焦的地形星球, 第三人称行走
  focus: '恒星',
};

const ORBIT_SEG = 192;   // 每条轨道椭圆的采样段数

// ----------------------------------------------------------------------------
// three 基础
// ----------------------------------------------------------------------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x03040a);

// 标准深度 + 每帧动态 near/far(见 updateCameraRange): 浮动原点把聚焦天体放到原点, 相机绕它转,
// 透视深度精度天然集中在近平面 → 聚焦行星表面精度极好, 远处天体(小圆点)精度差但无感。
// 这样无需改任何 shader(大气/云/海洋 pass 用 camera.projectionMatrix, 自动跟随)即可支持 1e6 米级。
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.5, 20000);
camera.position.set(0, 1600, 3800);

// powerPreference: 'high-performance' — 在双 GPU 机器(独显+集显)上请求用独显,
// 否则浏览器默认走集显省电。注意这只是"提示", 最终仍受系统图形设置/驱动控制。
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 20;
controls.maxDistance = 5e6;

// 角色模式(登陆聚焦星球): 复用主项目的 PlanetWalker。角色模式下用角色相机接管渲染 + LOD。
let walker = null;      // 懒创建: 首次进入时绑定当前聚焦行星的 LOD 地形
let charMode = false;
function renderCam() { return (charMode && walker) ? walker.camera : camera; }

// 不加环境光: 只有太阳(点光源)照亮天体 → 背向太阳的一面是暗的(真实昼夜), 不再被环境光提亮。
const sunLight = new THREE.PointLight(0xffffff, 3.5, 0, 0);   // decay=0: 全系统可见(P1 不追求光照真实)
scene.add(sunLight);

// 星空背景(单位球; 每帧跟随相机并缩放到 far 附近 → 任意尺度下都像无限远的天幕, 固定屏幕像素大小)
let starField;
(function stars() {
  const g = new THREE.BufferGeometry();
  const n = 2000, p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3().randomDirection();   // 单位球面
    p[i * 3] = v.x; p[i * 3 + 1] = v.y; p[i * 3 + 2] = v.z;
  }
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  starField = new THREE.Points(g, new THREE.PointsMaterial({ color: 0x8899aa, size: 1.8, sizeAttenuation: false }));
  starField.frustumCulled = false;
  scene.add(starField);
})();

// ----------------------------------------------------------------------------
// 深度感知大气(全屏 pass): 场景 → HDR RT(带深度) → 大气 pass → 屏幕
// ----------------------------------------------------------------------------
const RAY_ATMO = new THREE.Vector3(0.1066, 0.3245, 0.6830);   // 瑞利比值(∝1/λ⁴)
function makeSceneRT(w, h) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    type: THREE.HalfFloatType, depthBuffer: true,
    depthTexture: new THREE.DepthTexture(Math.max(1, w), Math.max(1, h)),
  });
  rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
  rt.depthTexture.type = THREE.UnsignedIntType;
  return rt;
}
// 仅颜色的 HDR 半浮点 RT(多行星大气 ping-pong 中间缓冲; 无需深度, 大气 pass depthTest=false)
function makeHDRColorRT(w, h) {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    type: THREE.HalfFloatType, depthBuffer: false,
  });
  rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
  return rt;
}
const _spr = renderer.getPixelRatio();
const sceneRT = makeSceneRT(innerWidth * _spr, innerHeight * _spr);
const rtPing = makeHDRColorRT(innerWidth * _spr, innerHeight * _spr);
const rtPong = makeHDRColorRT(innerWidth * _spr, innerHeight * _spr);
const atmoPass = createAtmospherePass();
const cloudPass = createCloudPass();       // 体积云(插在 场景→大气 之间; 只给最近一颗启用云的行星跑)
const OZONE_BASE = new THREE.Vector3(0.0035, 0.010, 0.00045);
const bodyEdit = { radius: 20 };   // 聚焦天体半径(GUI 编辑用)
// 大气可调参数(渲染循环每帧读取 → GUI 实时生效)
const atm = {
  enabled: true,      // 本星球是否启用大气(每天体独立; 存入 body.cfg.atm)
  tint: [1, 1, 1],    // 大气色调(乘到瑞利系数上; 0..1, 用来做暖色/冷色天空)
  scale: 1.08, rayleigh: 1.0, mie: 1.0, mieG: 0.76,
  densityFalloff: 6.0, mieFalloff: 16.0, sunIntensity: 22.0, exposure: 1.0,
  shadowSoftness: 0.6, twilight: 0.3, ozone: 1.0, dither: 0.5, steps: 16, lightSteps: 8, aces: true,
};
// 近距体积云(每天体独立; 存入 body.cfg.cloud)。云壳在地表上方 [bottomFrac, topFrac]×半径 之间。
// 只给最近的一颗启用云的行星跑(体积 raymarch 很贵)。freq 会按半径归一(∝1/R)。
const cloud = {
  enabled: false,
  coverage: 0.5, density: 1.2,
  bottomFrac: 1.012, topFrac: 1.06,
  freq: 0.06, windSpeed: 0.6,
  silver: 1.0, powder: 0.6, cloudShadow: 0.7,
  steps: 24, lightSteps: 6,
};
(function initAtmoStatics() {
  const u = atmoPass.uniforms;
  u.uPlanetCenter.value.set(0, 0, 0);
  u.uUseLUT.value = 0.0;                 // 直接 raymarch(免 LUT 预烘)
  const dummy = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);   // 避免空 sampler
  dummy.needsUpdate = true;
  u.uTransLUT.value = dummy;
})();
const _pv = new THREE.Matrix4();
const _ivp = new THREE.Matrix4();       // 逆 view-proj(大气/云 pass 共用)
const _camW = new THREE.Vector3();      // 相机世界坐标(共用)
const _tintV = new THREE.Vector3();     // 大气色调临时向量(避免每帧分配)

// 把某颗详细行星的大气参数写入大气 pass 的 uniforms(用它自己的渲染位置 + 半径 + atm 配置)。
// 散射系数 ∝ 1/半径 → 不同尺度的行星大气厚度自动归一。
function applyAtmoUniforms(u, body, planet, a) {
  const R = body.radius;
  u.uPlanetCenter.value.copy(planet.position);   // 渲染空间的行星中心(= body.pos - _off)
  u.uEnabled.value = 1.0;
  u.uRground.value = R;
  u.uRatmo.value = R * a.scale;
  const t = a.tint || [1, 1, 1];
  u.uScatterR.value.copy(RAY_ATMO).multiplyScalar(8.0 / R * a.rayleigh).multiply(_tintV.set(t[0], t[1], t[2]));
  u.uScatterM.value = 3.0 / R * a.mie;
  u.uOzone.value.copy(OZONE_BASE).multiplyScalar(100.0 / R * a.ozone);
  u.uMieG.value = a.mieG;
  u.uDensityFalloff.value = a.densityFalloff;
  u.uMieFalloff.value = a.mieFalloff;
  u.uSunIntensity.value = a.sunIntensity;
  u.uShadowSoftness.value = a.shadowSoftness;
  u.uTwilight.value = a.twilight;
  u.uSteps.value = a.steps;
  u.uLightSteps.value = a.lightSteps;
  u.uSunDir.value.copy(starBody.pos).sub(body.pos).normalize();
}

// 把某颗行星的云参数写入云 pass 的 uniforms(云壳半径按行星半径; 噪声频率 ∝1/R 归一)。
function applyCloudUniforms(u, body, planet, c) {
  const R = body.radius;
  u.uPlanetCenter.value.copy(planet.position);
  u.uBottom.value = R * c.bottomFrac;
  u.uTop.value = R * c.topFrac;
  u.uCoverage.value = c.coverage;
  // 云消光 ∝ 密度 × 步长, 而步长 ∝ 半径 ∝ worldScale。除以 S 抵消 → 各尺度的云外观与 S=1 一致。
  // (否则大尺度下光学深度爆炸: 自阴影 march 饱和归零 → 云只剩灰蓝环境光, 夜/背面泛灰。)
  u.uDensity.value = c.density / params.worldScale;
  u.uFreq.value = c.freq * 100 / R;         // 主项目在 R=100 调的 0.06 → 按半径归一
  u.uWindSpeed.value = c.windSpeed;
  u.uSteps.value = c.steps;
  u.uLightSteps.value = c.lightSteps;
  u.uSilver.value = c.silver;
  u.uPowder.value = c.powder;
  u.uCloudShadow.value = c.cloudShadow;
  u.uSunDir.value.copy(starBody.pos).sub(body.pos).normalize();
}

// ----------------------------------------------------------------------------
// 系统构建
// ----------------------------------------------------------------------------
let system, entries, starBody, particlePoints = null;
let beltCount = 0;                     // 前 beltCount 个粒子是小行星带(绕恒星), 其余是行星环(绕 ringPlanet)
let ringPlanet = null;                 // 行星环所绕的行星(用于计算环粒子相对该行星的昼夜)
const _off = new THREE.Vector3();      // 浮动原点偏移(聚焦天体位置)
const _AX = new THREE.Vector3(1, 0, 0);

function buildSystem() {
  // 全局尺度: 距离/半径 ×S, 质量 ×S³。这样 v=√(GM/r) ∝ S, 角速度 ω=v/r 不变 → 轨道周期与视觉不变,
  // 纯粹是把整个宇宙"放大", 用来验证渲染管线(深度/浮点)在 1e6 米级下是否成立。软化长度 ×S。
  const S = params.worldScale, S3 = S * S * S;
  system = new NBodySystem({ G: params.G, softening: params.softening * S });
  starBody = system.add(new Body({
    name: CONFIG.star.name, mass: CONFIG.star.mass * S3, radius: CONFIG.star.radius * S,
    color: CONFIG.star.color, type: 'star',
  }));
  for (const p of CONFIG.planets) {
    const planet = system.addOrbiting(starBody, {
      mass: p.mass * S3, radius: p.radius * S, dist: p.dist * S, phase: p.phase,
      inclination: p.incl, color: p.color, name: p.name, type: 'planet',
    });
    // 行星的希尔半径(质量比不变 → cbrt 不变; dist×S → hill×S): a·(m_p / 3·m_star)^(1/3)
    const hill = p.dist * S * Math.cbrt(p.mass / (3 * CONFIG.star.mass));
    for (const m of p.moons) {
      const dist = Math.max(m.hillFrac * hill, p.radius * S * 2.0);   // 稳定区内, 且不埋进行星
      system.addOrbiting(planet, {
        mass: m.mass * S3, radius: m.radius * S, dist, phase: m.phase,
        inclination: m.incl, color: m.color, name: m.name, type: 'moon',
      });
    }
  }
  system.zeroMomentum();
}

// 小行星带(绕恒星) + 行星环(绕某行星), 都是测试粒子。zeroMomentum 之后再加(不参与动量)。
function buildParticles() {
  const S = params.worldScale;   // 半径随全局尺度; 速度用已缩放的 system.G·mass/r, 自动匹配
  const bc = CONFIG.belt;
  const bInner = bc.inner * S, bOuter = bc.outer * S, bThick = bc.thickness * S;
  for (let i = 0; i < bc.count; i++) {
    const r = bInner + Math.random() * (bOuter - bInner);
    const ph = Math.random() * Math.PI * 2;
    const pos = new THREE.Vector3(Math.cos(ph) * r, (Math.random() - 0.5) * bThick, Math.sin(ph) * r).add(starBody.pos);
    const vmag = Math.sqrt(system.G * starBody.mass / r) * (0.98 + Math.random() * 0.04);
    const vel = new THREE.Vector3(-Math.sin(ph), 0, Math.cos(ph)).multiplyScalar(vmag).add(starBody.vel);
    system.addParticle(pos, vel);
  }
  beltCount = system.particles.length;   // 之前加入的都是小行星带(绕恒星)
  const rc = CONFIG.ring;
  const rInner = rc.inner * S, rOuter = rc.outer * S, rThick = rc.thickness * S;
  const planet = system.bodies.find((b) => b.name === rc.planet);
  ringPlanet = planet || null;
  if (planet) {
    for (let i = 0; i < rc.count; i++) {
      const r = rInner + Math.random() * (rOuter - rInner);
      const ph = Math.random() * Math.PI * 2;
      const pos = new THREE.Vector3(Math.cos(ph) * r, (Math.random() - 0.5) * rThick, Math.sin(ph) * r)
        .applyAxisAngle(_AX, rc.tilt).add(planet.pos);
      const vmag = Math.sqrt(system.G * planet.mass / r);
      const vel = new THREE.Vector3(-Math.sin(ph), 0, Math.cos(ph)).applyAxisAngle(_AX, rc.tilt)
        .multiplyScalar(vmag).add(planet.vel);
      system.addParticle(pos, vel);
    }
  }
}

function disposeMeshes() {
  if (particlePoints) {
    scene.remove(particlePoints); particlePoints.geometry.dispose(); particlePoints.material.dispose();
    particlePoints = null;
  }
  if (!entries) return;
  for (const e of entries) {
    scene.remove(e.mesh); e.mesh.geometry.dispose(); e.mesh.material.dispose();
    if (e.line) { scene.remove(e.line); e.line.geometry.dispose(); e.line.material.dispose(); }
  }
}

function buildParticleMesh() {
  const n = system.particles.length;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));   // 每帧按昼夜写入
  particlePoints = new THREE.Points(geo, new THREE.PointsMaterial({
    size: 3.2, sizeAttenuation: true, transparent: true, opacity: 0.9, vertexColors: true,
  }));
  particlePoints.frustumCulled = false;
  scene.add(particlePoints);
}

function buildMeshes() {
  entries = [];
  for (const b of system.bodies) {
    const isStar = b.type === 'star';
    const mat = isStar
      ? new THREE.MeshBasicMaterial({ color: b.color })
      : new THREE.MeshStandardMaterial({ color: b.color, roughness: 1.0, metalness: 0.0 });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(b.radius, 32, 24), mat);
    scene.add(mesh);

    // 轨道椭圆(仅非恒星; 每帧从状态矢量解析计算, 画完整闭合曲线)
    let line = null;
    if (b.primary) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ORBIT_SEG * 3), 3));
      geo.setDrawRange(0, 0);
      line = new THREE.Line(geo, new THREE.LineBasicMaterial({
        color: b.color, transparent: true, opacity: 0.5,
      }));
      line.frustumCulled = false;
      scene.add(line);
    }

    entries.push({ body: b, mesh, line });
  }
}

function rebuild() {
  clearAllDetail();
  disposeMeshes();
  buildSystem();
  buildParticles();
  buildMeshes();
  buildParticleMesh();
  refreshFocusOptions();
}

// ----------------------------------------------------------------------------
// 渲染: 浮动原点(相对聚焦天体)
// ----------------------------------------------------------------------------
function focusBody() {
  return system.bodies.find((b) => b.name === params.focus) || starBody;
}

const _r = new THREE.Vector3(), _v = new THREE.Vector3(), _h = new THREE.Vector3();
const _vxh = new THREE.Vector3(), _evec = new THREE.Vector3();
const _nHat = new THREE.Vector3(), _pHat = new THREE.Vector3(), _qHat = new THREE.Vector3();

// 从相对主星的状态矢量(r, v)解析出轨道椭圆, 写入 line 的顶点(相对浮动原点)。
// 逃逸/近抛物(能量≥0 或 e≥1)则不画闭合椭圆。返回是否画了。
function writeOrbit(body, line) {
  const primary = body.primary;
  const mu = system.G * (primary.mass + body.mass);
  _r.subVectors(body.pos, primary.pos);
  _v.subVectors(body.vel, primary.vel);
  const rLen = _r.length();
  _h.crossVectors(_r, _v);
  const hLen = _h.length();
  if (hLen < 1e-9 || rLen < 1e-9) return false;
  _vxh.crossVectors(_v, _h).multiplyScalar(1 / mu);
  _evec.copy(_vxh).addScaledVector(_r, -1 / rLen);   // 偏心率矢量(指向近星点)
  const e = _evec.length();
  const energy = 0.5 * _v.lengthSq() - mu / rLen;
  if (energy >= 0 || e >= 0.999) return false;
  const p = hLen * hLen / mu;                        // 半通径
  _nHat.copy(_h).multiplyScalar(1 / hLen);
  if (e > 1e-5) _pHat.copy(_evec).multiplyScalar(1 / e);
  else _pHat.copy(_r).multiplyScalar(1 / rLen);
  _qHat.crossVectors(_nHat, _pHat);
  const arr = line.geometry.attributes.position.array;
  for (let i = 0; i < ORBIT_SEG; i++) {
    const th = (i / (ORBIT_SEG - 1)) * Math.PI * 2;
    const rr = p / (1 + e * Math.cos(th));
    const cx = Math.cos(th), sx = Math.sin(th);
    arr[i * 3]     = primary.pos.x + rr * (cx * _pHat.x + sx * _qHat.x) - _off.x;
    arr[i * 3 + 1] = primary.pos.y + rr * (cx * _pHat.y + sx * _qHat.y) - _off.y;
    arr[i * 3 + 2] = primary.pos.z + rr * (cx * _pHat.z + sx * _qHat.z) - _off.z;
  }
  line.geometry.setDrawRange(0, ORBIT_SEG);
  line.geometry.attributes.position.needsUpdate = true;
  return true;
}

function updateRender() {
  _off.copy(focusBody().pos);
  for (const e of entries) {
    e.mesh.position.copy(e.body.pos).sub(_off);
    e.mesh.visible = !detailMap.has(e.body);   // 详细行星显示时隐藏对应简单球
    if (e.line) e.line.visible = params.orbits && writeOrbit(e.body, e.line);
  }
  // 小行星带 / 环粒子(相对浮动原点)
  if (particlePoints) {
    if (params.showBelt) {
      const posArr = particlePoints.geometry.attributes.position.array;
      const colArr = particlePoints.geometry.attributes.color.array;
      const P = system.particles;
      // 基础色 ~0x9aa2b2; 夜面压到 DARK(近黑)。环粒子(绕行星)按"相对该行星的太阳方向"昼夜着色;
      // 带粒子(绕恒星, 光源在环中心)始终受光 → lit=1。
      const BR = 0.604, BG = 0.635, BB = 0.698, DARK = 0.0;   // 背阳侧完全变黑(在阴影中的环片段消失)
      const hasRing = !!ringPlanet;
      let sux = 0, suy = 0, suz = 0;
      if (hasRing) {
        const dx = starBody.pos.x - ringPlanet.pos.x, dy = starBody.pos.y - ringPlanet.pos.y, dz = starBody.pos.z - ringPlanet.pos.z;
        const dl = Math.hypot(dx, dy, dz) || 1;
        sux = dx / dl; suy = dy / dl; suz = dz / dl;   // 行星 → 恒星 单位向量
      }
      for (let i = 0; i < P.length; i++) {
        const px = P[i].pos.x, py = P[i].pos.y, pz = P[i].pos.z;
        posArr[i * 3] = px - _off.x; posArr[i * 3 + 1] = py - _off.y; posArr[i * 3 + 2] = pz - _off.z;
        let lit = 1.0;
        if (hasRing && i >= beltCount) {
          const ox = px - ringPlanet.pos.x, oy = py - ringPlanet.pos.y, oz = pz - ringPlanet.pos.z;
          const ol = Math.hypot(ox, oy, oz) || 1;
          const d = (ox * sux + oy * suy + oz * suz) / ol;   // 粒子方位相对太阳: 1=朝阳, -1=背阳
          const t = Math.min(1, Math.max(0, (d + 0.2) / 0.4));
          lit = DARK + (1 - DARK) * (t * t * (3 - 2 * t));   // smoothstep(-0.2,0.2): 背阳半环变暗
        }
        colArr[i * 3] = BR * lit; colArr[i * 3 + 1] = BG * lit; colArr[i * 3 + 2] = BB * lit;
      }
      particlePoints.geometry.attributes.position.needsUpdate = true;
      particlePoints.geometry.attributes.color.needsUpdate = true;
      particlePoints.visible = true;
    } else {
      particlePoints.visible = false;
    }
  }
  sunLight.position.copy(starBody.pos).sub(_off);
}

// ----------------------------------------------------------------------------
// GUI
// ----------------------------------------------------------------------------
const gui = new GUI();
gui.add(params, 'G', 0.2, 8.0).name('引力常数 G').onFinishChange(rebuild);
gui.add(params, 'timeScale', 0.0, 30.0, 0.1).name('时间流速(×倍)');
gui.add(params, 'worldScale', { '×1 (演示)': 1, '×1e2': 100, '×1e3': 1000, '×1e4': 10000, '×1e5 (~1e6 米)': 100000 })
  .name('全局尺度(×S)').onChange(() => { rebuild(); frameFocus(); });
gui.add(params, 'softening', 0.1, 20).name('软化(防奇点)').onFinishChange(() => { system.softening = params.softening * params.worldScale; });
gui.add(params, 'paused').name('暂停');
gui.add(params, 'orbits').name('轨道线(完整椭圆)');
gui.add(params, 'showBelt').name('小行星带/环');
gui.add(params, 'detail').name('近距地形(LOD, 多行星)');
gui.add(params, 'detailAtmo').name('近距大气(总开关)');
gui.add(params, 'detailClouds').name('近距云层(总开关)');
gui.add(params, 'wireframe', { '关闭': 'off', '当前行星': 'current', '全部行星': 'all' }).name('线框模式').onChange(applyWireframe);

// 按线框模式给各详细行星开/关线框: off 全关 / current 仅当前聚焦 / all 全开。气态星无地形网格, 跳过。
function applyWireframe() {
  const mode = params.wireframe, fb = focusBody();
  for (const [b, e] of detailMap) {
    if (!e.planet) continue;
    e.planet.setWireframe(mode === 'all' || (mode === 'current' && b === fb));
  }
}
let focusCtrl = gui.add(params, 'focus', ['恒星']).name('聚焦天体').onChange(onFocusChange);
const radiusCtrl = gui.add(bodyEdit, 'radius', 2, 300).name('聚焦天体半径').onChange(applyBodyRadius);
gui.add({ reset: rebuild }, 'reset').name('重置星系');
gui.add({ recenter: () => { controls.target.set(0, 0, 0); } }, 'recenter').name('相机对准聚焦');
const characterCtrl = gui.add(params, 'character').name('角色模式(登陆聚焦星球)').onChange(setCharacter);

// 进入/退出角色模式。角色登陆"当前聚焦"的地形行星/卫星(恒星/气态不可登陆)。
function setCharacter(on) {
  if (on) {
    const b = focusBody();
    let e = b && detailMap.get(b);
    if (b && !e && b.type !== 'star' && !tuneFor(b).gas) e = addDetail(b);   // 需要时立即建地形
    if (!b || b.type === 'star' || tuneFor(b).gas || !e || !e.planet) {
      params.character = false; characterCtrl.updateDisplay();
      alert('请先聚焦一颗地形行星/卫星(非恒星、非气态), 再进入角色模式');
      return;
    }
    if (!walker) { walker = new PlanetWalker(e.planet, renderer.domElement); scene.add(walker.mesh); }
    else walker.planet = e.planet;
    walker.pitchMin = -1.3; walker.pitchMax = 1.45;   // 全范围俯仰: 可仰头看天/俯瞰
    charMode = true;
    controls.enabled = false;
    walker.enable(camera.position.clone().normalize());   // 在轨道相机对着的地表处出生
    walker.setActive(true);
    walker.camera.aspect = innerWidth / innerHeight;
    walker.camera.updateProjectionMatrix();
  } else {
    charMode = false;
    if (walker) { walker.setActive(false); walker.disable(); }
    controls.enabled = true;
  }
}
// 供其它地方(如切换聚焦)安全退出角色模式并同步 GUI 开关
function exitCharacter() {
  if (!charMode) return;
  params.character = false;
  if (typeof characterCtrl !== 'undefined' && characterCtrl) characterCtrl.updateDisplay();
  setCharacter(false);
}

function refreshFocusOptions() {
  const names = system.bodies.map((b) => b.name);
  focusCtrl = focusCtrl.options(names).name('聚焦天体').onChange(onFocusChange);
  if (!names.includes(params.focus)) params.focus = names[0];
  editingBody = null;                 // 旧天体已失效, 不回存
  focusCtrl.setValue(params.focus);
  onFocusChange();                    // 载入当前聚焦天体的配置
}

// 设置观察中心(聚焦天体), 相机自动对准并拉到合适距离
function setFocus(body) {
  params.focus = body.name;
  syncFocusCfg(body);     // 保存旧天体配置 + 载入该天体配置(并刷新所有 GUI 显示, 含聚焦下拉)
  syncBodyEdit();
  const d = THREE.MathUtils.clamp(body.radius * 8, controls.minDistance, controls.maxDistance);
  if (camera.position.lengthSq() > 1e-6) camera.position.setLength(d);
  controls.target.set(0, 0, 0);
  controls.update();
  updateGuiForFocus();     // 恒星: 隐藏调参面板; 行星/卫星: 显示
  if (params.wireframe === 'current') applyWireframe();
  persistParams();
}

// 半径滑块与聚焦天体同步 / 应用
function syncBodyEdit() {
  const b = focusBody(); if (!b) return;
  bodyEdit.radius = b.radius;
  if (typeof radiusCtrl !== 'undefined' && radiusCtrl) radiusCtrl.updateDisplay();
}
function applyBodyRadius() {
  const b = focusBody(); if (!b) return;
  b.radius = bodyEdit.radius;
  const e0 = entries.find((en) => en.body === b);
  if (e0) { e0.mesh.geometry.dispose(); e0.mesh.geometry = new THREE.SphereGeometry(b.radius, 32, 24); }
  const e = detailMap.get(b);
  if (e) {
    if (e.gas) e.gas.scale.setScalar(b.radius);
    else { Object.assign(e.planet.params, planetParamsFor(b)); e.planet.rebuild(); }   // 重建近距地形以匹配新半径
  }
}

// 点击天体切换观察中心(区分点击/拖动)
const _raycaster = new THREE.Raycaster();
const _pointer = new THREE.Vector2();
let _downXY = null;
renderer.domElement.addEventListener('pointerdown', (e) => { _downXY = { x: e.clientX, y: e.clientY }; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (charMode) return;                 // 角色模式: 点击用于锁定视角, 不切换聚焦
  if (!_downXY) return;
  const moved = Math.hypot(e.clientX - _downXY.x, e.clientY - _downXY.y);
  _downXY = null;
  if (moved > 5) return;                    // 拖动旋转, 不当点击
  _pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  _raycaster.setFromCamera(_pointer, camera);
  const hits = _raycaster.intersectObjects(entries.map((en) => en.mesh), false);
  if (hits.length) {
    const e2 = entries.find((en) => en.mesh === hits[0].object);
    if (e2) setFocus(e2.body);
  }
});

// ----------------------------------------------------------------------------
// 近距详细表现: 靠近聚焦天体时, 用主项目的 LOD 地形行星替代简单球(在原点=浮动原点中心)
// ----------------------------------------------------------------------------
// 多行星: body → { planet }。相机附近的若干颗天体各建一个详细 LOD 行星(每颗用自己的 cfg)。
const detailMap = new Map();
// 每个非恒星天体都常驻一个 LOD 行星: 远离时 LOD 自然降到最低细分(粗糙带地形色的球),
// 不再切换成光滑简单球。大气 pass 才按距离限流(只给最近的几颗跑, 控制开销)。
const ATMO_DIST = 60;        // 大气可见范围: 相机距 < 半径 × 此值才跑大气 pass
const MAX_ATMO = 2;          // 同时最多跑几颗行星的大气 pass(每颗一次全屏 raymarch)
const _tmpV = new THREE.Vector3();

// 近距行星的默认 LOD/地形调参(新天体从此拷贝一份到 body.cfg; 地形种子按天体名区分)。
// GUI 编辑的始终是"当前聚焦天体"的这份 tune, 切换聚焦时保存旧/载入新。
const tune = {
  seed: 1337,               // 顶层种子: 驱动大陆/山脉/域扭曲/板块/湿度全部子种子。复用配置后只改这个即可换地形。
  maxLevel: 8, splitFactor: 2.5, patchResolution: 16, frustumMargin: 0.15,
  nearRadiusFrac: 0.5, maxHeightFrac: 0.03, seaLevel: 0.0, oceanEnabled: true,
  continentFreq: 1.2, continentOctaves: 5, mountainFreq: 3.0, mountainStrength: 0.6,
  warpStrength: 0.2, plateStrength: 0.5, useClimate: true,
  // 气态行星(替代地形: 纬向气带 + 湍流; gas=true 时不生成地形/海洋)
  gas: false, gasBands: 14, gasWarp: 0.6, gasFlow: 0.03,
  colGasA: [0.72, 0.62, 0.45], colGasB: [0.90, 0.83, 0.68], colGasC: [0.55, 0.44, 0.34],
  // 地形调色板([r,g,b] 0..1, lil-gui addColor 原地编辑)
  colOceanShallow: [0.20, 0.45, 0.62], colOceanDeep: [0.03, 0.12, 0.30],
  colBeach: [0.82, 0.78, 0.55], colDry: [0.78, 0.70, 0.42], colWet: [0.13, 0.45, 0.15],
  colColdDry: [0.55, 0.53, 0.45], colColdWet: [0.22, 0.38, 0.32],
  colRock: [0.50, 0.50, 0.52], colSnow: [0.97, 0.97, 1.0],
};

// 每颗天体的初始配置(按名字覆盖 DEFAULT_CFG 里对应的键)。让不同星球一眼就不一样:
// 地球型 / 沙漠火星型 / 丛林海洋型 + 岩石月 / 冰月 / 尘土月。用户仍可在 GUI 里各自继续调。
const BODY_CFG = {
  '行星1': {   // 地球型: 海陆分明, 气候配色
    tune: {
      seaLevel: 0.03, maxHeightFrac: 0.03, continentFreq: 1.2, mountainFreq: 3.0, mountainStrength: 0.6,
      warpStrength: 0.25, plateStrength: 0.6, useClimate: true,
      colOceanShallow: [0.20, 0.50, 0.66], colOceanDeep: [0.02, 0.10, 0.28],
      colBeach: [0.85, 0.80, 0.58], colWet: [0.12, 0.45, 0.15], colDry: [0.76, 0.70, 0.42],
      colColdWet: [0.20, 0.38, 0.30], colColdDry: [0.55, 0.55, 0.48], colRock: [0.48, 0.47, 0.48], colSnow: [0.97, 0.98, 1.0],
    },
    atm: { enabled: true, scale: 1.08, rayleigh: 1.0, mie: 1.0, tint: [1.0, 1.0, 1.0] },
    cloud: { enabled: true, coverage: 0.5, density: 1.2 },
  },
  '行星2': {   // 沙漠 / 火星型: 无海洋, 崎岖多山, 铁锈色, 无气候配色
    tune: {
      seaLevel: -0.6, maxHeightFrac: 0.05, continentFreq: 0.9, mountainFreq: 4.5, mountainStrength: 0.95,
      warpStrength: 0.35, plateStrength: 0.85, useClimate: false, oceanEnabled: false,
      colBeach: [0.75, 0.52, 0.33], colWet: [0.70, 0.42, 0.26], colDry: [0.66, 0.40, 0.24],
      colRock: [0.52, 0.31, 0.23], colSnow: [0.90, 0.82, 0.75],
    },
    atm: { enabled: true, scale: 1.06, rayleigh: 0.6, mie: 1.4, tint: [1.0, 0.55, 0.30] },
    cloud: { enabled: true, coverage: 0.28, density: 0.8, topFrac: 1.05 },
  },
  '行星3': {   // 丛林 / 海洋型: 更多海, 葱郁绿, 青色海
    tune: {
      seaLevel: 0.10, maxHeightFrac: 0.025, continentFreq: 1.5, mountainFreq: 2.5, mountainStrength: 0.5,
      warpStrength: 0.30, plateStrength: 0.4, useClimate: true,
      colOceanShallow: [0.14, 0.55, 0.58], colOceanDeep: [0.02, 0.16, 0.28],
      colBeach: [0.85, 0.83, 0.60], colWet: [0.05, 0.50, 0.12], colDry: [0.45, 0.55, 0.20],
      colColdWet: [0.12, 0.40, 0.28], colColdDry: [0.50, 0.55, 0.42], colRock: [0.45, 0.48, 0.42], colSnow: [0.95, 0.98, 0.98],
    },
    atm: { enabled: true, scale: 1.10, rayleigh: 1.3, mie: 0.9, tint: [0.7, 1.0, 0.9] },
    cloud: { enabled: true, coverage: 0.62, density: 1.4 },
  },
  '行星4': {   // 气态巨行星: 木星风格棕黄气带, 无地形/海洋, 大气与云由气带 shader 自身表现
    tune: {
      gas: true, gasBands: 16, gasWarp: 0.7, gasFlow: 0.03,
      colGasA: [0.78, 0.66, 0.46], colGasB: [0.94, 0.87, 0.72], colGasC: [0.55, 0.40, 0.30],
    },
    atm: { enabled: false },
    cloud: { enabled: false },
  },
  '卫星1a': {  // 岩石灰月: 无海, 密集陨坑感(高山脉频率), 灰
    tune: {
      seaLevel: -1.0, maxHeightFrac: 0.06, continentFreq: 2.0, mountainFreq: 6.5, mountainStrength: 1.0,
      warpStrength: 0.15, plateStrength: 0.9, useClimate: false, oceanEnabled: false,
      colBeach: [0.42, 0.42, 0.44], colWet: [0.46, 0.46, 0.48], colDry: [0.50, 0.50, 0.52],
      colRock: [0.34, 0.34, 0.36], colSnow: [0.70, 0.70, 0.72],
    },
    atm: { enabled: false },
  },
  '卫星2a': {  // 冰月: 平滑, 冰蓝白
    tune: {
      seaLevel: -0.2, maxHeightFrac: 0.02, continentFreq: 1.0, mountainFreq: 3.5, mountainStrength: 0.3,
      warpStrength: 0.10, plateStrength: 0.3, useClimate: false, oceanEnabled: false,
      colBeach: [0.78, 0.84, 0.90], colWet: [0.72, 0.80, 0.88], colDry: [0.80, 0.85, 0.90],
      colRock: [0.60, 0.68, 0.78], colSnow: [0.96, 0.98, 1.0],
    },
    atm: { enabled: false },
  },
  '卫星2b': {  // 尘土月: 无海, 土褐
    tune: {
      seaLevel: -1.0, maxHeightFrac: 0.05, continentFreq: 1.6, mountainFreq: 5.0, mountainStrength: 0.8,
      warpStrength: 0.20, plateStrength: 0.7, useClimate: false, oceanEnabled: false,
      colBeach: [0.60, 0.52, 0.40], colWet: [0.55, 0.48, 0.36], colDry: [0.62, 0.55, 0.42],
      colRock: [0.44, 0.38, 0.30], colSnow: [0.75, 0.72, 0.64],
    },
    atm: { enabled: false },
  },
};

// ---- 每天体独立配置: GUI 编辑的始终是"当前聚焦天体"的 tune/atm; 切换聚焦时保存旧/载入新 ----
let editingBody = null;
function cfgSnapshot() {
  return {
    tune: JSON.parse(JSON.stringify(tune)),
    atm: JSON.parse(JSON.stringify(atm)),
    cloud: JSON.parse(JSON.stringify(cloud)),
  };
}
const DEFAULT_CFG = cfgSnapshot();     // 启动默认(新天体从此开始)

// ---- 持久化(localStorage): 记住每颗天体调好的配置 + 命名预设库, 跨刷新/重启保留(记忆功能) ----
const LS_KEY = 'solar.cfg.v1';
function lsLoad() { try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) { return {}; } }
function lsSave() { try { localStorage.setItem(LS_KEY, JSON.stringify(store)); } catch (e) { /* 隐私模式等: 忽略 */ } }
const store = lsLoad();
store.bodies = store.bodies || {};      // { 天体名: cfg }  记忆各行星调好的参数(ensureCfg 优先读它)
store.presets = store.presets || {};    // { 预设名: cfg }  跨行星复用的配置库
function persistBody(body) { if (body && body.cfg) { store.bodies[body.name] = body.cfg; lsSave(); } }
function persistFocused() { if (editingBody) { saveCfg(editingBody); persistBody(editingBody); } }
// 顶层 Controls 参数也持久化, 免得每次重调。character 是运行态(避免启动即进角色)、不存; radius 是每天体瞬态、不存。
const PERSIST_PARAMS = ['G', 'timeScale', 'softening', 'paused', 'orbits', 'showBelt', 'detail', 'detailAtmo', 'detailClouds', 'wireframe', 'worldScale', 'focus'];
function persistParams() { const o = {}; for (const k of PERSIST_PARAMS) o[k] = params[k]; store.params = o; lsSave(); }
function restoreParams() { if (store.params) for (const k of PERSIST_PARAMS) if (k in store.params) params[k] = store.params[k]; }
let _persistTimer = 0;
function persistSoon() { clearTimeout(_persistTimer); _persistTimer = setTimeout(() => { persistFocused(); persistParams(); }, 400); }

function cfgRestore(cfg) {
  for (const k in cfg.tune) {
    if (Array.isArray(tune[k])) { tune[k].length = 0; tune[k].push(...cfg.tune[k]); }  // 原地改, 保留数组引用(GUI addColor 绑定)
    else tune[k] = cfg.tune[k];
  }
  for (const k in cfg.atm) atm[k] = cfg.atm[k];
  for (const k in (cfg.cloud || {})) cloud[k] = cfg.cloud[k];
  gui.controllersRecursive().forEach((c) => c.updateDisplay());
}
function saveCfg(body) { if (body) body.cfg = cfgSnapshot(); }
function loadCfg(body) { ensureCfg(body); cfgRestore(body.cfg); }
// 取某天体配置: 优先用 localStorage 记忆的(上次调好的); 否则从 DEFAULT_CFG 拷一份再叠加
// BODY_CFG[名字] 预设覆盖(不同星球初始就不一样)。顶层种子: 预设未指定则按天体名散列。
function ensureCfg(body) {
  if (!body.cfg) {
    if (store.bodies[body.name]) {
      const cfg = JSON.parse(JSON.stringify(store.bodies[body.name]));   // 记忆: 跨重建/刷新保留手动调参
      if (cfg.tune.seed == null) cfg.tune.seed = hashSeed(body.name);    // 老数据兜底
      body.cfg = cfg;
    } else {
      const cfg = JSON.parse(JSON.stringify(DEFAULT_CFG));
      const ov = BODY_CFG[body.name];
      if (ov) {
        if (ov.tune)  for (const k in ov.tune)  cfg.tune[k]  = Array.isArray(ov.tune[k])  ? ov.tune[k].slice()  : ov.tune[k];
        if (ov.atm)   for (const k in ov.atm)   cfg.atm[k]   = Array.isArray(ov.atm[k])   ? ov.atm[k].slice()   : ov.atm[k];
        if (ov.cloud) for (const k in ov.cloud) cfg.cloud[k] = Array.isArray(ov.cloud[k]) ? ov.cloud[k].slice() : ov.cloud[k];
      }
      if (!(ov && ov.tune && ov.tune.seed != null)) cfg.tune.seed = hashSeed(body.name);   // 各行星默认种子不同
      body.cfg = cfg;
    }
  }
  return body.cfg;
}
// 取某天体生效的配置: 正在编辑(聚焦)的天体用 GUI 里的实时 tune/atm/cloud; 其余天体用各自 body.cfg。
function tuneFor(body)  { return (body === editingBody) ? tune  : ensureCfg(body).tune; }
function atmFor(body)   { return (body === editingBody) ? atm   : ensureCfg(body).atm; }
function cloudFor(body) { return (body === editingBody) ? cloud : ensureCfg(body).cloud; }
function syncFocusCfg(newBody) {
  if (!newBody) return;
  if (editingBody && editingBody !== newBody) { saveCfg(editingBody); persistBody(editingBody); }  // 切换时把旧天体存盘
  editingBody = newBody;
  loadCfg(newBody);
}
function onFocusChange() { if (charMode) exitCharacter(); const b = focusBody(); syncFocusCfg(b); syncBodyEdit(); updateGuiForFocus(); if (params.wireframe === 'current') applyWireframe(); }

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 99999;
}
function planetParamsFor(body) {
  const t = tuneFor(body);          // 每颗行星用自己的配置(聚焦天体用 GUI 实时值)
  const s = (t.seed != null ? t.seed : hashSeed(body.name)) | 0;   // 顶层种子(GUI 可调 / 复用配置后改这个即可换地形)
  return {
    radius: body.radius, maxHeight: body.radius * t.maxHeightFrac, seaLevel: t.seaLevel,
    patchResolution: t.patchResolution, maxLevel: t.maxLevel, splitFactor: t.splitFactor,
    nearRadius: body.radius * t.nearRadiusFrac, frustumMargin: t.frustumMargin,
    continentSeed: s, continentFreq: t.continentFreq, continentOctaves: t.continentOctaves,
    continentGain: 0.5, continentLacunarity: 2.0,
    mountainSeed: s + 11, mountainFreq: t.mountainFreq, mountainOctaves: 5, mountainStrength: t.mountainStrength,
    warpSeed: s + 23, warpStrength: t.warpStrength, warpFreq: 1.0,
    plateSeed: s + 37, plateFreq: 1.6, plateStrength: t.plateStrength,
    moistureSeed: s + 51, moistureFreq: 1.2, useClimate: t.useClimate, climateAltRange: 1.0,
    colOceanShallow: t.colOceanShallow, colOceanDeep: t.colOceanDeep,
    colBeach: t.colBeach, colDry: t.colDry, colWet: t.colWet,
    colColdDry: t.colColdDry, colColdWet: t.colColdWet,
    colRock: t.colRock, colSnow: t.colSnow,
  };
}
// LOD 类参数: 写入当前聚焦行星的详细网格, 实时生效(无需重建)。GUI 编辑的是聚焦天体。
function applyLODLive() {
  saveCfg(editingBody);              // 把 GUI 改动持久化进聚焦天体的 cfg
  const b = focusBody();
  const e = detailMap.get(b);
  if (!e || e.gas) return;
  const p = e.planet.params;
  p.maxLevel = tune.maxLevel; p.splitFactor = tune.splitFactor; p.frustumMargin = tune.frustumMargin;
  p.nearRadius = b.radius * tune.nearRadiusFrac;
}
// 结构/地形类参数: 重建聚焦行星的详细网格
function applyDetailRebuild() {
  saveCfg(editingBody);
  const b = focusBody();
  const e = detailMap.get(b);
  if (!e || e.gas) return;
  Object.assign(e.planet.params, planetParamsFor(b));
  e.planet.rebuild();
  disposeOcean(e);                       // 海洋(颜色/半径/开关可能都变了)重建
  e.ocean = makeOcean(b);
  if (e.ocean) { e.ocean.position.copy(e.planet.position); scene.add(e.ocean); }
}

// 有水的天体建一个半透明海洋球(半径=海平面处; 颜色取该天体的地形海洋色)。无水返回 null。
function makeOcean(body) {
  const t = tuneFor(body);
  if (!t.oceanEnabled) return null;
  const ocean = createOcean();
  ocean.frustumCulled = false;
  ocean.scale.setScalar(body.radius * (1 + t.seaLevel * t.maxHeightFrac));   // 海平面半径
  const d = t.colOceanDeep, s = t.colOceanShallow;
  ocean.material.uniforms.uDeep.value.setRGB(d[0], d[1], d[2]);
  ocean.material.uniforms.uShallow.value.setRGB(s[0], s[1], s[2]);
  ocean.material.uniforms.uAmbient.value = 0.0;   // 太阳系: 夜面海洋不加环境光, 背向太阳一侧变暗
  return ocean;
}
function disposeOcean(e) {
  if (e && e.ocean) { scene.remove(e.ocean); e.ocean.geometry.dispose(); e.ocean.material.dispose(); e.ocean = null; }
}

// ---- 多行星详细网格的建立/销毁 ----
function addDetail(body) {
  ensureCfg(body);
  if (tuneFor(body).gas) {              // 气态行星: 气带 shader 球替代地形 LOD(无海洋)
    const gas = createGasGiant();
    gas.frustumCulled = false;
    gas.scale.setScalar(body.radius);
    applyGasUniforms(gas, body, tuneFor(body));
    scene.add(gas);
    const e = { gas };
    detailMap.set(body, e);
    return e;
  }
  const planet = new Planet(planetParamsFor(body));
  scene.add(planet);
  const ocean = makeOcean(body);       // 海洋是独立 mesh 加到 scene(不做 Planet 子节点, 因 rebuild 会 clear)
  if (ocean) scene.add(ocean);
  const e = { planet, ocean };
  detailMap.set(body, e);
  if (params.wireframe === 'all' || (params.wireframe === 'current' && body === focusBody())) planet.setWireframe(true);
  return e;
}
function removeDetail(body) {
  const e = detailMap.get(body);
  if (!e) return;
  if (e.gas) {                                            // 气态: 释放气带 shader 球
    scene.remove(e.gas); e.gas.geometry.dispose(); e.gas.material.dispose();
    detailMap.delete(body);
    return;
  }
  for (const r of e.planet.roots) r.dispose(e.planet);   // 取消未完成 job + 释放网格
  e.planet.clear();
  scene.remove(e.planet);                                 // worker 是共享池, 不 terminate
  disposeOcean(e);
  detailMap.delete(body);
}
function clearAllDetail() { for (const b of [...detailMap.keys()]) removeDetail(b); }

// 相机到某天体渲染位(body.pos - _off)的距离
function camDistTo(body) { return renderCam().position.distanceTo(_tmpV.copy(body.pos).sub(_off)); }

// 每帧维护"常驻"的 LOD 行星集合:
//   - 每个非恒星天体都始终有一颗 LOD 行星(远离时 LOD 自然降到最低细分, 不切简单球);
//   - 每帧最多新建 1 颗(就近优先), 把建根的同步开销摊平到多帧, 避免启动卡顿;
//   - 不做距离淘汰(远处的 LOD 行星只是停在最低细分, 开销很小)。
function manageDetail() {
  _off.copy(focusBody().pos);   // 浮动原点偏移(在 updateRender 之前先算好, 供详细行星定位)
  if (!params.detail) { if (detailMap.size) clearAllDetail(); return; }

  // 就近补建缺失的 LOD 行星(每帧一颗)
  let best = null, bestd = Infinity;
  for (const b of system.bodies) {
    if (b.type === 'star' || detailMap.has(b)) continue;
    const d = camDistTo(b);
    if (d < bestd) { best = b; bestd = d; }
  }
  if (best) addDetail(best);

  // 更新所有 LOD 行星位置 + LOD(远处自然停在最低细分); 海洋跟随并按距离显隐
  for (const [b, e] of detailMap) {
    if (e.gas) {                                 // 气态行星: 定位 + 驱动流动/光照(无 LOD/海洋)
      e.gas.position.copy(b.pos).sub(_off);
      const gu = e.gas.material.uniforms;
      gu.uTime.value = cloudTime;
      gu.uSunDir.value.copy(starBody.pos).sub(b.pos).normalize();
      continue;
    }
    e.planet.position.copy(b.pos).sub(_off);   // 定位到浮动原点空间(聚焦天体处为原点)
    e.planet.update(renderCam());
    if (e.ocean) {
      e.ocean.position.copy(e.planet.position);
      e.ocean.visible = camDistTo(b) < b.radius * ATMO_DIST;   // 近距才画水面(远处地形海洋色兜底)
      e.ocean.material.uniforms.uSunDir.value.copy(starBody.pos).sub(b.pos).normalize();
    }
  }
}

// 每帧动态相机 near/far + 距离限制 + 星空跟随。聚焦天体在渲染原点, 相机绕它转。
// near 卡在聚焦行星前面(透视深度精度集中在近平面 → 聚焦星表精度好); far 覆盖到最远天体。
function updateCameraRange() {
  const fR = focusBody().radius;
  const camDist = camera.position.length();      // 相机到聚焦中心(原点)
  let maxD = fR * 3;                              // 场景最远天体到聚焦中心(渲染空间)
  for (const b of system.bodies) {
    const d = _tmpV.copy(b.pos).sub(_off).length();
    if (d > maxD) maxD = d;
  }
  const far = camDist + maxD * 1.5 + fR * 10;
  const near = Math.max((camDist - fR) * 0.3, fR * 1e-4, far * 1e-7);   // 比值上限 ~1e7
  camera.near = near; camera.far = far; camera.updateProjectionMatrix();
  controls.minDistance = fR * 1.02;              // 贴到星表附近
  controls.maxDistance = maxD * 6 + fR * 50;     // 能拉远看全场景
  if (starField) { starField.position.copy(camera.position); starField.scale.setScalar(far * 0.9); }
}

// 尺度或聚焦变化后, 把相机拉到聚焦天体外一个合适距离(半径×8), 避免相机卡在放大后的星体内部。
// 关键: 先按新尺度放宽 controls 距离限制, 否则紧随的 controls.update() 会用旧尺度的 min/max 把相机
// 夹回去(小尺度切大尺度时会被夹进星球内部)。下一帧 updateCameraRange() 会再精修 near/far/min/max。
function frameFocus() {
  const fR = focusBody().radius;
  const d = fR * 8;
  controls.minDistance = fR * 1.02;
  controls.maxDistance = Math.max(controls.maxDistance, d * 4);
  if (camera.position.lengthSq() > 1e-12) camera.position.setLength(d);
  else camera.position.set(0, d * 0.4, d);
  controls.target.set(0, 0, 0);
  controls.update();
}

// 近距行星 LOD/地形 GUI(LOD 类实时生效; 结构/地形类重建当前近距行星)
const fLOD = gui.addFolder('近距行星 (LOD/地形)');
const seedCtrl = fLOD.add(tune, 'seed', 0, 99999, 1).name('顶层种子').onFinishChange(applyDetailRebuild);
fLOD.add({ rnd: () => { tune.seed = Math.floor(Math.random() * 100000); seedCtrl.updateDisplay(); applyDetailRebuild(); } }, 'rnd').name('🎲 随机种子');
fLOD.add(tune, 'maxLevel', 0, 12, 1).name('最大层数').onChange(applyLODLive);
fLOD.add(tune, 'splitFactor', 1, 5).name('细分激进度').onChange(applyLODLive);
fLOD.add(tune, 'frustumMargin', 0, 0.5).name('视锥余量').onChange(applyLODLive);
fLOD.add(tune, 'nearRadiusFrac', 0, 2).name('预细分半径 ×R').onChange(applyLODLive);
fLOD.add(tune, 'patchResolution', [4, 8, 16, 32]).name('patch 分辨率').onChange(applyDetailRebuild);
fLOD.add(tune, 'maxHeightFrac', 0, 0.2).name('地形起伏 ×R').onFinishChange(applyDetailRebuild);
fLOD.add(tune, 'seaLevel', -1, 0.5).name('海平面').onFinishChange(applyDetailRebuild);
fLOD.add(tune, 'oceanEnabled').name('海洋(水面)').onChange(applyDetailRebuild);
fLOD.add(tune, 'continentFreq', 0.2, 4).name('大陆频率').onFinishChange(applyDetailRebuild);
fLOD.add(tune, 'continentOctaves', 1, 8, 1).name('大陆八度').onFinishChange(applyDetailRebuild);
fLOD.add(tune, 'mountainFreq', 0.5, 8).name('山脉频率').onFinishChange(applyDetailRebuild);
fLOD.add(tune, 'mountainStrength', 0, 1.5).name('山脉强度').onFinishChange(applyDetailRebuild);
fLOD.add(tune, 'warpStrength', 0, 0.6).name('域扭曲').onFinishChange(applyDetailRebuild);
fLOD.add(tune, 'plateStrength', 0, 1.2).name('板块带').onFinishChange(applyDetailRebuild);
fLOD.add(tune, 'useClimate').name('气候配色').onChange(applyDetailRebuild);

// 近距行星大气(实时生效; 每天体独立开关+参数, 编辑的是当前聚焦天体)
const fAtm = gui.addFolder('大气 (近距)');
fAtm.add(atm, 'enabled').name('启用大气(本星球)');
fAtm.addColor(atm, 'tint').name('大气色调');
fAtm.add(atm, 'scale', 1.02, 1.4).name('大气顶比例');
fAtm.add(atm, 'rayleigh', 0, 3).name('瑞利强度');
fAtm.add(atm, 'mie', 0, 3).name('米氏强度');
fAtm.add(atm, 'mieG', 0.3, 0.95).name('米氏g(光晕)');
fAtm.add(atm, 'densityFalloff', 1, 20).name('密度衰减');
fAtm.add(atm, 'sunIntensity', 1, 60).name('太阳强度');
fAtm.add(atm, 'exposure', 0.2, 4).name('曝光(整屏)');
fAtm.add(atm, 'shadowSoftness', 0.05, 1.5).name('晨昏柔和');
fAtm.add(atm, 'twilight', 0, 1).name('暮光弧');
fAtm.add(atm, 'ozone', 0, 3).name('臭氧');
fAtm.add(atm, 'dither', 0, 1).name('抖动去带');
fAtm.add(atm, 'steps', 4, 32, 1).name('视线步数');
fAtm.add(atm, 'lightSteps', 2, 16, 1).name('太阳步数');
fAtm.add(atm, 'aces').name('ACES(整屏)');

// 近距体积云(每天体独立; 参数每帧读取 → 实时生效, 无需重建。只给最近一颗启用云的行星跑)
const fCloud = gui.addFolder('云 (近距)');
fCloud.add(cloud, 'enabled').name('启用云(本星球)');
fCloud.add(cloud, 'coverage', 0, 1).name('覆盖率');
fCloud.add(cloud, 'density', 0.1, 4).name('密度');
fCloud.add(cloud, 'bottomFrac', 1.0, 1.1).name('云底 ×R');
fCloud.add(cloud, 'topFrac', 1.01, 1.2).name('云顶 ×R');
fCloud.add(cloud, 'freq', 0.01, 0.2).name('云块频率');
fCloud.add(cloud, 'windSpeed', 0, 3).name('风速');
fCloud.add(cloud, 'silver', 0, 2).name('银边');
fCloud.add(cloud, 'powder', 0, 1).name('powder暗边');
fCloud.add(cloud, 'cloudShadow', 0, 1).name('云影投地表');
fCloud.add(cloud, 'steps', 8, 48, 1).name('视线步数');
fCloud.add(cloud, 'lightSteps', 2, 12, 1).name('太阳步数');
fCloud.close();

// 地形调色板(改颜色重建当前近距行星)
const fCol = gui.addFolder('地形颜色');
fCol.addColor(tune, 'colOceanShallow').name('浅海').onFinishChange(applyDetailRebuild);
fCol.addColor(tune, 'colOceanDeep').name('深海').onFinishChange(applyDetailRebuild);
fCol.addColor(tune, 'colBeach').name('海岸').onFinishChange(applyDetailRebuild);
fCol.addColor(tune, 'colWet').name('湿润低地/雨林').onFinishChange(applyDetailRebuild);
fCol.addColor(tune, 'colDry').name('干旱低地/荒漠').onFinishChange(applyDetailRebuild);
fCol.addColor(tune, 'colColdWet').name('针叶林').onFinishChange(applyDetailRebuild);
fCol.addColor(tune, 'colColdDry').name('苔原').onFinishChange(applyDetailRebuild);
fCol.addColor(tune, 'colRock').name('岩石/高山').onFinishChange(applyDetailRebuild);
fCol.addColor(tune, 'colSnow').name('雪').onFinishChange(applyDetailRebuild);
fCol.close();

// ----------------------------------------------------------------------------
// 气态行星: 勾选后用"纬向气带 shader 球"替代地形 LOD(无山脉/海洋)。参数实时生效。
// ----------------------------------------------------------------------------
const fGas = gui.addFolder('气态行星');
fGas.add(tune, 'gas').name('气态行星(替代地形)').onChange(() => { rebuildFocusDetail(); updateGuiForFocus(); });
fGas.addColor(tune, 'colGasA').name('气带色 A').onChange(applyGasLive);
fGas.addColor(tune, 'colGasB').name('气带色 B(亮)').onChange(applyGasLive);
fGas.addColor(tune, 'colGasC').name('气带色 C(暗)').onChange(applyGasLive);
fGas.add(tune, 'gasBands', 3, 40, 1).name('气带数').onChange(applyGasLive);
fGas.add(tune, 'gasWarp', 0, 2).name('湍流扭曲').onChange(applyGasLive);
fGas.add(tune, 'gasFlow', 0, 0.3).name('流动速度').onChange(applyGasLive);
fGas.close();

// 把气态参数写入气带 shader(颜色/气带数/流动等)
function applyGasUniforms(gas, body, t) {
  const u = gas.material.uniforms;
  const a = t.colGasA, b = t.colGasB, c = t.colGasC;
  u.uColA.value.setRGB(a[0], a[1], a[2]);
  u.uColB.value.setRGB(b[0], b[1], b[2]);
  u.uColC.value.setRGB(c[0], c[1], c[2]);
  u.uBands.value = t.gasBands;
  u.uWarp.value = t.gasWarp;
  u.uFlow.value = t.gasFlow;
  u.uSeed.value = ((t.seed || 0) % 100);   // 顶层种子 → 不同气态星纹路不同
}
// 气态参数实时生效(当前聚焦天体已是气态时直接更新其 uniforms, 无需重建)
function applyGasLive() {
  saveCfg(editingBody);
  const b = focusBody();
  const e = detailMap.get(b);
  if (e && e.gas) applyGasUniforms(e.gas, b, tune);
}
// 切换气态开关: 移除当前近距表现, 下一帧 manageDetail 按新配置(气态/地形)重建
function rebuildFocusDetail() {
  saveCfg(editingBody);
  const b = focusBody();
  if (b && detailMap.has(b)) removeDetail(b);
}

// ----------------------------------------------------------------------------
// 配置库: 把当前行星调好的参数存成命名预设, 一键套用到其它行星(保留各自种子 → 同风格不同地形);
// 也能导出/导入 .json 文件。所有预设 + 各行星配置都存 localStorage, 关掉重开自动恢复(记忆功能)。
// ----------------------------------------------------------------------------
const presetState = { name: '', selected: '' };
let presetCtrl = null;
const fPre = gui.addFolder('配置库 (跨行星复用)');
fPre.add(presetState, 'name').name('预设名');
fPre.add({ f: () => savePreset() }, 'f').name('▸ 保存当前行星为预设');
refreshPresetDropdown();
fPre.add({ f: () => deletePreset() }, 'f').name('删除选中预设');
fPre.add({ f: () => exportCfg() }, 'f').name('导出当前配置(下载 .json)');
fPre.add({ f: () => importCfg() }, 'f').name('导入配置(上传 → 当前行星)');

function refreshPresetDropdown() {
  const names = Object.keys(store.presets);
  const opts = names.length ? names : ['(无)'];
  presetCtrl = presetCtrl ? presetCtrl.options(opts) : fPre.add(presetState, 'selected', opts);
  presetCtrl.name('加载预设 → 当前行星').onChange((v) => { if (v && v !== '(无)') applyPreset(v); });
  presetCtrl.updateDisplay();
}
// 保存当前聚焦行星的配置为命名预设(写 localStorage, 跨重启保留)
function savePreset() {
  const name = (presetState.name || '').trim();
  if (!name) { alert('请先在“预设名”里填个名字'); return; }
  if (!editingBody) { alert('请先聚焦一颗行星再保存'); return; }
  saveCfg(editingBody);
  store.presets[name] = JSON.parse(JSON.stringify(editingBody.cfg));
  lsSave();
  presetState.selected = name;
  refreshPresetDropdown();
}
// 套用某预设到当前聚焦行星: 复制 tune/atm/cloud, 但保留本行星原有种子 → 同风格、不同地形。
function applyPreset(name) {
  const preset = store.presets[name];
  const b = focusBody();
  if (!preset || !b) return;
  const cfg = JSON.parse(JSON.stringify(preset));
  if (!cfg.tune) { alert('预设格式无效'); return; }
  const keepSeed = (b.cfg && b.cfg.tune.seed != null) ? b.cfg.tune.seed : hashSeed(b.name);
  cfg.tune.seed = keepSeed;      // 关键: 不覆盖本行星种子(否则地形和源行星一模一样)
  b.cfg = cfg;
  editingBody = b;
  cfgRestore(cfg);               // 写进实时 tune/atm/cloud + 刷新 GUI 显示
  persistBody(b);
  applyDetailRebuild();          // 重建近距行星使之生效
}
function deletePreset() {
  const n = presetState.selected;
  if (n && store.presets[n]) { delete store.presets[n]; lsSave(); presetState.selected = ''; refreshPresetDropdown(); }
}
// 导出当前聚焦行星配置为 .json 文件(备份 / 分享 / 提交进 git)
function exportCfg() {
  if (editingBody) saveCfg(editingBody);
  const cfg = editingBody ? editingBody.cfg : cfgSnapshot();
  const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = (params.focus || 'planet') + '-config.json';
  a.click();
  URL.revokeObjectURL(url);
}
// 从 .json 文件导入配置到当前聚焦行星(同样保留本行星种子)
function importCfg() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'application/json,.json';
  inp.onchange = () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const cfg = JSON.parse(r.result);
        const b = focusBody();
        if (!b || !cfg.tune) throw new Error('配置缺少 tune 字段');
        const keepSeed = (b.cfg && b.cfg.tune.seed != null) ? b.cfg.tune.seed : hashSeed(b.name);
        cfg.tune.seed = keepSeed;
        b.cfg = cfg;
        editingBody = b;
        cfgRestore(cfg);
        persistBody(b);
        applyDetailRebuild();
      } catch (e) { alert('配置解析失败: ' + e.message); }
    };
    r.readAsText(f);
  };
  inp.click();
}

// 聚焦恒星时隐藏所有行星调参面板(恒星无需调参); 聚焦行星/卫星时显示。
function updateGuiForFocus() {
  const b = focusBody();
  const showTune = !!b && b.type !== 'star';
  for (const f of [fLOD, fAtm, fCloud, fCol, fGas, fPre]) if (f) (showTune ? f.show() : f.hide());
  if (radiusCtrl) (showTune ? radiusCtrl.show() : radiusCtrl.hide());
}

// 任意 GUI 改动 → 防抖持久化当前行星配置; 关闭页面前再存一次(记忆功能的兜底)
gui.onChange(persistSoon);
addEventListener('beforeunload', () => { persistFocused(); persistParams(); });

// ----------------------------------------------------------------------------
// 主循环: 固定步长物理 + 浮动原点渲染
// ----------------------------------------------------------------------------
const hud = document.getElementById('hud');
const clock = new THREE.Clock();
const FIXED_DT = 0.02;            // 物理子步上限(单步最大模拟时间, 保证积分精度)
const MAX_SUBSTEPS = 40;          // 每帧最多物理子步(极慢帧不追帧, 防螺旋)
let e0 = null, cloudTime = 0;

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  if (walker) { walker.camera.aspect = innerWidth / innerHeight; walker.camera.updateProjectionMatrix(); }
  renderer.setSize(innerWidth, innerHeight);
  const pr = renderer.getPixelRatio();
  const rw = Math.floor(innerWidth * pr), rh = Math.floor(innerHeight * pr);
  sceneRT.setSize(rw, rh);
  rtPing.setSize(rw, rh);
  rtPong.setSize(rw, rh);
});

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  cloudTime += dt;   // 云飘动时间(不受暂停影响)

  if (!params.paused && params.timeScale > 0) {
    // 半固定步长: 每帧恰好推进"这一帧的模拟时间"(dt×流速), 拆成不超过 FIXED_DT 的子步。
    // 于是任意流速(尤其慢放)下每帧都平滑推进一点, 不再"攒够一整步才跳一下"的顿挫。
    let remaining = dt * params.timeScale;
    let steps = 0;
    while (remaining > 1e-6 && steps < MAX_SUBSTEPS) {
      const h = Math.min(FIXED_DT, remaining);
      system.step(h);
      remaining -= h;
      steps++;
    }
  }

  if (charMode) walker.update(dt);   // 角色: WASD/鼠标驱动, 相机由 walker 管理
  else controls.update();
  manageDetail();
  updateRender();
  if (charMode) {
    // 角色模式: walker 自管相机 near/far; 星空只需跟随角色相机
    walker.camera.getWorldPosition(_tmpV);
    starField.position.copy(_tmpV);
    starField.scale.setScalar(walker.camera.far * 0.9);
  } else {
    updateCameraRange();   // 动态 near/far(在场景渲染前设好投影)
  }

  // 场景 → HDR RT(带深度)。角色模式下用角色相机渲染整条管线。
  const rcam = renderCam();
  renderer.setRenderTarget(sceneRT);
  renderer.clear();
  renderer.render(scene, rcam);
  renderer.setRenderTarget(null);

  // 管线: 场景 → (最近一颗启用云的行星: 云 pass) → 每颗启用大气的行星(ping-pong) → 屏幕(末端 tonemap)。
  // 逆 view-proj / 相机世界坐标 大气和云都要, 先算一次。
  _pv.multiplyMatrices(rcam.projectionMatrix, rcam.matrixWorldInverse);
  _ivp.copy(_pv).invert();
  rcam.getWorldPosition(_camW);

  // ---- 云 pass: 只给最近的、启用云、且相机够近的一颗行星跑(体积 raymarch 很贵) ----
  let cloudEntry = null, cloudD = Infinity;
  if (params.detailClouds) {
    for (const [body, e] of detailMap) {
      if (e.gas) continue;                 // 气态行星不跑地形云 pass(气带 shader 自带表现)
      const c = cloudFor(body);
      if (!c.enabled) continue;
      const d = camDistTo(body);
      if (d < body.radius * ATMO_DIST && d < cloudD) { cloudD = d; cloudEntry = { body, planet: e.planet, c }; }
    }
  }
  let srcTex = sceneRT.texture, srcRT = null;
  if (cloudEntry) {
    const cu = cloudPass.uniforms;
    cu.tDiffuse.value = sceneRT.texture;
    cu.tDepth.value = sceneRT.depthTexture;
    cu.uInvViewProj.value.copy(_ivp);
    cu.uCamPos.value.copy(_camW);
    cu.uTime.value = cloudTime;
    applyCloudUniforms(cu, cloudEntry.body, cloudEntry.planet, cloudEntry.c);
    renderer.setRenderTarget(rtPing);
    cloudPass.render(renderer);      // 输出线性 HDR(不 tonemap), 交给大气 pass
    srcTex = rtPing.texture; srcRT = rtPing;
  }

  // ---- 深度感知大气 pass: 每颗"启用大气"的行星各跑一次(ping-pong 累积), 只有最后一次做 tonemap ----
  const u = atmoPass.uniforms;
  u.tDepth.value = sceneRT.depthTexture;
  u.uInvViewProj.value.copy(_ivp);
  u.uCamPos.value.copy(_camW);
  // 整屏末端参数(曝光/tonemap/抖动 用聚焦天体设定)
  u.uExposure.value = atm.exposure;
  u.uTonemap.value = atm.aces ? 1 : 0;
  u.uDither.value = atm.dither;

  // 收集要跑大气的行星: 启用大气 + 相机足够近, 取最近 MAX_ATMO 颗。
  const atmoList = [];
  if (params.detailAtmo) {
    for (const [body, e] of detailMap) {
      if (e.gas) continue;                 // 气态行星不跑地形大气 pass
      const a = atmFor(body);
      if (a.enabled === false) continue;
      const d = camDistTo(body);
      if (d < body.radius * ATMO_DIST) atmoList.push({ body, planet: e.planet, a, d });
    }
    atmoList.sort((x, y) => x.d - y.d);
    if (atmoList.length > MAX_ATMO) atmoList.length = MAX_ATMO;
  }

  if (atmoList.length === 0) {
    // 无大气: 把当前源(场景或云输出)直通 tonemap 到屏幕
    u.uEnabled.value = 0.0;
    u.uToneOut.value = 1.0;
    u.tDiffuse.value = srcTex;
    renderer.setRenderTarget(null);
    atmoPass.render(renderer);
  } else {
    // 逐行星合成; 中间 pass 输出线性 HDR(uToneOut=0), 最后一次 tonemap 落地屏幕。
    // 每次写到"当前源不在"的那张 RT, 避免读写同一 RT。
    let src = srcTex, curRT = srcRT;
    for (let i = 0; i < atmoList.length; i++) {
      const last = (i === atmoList.length - 1);
      applyAtmoUniforms(u, atmoList[i].body, atmoList[i].planet, atmoList[i].a);
      u.tDiffuse.value = src;
      u.uToneOut.value = last ? 1.0 : 0.0;
      if (last) {
        renderer.setRenderTarget(null);
        atmoPass.render(renderer);
      } else {
        const dst = (curRT === rtPing) ? rtPong : rtPing;
        renderer.setRenderTarget(dst);
        atmoPass.render(renderer);
        src = dst.texture; curRT = dst;
      }
    }
  }

  const e = system.energy();
  if (e0 === null) e0 = e.total;
  const drift = e0 !== 0 ? ((e.total - e0) / Math.abs(e0) * 100) : 0;
  const hint = charMode
    ? `角色: ${params.focus} · 点击锁定视角 · WASD 移动 · 空格跳 · 鼠标看 · ESC 释放(取消勾选退出)`
    : `聚焦: ${params.focus} · 点击天体切换观察中心 · 拖动旋转 · 滚轮缩放`;
  hud.innerHTML =
    `天体: ${system.bodies.length} · G=${params.G.toFixed(2)} · t=${system.time.toFixed(0)}<br>` +
    `总能量: ${e.total.toExponential(3)} · 漂移: ${drift.toFixed(3)}%(越小越稳)<br>` +
    hint;
}

restoreParams();                 // 恢复上次的 Controls 参数(localStorage) → 无需每次重调
rebuild();                       // 用恢复后的 G/软化/全局尺度/聚焦 重建星系
gui.controllersRecursive().forEach((c) => c.updateDisplay());   // 同步所有控件显示为恢复值
if (params.worldScale !== 1) frameFocus();   // 恢复了非默认尺度: 重新构图, 避免相机卡进放大后的星体
animate();
