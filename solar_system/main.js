// 太阳系 P1 — N-body 物理内核可视化(独立于主行星项目)。
//
// float64 物理(nbody.js) + 浮动原点渲染: 每帧把所有天体减去"聚焦天体"的位置, 送进 GPU 的
// 只是聚焦点附近的小坐标 → 即使真实坐标很大也不丢精度。对数深度处理巨大景深。
// GUI 可调 G(演示: 同质量下调 G → 轨道整体缩放)、时间倍率、软化、聚焦切换、轨迹、暂停。

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import GUI from 'lil-gui';
import { Body, NBodySystem } from './nbody.js';
import { Planet } from '../planet.js';       // 复用主项目的 LOD 地形行星(近距详细表现)

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
  detail: true,       // 近距切换到 LOD 地形行星
  focus: '恒星',
};

const ORBIT_SEG = 192;   // 每条轨道椭圆的采样段数

// ----------------------------------------------------------------------------
// three 基础
// ----------------------------------------------------------------------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x03040a);

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.5, 1e8);
camera.position.set(0, 1600, 3800);

const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 20;
controls.maxDistance = 5e6;

scene.add(new THREE.AmbientLight(0xffffff, 0.28));
const sunLight = new THREE.PointLight(0xffffff, 3.5, 0, 0);   // decay=0: 全系统可见(P1 不追求光照真实)
scene.add(sunLight);

// 星空背景
(function stars() {
  const g = new THREE.BufferGeometry();
  const n = 2000, p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(4e6);
    p[i * 3] = v.x; p[i * 3 + 1] = v.y; p[i * 3 + 2] = v.z;
  }
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0x8899aa, size: 6000, sizeAttenuation: true })));
})();

// ----------------------------------------------------------------------------
// 系统构建
// ----------------------------------------------------------------------------
let system, entries, starBody, particlePoints = null;
const _off = new THREE.Vector3();      // 浮动原点偏移(聚焦天体位置)
const _AX = new THREE.Vector3(1, 0, 0);

function buildSystem() {
  system = new NBodySystem({ G: params.G, softening: params.softening });
  starBody = system.add(new Body({
    name: CONFIG.star.name, mass: CONFIG.star.mass, radius: CONFIG.star.radius,
    color: CONFIG.star.color, type: 'star',
  }));
  for (const p of CONFIG.planets) {
    const planet = system.addOrbiting(starBody, {
      mass: p.mass, radius: p.radius, dist: p.dist, phase: p.phase,
      inclination: p.incl, color: p.color, name: p.name, type: 'planet',
    });
    // 行星的希尔半径(与 G 无关): a·(m_p / 3·m_star)^(1/3)
    const hill = p.dist * Math.cbrt(p.mass / (3 * CONFIG.star.mass));
    for (const m of p.moons) {
      const dist = Math.max(m.hillFrac * hill, p.radius * 2.0);   // 稳定区内, 且不埋进行星
      system.addOrbiting(planet, {
        mass: m.mass, radius: m.radius, dist, phase: m.phase,
        inclination: m.incl, color: m.color, name: m.name, type: 'moon',
      });
    }
  }
  system.zeroMomentum();
}

// 小行星带(绕恒星) + 行星环(绕某行星), 都是测试粒子。zeroMomentum 之后再加(不参与动量)。
function buildParticles() {
  const bc = CONFIG.belt;
  for (let i = 0; i < bc.count; i++) {
    const r = bc.inner + Math.random() * (bc.outer - bc.inner);
    const ph = Math.random() * Math.PI * 2;
    const pos = new THREE.Vector3(Math.cos(ph) * r, (Math.random() - 0.5) * bc.thickness, Math.sin(ph) * r).add(starBody.pos);
    const vmag = Math.sqrt(system.G * starBody.mass / r) * (0.98 + Math.random() * 0.04);
    const vel = new THREE.Vector3(-Math.sin(ph), 0, Math.cos(ph)).multiplyScalar(vmag).add(starBody.vel);
    system.addParticle(pos, vel);
  }
  const rc = CONFIG.ring;
  const planet = system.bodies.find((b) => b.name === rc.planet);
  if (planet) {
    for (let i = 0; i < rc.count; i++) {
      const r = rc.inner + Math.random() * (rc.outer - rc.inner);
      const ph = Math.random() * Math.PI * 2;
      const pos = new THREE.Vector3(Math.cos(ph) * r, (Math.random() - 0.5) * rc.thickness, Math.sin(ph) * r)
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
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(system.particles.length * 3), 3));
  particlePoints = new THREE.Points(geo, new THREE.PointsMaterial({
    color: 0x9aa2b2, size: 3.2, sizeAttenuation: true, transparent: true, opacity: 0.9,
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
  clearDetail();
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
    e.mesh.visible = (e.body !== detailBody);   // 详细行星显示时隐藏对应简单球
    if (e.line) e.line.visible = params.orbits && writeOrbit(e.body, e.line);
  }
  // 小行星带 / 环粒子(相对浮动原点)
  if (particlePoints) {
    if (params.showBelt) {
      const arr = particlePoints.geometry.attributes.position.array;
      const P = system.particles;
      for (let i = 0; i < P.length; i++) {
        arr[i * 3] = P[i].pos.x - _off.x; arr[i * 3 + 1] = P[i].pos.y - _off.y; arr[i * 3 + 2] = P[i].pos.z - _off.z;
      }
      particlePoints.geometry.attributes.position.needsUpdate = true;
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
gui.add(params, 'timeScale', 0.0, 8.0).name('时间倍率');
gui.add(params, 'softening', 0.1, 20).name('软化(防奇点)').onFinishChange(() => { system.softening = params.softening; });
gui.add(params, 'paused').name('暂停');
gui.add(params, 'orbits').name('轨道线(完整椭圆)');
gui.add(params, 'showBelt').name('小行星带/环');
gui.add(params, 'detail').name('近距地形(LOD)');
let focusCtrl = gui.add(params, 'focus', ['恒星']).name('聚焦天体');
gui.add({ reset: rebuild }, 'reset').name('重置星系');
gui.add({ recenter: () => { controls.target.set(0, 0, 0); } }, 'recenter').name('相机对准聚焦');

function refreshFocusOptions() {
  const names = system.bodies.map((b) => b.name);
  focusCtrl = focusCtrl.options(names).name('聚焦天体');
  if (!names.includes(params.focus)) params.focus = names[0];
  focusCtrl.setValue(params.focus);
}

// 设置观察中心(聚焦天体), 相机自动对准并拉到合适距离
function setFocus(body) {
  params.focus = body.name;
  focusCtrl.setValue(body.name);
  const d = THREE.MathUtils.clamp(body.radius * 8, controls.minDistance, controls.maxDistance);
  if (camera.position.lengthSq() > 1e-6) camera.position.setLength(d);
  controls.target.set(0, 0, 0);
  controls.update();
}

// 点击天体切换观察中心(区分点击/拖动)
const _raycaster = new THREE.Raycaster();
const _pointer = new THREE.Vector2();
let _downXY = null;
renderer.domElement.addEventListener('pointerdown', (e) => { _downXY = { x: e.clientX, y: e.clientY }; });
renderer.domElement.addEventListener('pointerup', (e) => {
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
let detailPlanet = null, detailBody = null;

// 近距行星的共享 LOD/地形调参(所有近距行星共用; 地形种子仍按天体名区分)
const tune = {
  maxLevel: 8, splitFactor: 2.5, patchResolution: 16, frustumMargin: 0.15,
  nearRadiusFrac: 0.5, maxHeightFrac: 0.06,
  continentFreq: 1.2, continentOctaves: 5, mountainFreq: 3.0, mountainStrength: 0.6,
  warpStrength: 0.2, plateStrength: 0.5, useClimate: true,
};

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 99999;
}
function planetParamsFor(body) {
  const s = hashSeed(body.name);
  return {
    radius: body.radius, maxHeight: body.radius * tune.maxHeightFrac, seaLevel: 0.0,
    patchResolution: tune.patchResolution, maxLevel: tune.maxLevel, splitFactor: tune.splitFactor,
    nearRadius: body.radius * tune.nearRadiusFrac, frustumMargin: tune.frustumMargin,
    continentSeed: s, continentFreq: tune.continentFreq, continentOctaves: tune.continentOctaves,
    continentGain: 0.5, continentLacunarity: 2.0,
    mountainSeed: s + 11, mountainFreq: tune.mountainFreq, mountainOctaves: 5, mountainStrength: tune.mountainStrength,
    warpSeed: s + 23, warpStrength: tune.warpStrength, warpFreq: 1.0,
    plateSeed: s + 37, plateFreq: 1.6, plateStrength: tune.plateStrength,
    moistureSeed: s + 51, moistureFreq: 1.2, useClimate: tune.useClimate, climateAltRange: 1.0,
  };
}
// LOD 类参数: 写入当前近距行星, 实时生效(无需重建)
function applyLODLive() {
  if (!detailPlanet || !detailBody) return;
  const p = detailPlanet.params;
  p.maxLevel = tune.maxLevel; p.splitFactor = tune.splitFactor; p.frustumMargin = tune.frustumMargin;
  p.nearRadius = detailBody.radius * tune.nearRadiusFrac;
}
// 结构/地形类参数: 需要重建当前近距行星
function applyDetailRebuild() {
  if (!detailPlanet || !detailBody) return;
  Object.assign(detailPlanet.params, planetParamsFor(detailBody));
  detailPlanet.rebuild();
}
function setDetail(body) {
  clearDetail();
  detailPlanet = new Planet(planetParamsFor(body));
  scene.add(detailPlanet);       // 位于原点 = 浮动原点中心(聚焦天体处)
  detailBody = body;
}
function clearDetail() {
  if (detailPlanet) {
    for (const r of detailPlanet.roots) r.dispose(detailPlanet);
    detailPlanet.clear();
    for (const w of detailPlanet.workers) w.terminate();
    scene.remove(detailPlanet);
    detailPlanet = null;
  }
  detailBody = null;
}
// 距离阈值带迟滞, 避免临界抖动
function manageDetail() {
  if (!params.detail) { if (detailBody) clearDetail(); return; }
  const f = focusBody();
  const dist = camera.position.length();     // 浮动原点下 = 相机到聚焦天体距离
  const R = f.radius;
  const canDetail = f.type !== 'star';
  if (canDetail && dist < R * 24) {
    if (detailBody !== f) setDetail(f);
  } else if (detailBody && (dist > R * 34 || detailBody !== f || !canDetail)) {
    clearDetail();
  }
  if (detailPlanet) detailPlanet.update(camera);
}

// 近距行星 LOD/地形 GUI(LOD 类实时生效; 结构/地形类重建当前近距行星)
const fLOD = gui.addFolder('近距行星 (LOD/地形)');
fLOD.add(tune, 'maxLevel', 0, 12, 1).name('最大层数').onChange(applyLODLive);
fLOD.add(tune, 'splitFactor', 1, 5).name('细分激进度').onChange(applyLODLive);
fLOD.add(tune, 'frustumMargin', 0, 0.5).name('视锥余量').onChange(applyLODLive);
fLOD.add(tune, 'nearRadiusFrac', 0, 2).name('预细分半径 ×R').onChange(applyLODLive);
fLOD.add(tune, 'patchResolution', [4, 8, 16, 32]).name('patch 分辨率').onChange(applyDetailRebuild);
fLOD.add(tune, 'maxHeightFrac', 0, 0.2).name('地形起伏 ×R').onFinishChange(applyDetailRebuild);
fLOD.add(tune, 'continentFreq', 0.2, 4).name('大陆频率').onFinishChange(applyDetailRebuild);
fLOD.add(tune, 'continentOctaves', 1, 8, 1).name('大陆八度').onFinishChange(applyDetailRebuild);
fLOD.add(tune, 'mountainFreq', 0.5, 8).name('山脉频率').onFinishChange(applyDetailRebuild);
fLOD.add(tune, 'mountainStrength', 0, 1.5).name('山脉强度').onFinishChange(applyDetailRebuild);
fLOD.add(tune, 'warpStrength', 0, 0.6).name('域扭曲').onFinishChange(applyDetailRebuild);
fLOD.add(tune, 'plateStrength', 0, 1.2).name('板块带').onFinishChange(applyDetailRebuild);
fLOD.add(tune, 'useClimate').name('气候配色').onChange(applyDetailRebuild);

// ----------------------------------------------------------------------------
// 主循环: 固定步长物理 + 浮动原点渲染
// ----------------------------------------------------------------------------
const hud = document.getElementById('hud');
const clock = new THREE.Clock();
const FIXED_DT = 0.02;            // 每物理步的模拟时间
let accum = 0, e0 = null;

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  if (!params.paused && params.timeScale > 0) {
    accum += dt * params.timeScale;
    let steps = 0;
    while (accum >= FIXED_DT && steps < 12) { system.step(FIXED_DT); accum -= FIXED_DT; steps++; }
    if (steps >= 12) accum = 0;   // 防止追帧螺旋
  }

  controls.update();
  manageDetail();
  updateRender();
  renderer.render(scene, camera);

  const e = system.energy();
  if (e0 === null) e0 = e.total;
  const drift = e0 !== 0 ? ((e.total - e0) / Math.abs(e0) * 100) : 0;
  hud.innerHTML =
    `天体: ${system.bodies.length} · G=${params.G.toFixed(2)} · t=${system.time.toFixed(0)}<br>` +
    `总能量: ${e.total.toExponential(3)} · 漂移: ${drift.toFixed(3)}%(越小越稳)<br>` +
    `聚焦: ${params.focus} · 点击天体切换观察中心 · 拖动旋转 · 滚轮缩放`;
}

rebuild();
animate();
