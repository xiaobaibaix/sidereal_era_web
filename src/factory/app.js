// 工厂 App 集成模块 —— 把"工厂系统 + 渲染 + 属性面板 + 建造面板 + 点选/点火 + toast"打包,
// 供 planet_system 与 solar_system 共用(避免两处重复上百行 UI)。
//
// 用法:
//   const app = createFactoryApp({ scene, renderer, container, getPlanet, getCamera, onModeActivate, isInspectIdle });
//   app.factory.ctx.applyThrust = (acc)=>{...};   // solar 里把推力接到聚焦行星 body.externalAcc
//   // animate 里:  app.tick(dt);
//   // 换聚焦行星:   app.setPlanet(newPlanet);
//
// 依赖注入(与宿主解耦):
//   getPlanet()        当前详细地形行星(点选 anchorPick + 渲染用)
//   getCamera()        当前主渲染相机(点选用)
//   onModeActivate()   进入某放置模式时调用(宿主关掉自己的手动挖掘/挖机选区, 避免抢点击)
//   isInspectIdle()    是否允许"点击查看属性"(宿主: 未在手动挖掘/挖机选区时)

import * as THREE from 'three';
import GUI from 'lil-gui';
import { createFactory } from './factory.js';
import gameData from './data/gamedata.js';
import { createMiningCrewSystem, setDigZone, spawnExcavators, spawnMineTrucks } from './systems/mining_crew.js';
import { createProductionSystem } from './systems/production.js';
import { createPowerSystem } from './systems/power.js';
import { createResearchSystem } from './systems/research.js';
import { createConstructionSystem } from './systems/construction.js';
import { createEngineSystem } from './systems/engine.js';
import { createLogisticsSystem, spawnHaulers } from './systems/logistics.js';
import { createBeltSystem } from './systems/belt.js';
import { createInserterSystem } from './systems/inserter.js';
import { createSplitterSystem } from './systems/splitter.js';
import { placeBuilding, demolish, placeBelt, placeInserter, placeSplitter, linkBelts } from './systems/placement.js';
import { angle as sphAngle } from './core/sphere.js';
import { createFactoryRenderer } from './render/factory_render.js';
import { createInspector } from './render/inspector.js';
import { pick as anchorPick } from './core/anchor.js';

export function createFactoryApp(opts) {
  const {
    scene, renderer, container,
    getPlanet, getCamera,
    onModeActivate = () => {},
    isInspectIdle = () => true,
    planetMass = 1e6, size = 1,
  } = opts;

  const factory = createFactory({ planet: getPlanet(), data: gameData });
  // tick 顺序(见《物流升级》设计 D.5): 先生产, 再"上带→带前进→分流→下带", 然后站间卡车, 最后科研/发动机。
  // 单向数据流, 天然无环: 先把货放上带 → 带走一格 → 分流 → 下带 → 卡车站间搬。
  factory.addSystem('mining_crew', createMiningCrewSystem());        // 矿场小队: 挖机挖 → 采矿车运进矿场
  factory.addSystem('power', createPowerSystem());                   // M4: 输电塔组网 + 供需满足率(须在 production 前)
  factory.addSystem('production', createProductionSystem());         // M3: 冶炼/制造按配方产出(缺电降速)
  factory.addSystem('construction', createConstructionSystem());     // M6: 行星发动机分阶段建造
  factory.addSystem('inserter_load', createInserterSystem({ phase: 'load' }));    // B1: 上带分拣器(机器→带), 须在 belt 前
  factory.addSystem('belt', createBeltSystem());                     // B0: 带上物品前进 + 背压 + 到头投递
  factory.addSystem('splitter', createSplitterSystem());             // B3: 分流器合流/分流/路由(带之后)
  factory.addSystem('inserter_unload', createInserterSystem({ phase: 'unload' }));// B1: 下带分拣器(带→机器/站/仓库), 带之后
  factory.addSystem('logistics', createLogisticsSystem());           // M2a/B2: 卡车(有站点→站间; 无站点→旧直连)
  factory.addSystem('research', createResearchSystem());             // M5: 研究站→发展度→解锁科技
  factory.addSystem('engine', createEngineSystem());                 // M7: 点火燃烧→推力(经 ctx.applyThrust)
  factory.ctx.planetMass = planetMass;

  const factoryRenderer = createFactoryRenderer(scene, getPlanet(), { size });
  const inspector = createInspector({ getWorld: () => factory.world, registry: factory.registry, getPower: () => factory.ctx.power });
  const _ray = new THREE.Raycaster();
  const _ndc = new THREE.Vector2();
  let _acc = 0; const FIXED = 0.05;

  // ---- toast(顶部居中一次性提示) ----
  const toastEl = document.createElement('div');
  toastEl.style.cssText = 'position:fixed;left:50%;top:64px;transform:translateX(-50%);z-index:60;display:none;padding:10px 16px;border-radius:10px;font:13px/1.4 -apple-system,system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,0.5);pointer-events:none;max-width:70vw;text-align:center;';
  document.body.appendChild(toastEl);
  let _toastTimer = 0;
  function showToast(msg, warn) {
    toastEl.textContent = msg;
    toastEl.style.color = warn ? '#ffd7d0' : '#dbeafe';
    toastEl.style.background = warn ? 'rgba(44,22,20,0.95)' : 'rgba(20,26,34,0.95)';
    toastEl.style.border = `1px solid ${warn ? 'rgba(255,120,100,0.55)' : 'rgba(120,180,255,0.45)'}`;
    toastEl.style.display = 'block';
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { toastEl.style.display = 'none'; }, 2600);
  }

  // ---- 建造面板 ----
  const fpTool = {
    mode: '关闭',
    excavatorCount: 3, spawnExcavators() { doSpawnExcavators(); },
    mineTruckCount: 3, spawnMineTrucks() { doSpawnMineTrucks(); },
    haulerCount: 3, spawnHaulers() { doSpawnHaulers(); },
    showRanges: false, status: '待命',
  };
  let _fpDown = null;
  let _beltStart = null;   // 传送带折线放置: 当前段起点(球面方向)
  let _beltPrev = null;    // 上一段带实体(用于带↔带直连成折线)
  const fpGui = new GUI({ title: '🏭 工厂', container });
  fpGui.add(fpTool, 'mode', ['关闭', '放置矿场', '圈定挖掘区', '放置冶炼炉', '放置制造台', '放置研究站', '放置仓库', '放置输电塔', '放置发电机', '放置发动机', '点火发动机',
    '放置传送带', '放置分拣器·上料', '放置分拣器·下料', '放置过滤分拣器·上料', '放置过滤分拣器·下料', '放置分流器', '放置装货站', '放置卸货站', '拆除']).name('模式').listen()
    .onChange((v) => { if (v !== '关闭') onModeActivate(); _beltStart = null; _beltPrev = null; });
  fpGui.add(fpTool, 'excavatorCount', 1, 20, 1).name('挖机数量');
  fpGui.add(fpTool, 'spawnExcavators').name('生成挖机');
  fpGui.add(fpTool, 'mineTruckCount', 1, 20, 1).name('采矿车数量');
  fpGui.add(fpTool, 'spawnMineTrucks').name('生成采矿车');
  fpGui.add(fpTool, 'haulerCount', 1, 20, 1).name('物流车数量');
  fpGui.add(fpTool, 'spawnHaulers').name('生成物流车');
  fpGui.add(fpTool, 'showRanges').name('显示可点击范围').onChange((v) => factoryRenderer.showPickRanges(v));
  fpGui.add(fpTool, 'status').name('状态').listen().disable();

  // ---- 科技面板 ----
  const techTool = { dev: '0', status: '放置研究站并送入铁锭以提升发展度' };
  const techGui = new GUI({ title: '🔬 科技', container });
  techGui.add(techTool, 'dev').name('发展度').listen().disable();
  techGui.add(techTool, 'status').name('科技').listen().disable();

  // ---- 🛠 调试面板 ----
  const dbgTool = {
    infiniteFuel: false,
    unlockAll() {
      factory.registry.unlockAll();
      const colony = factory.ctx.colony || (factory.ctx.colony = { dev: 0, researched: new Set() });
      if (!colony.researched) colony.researched = new Set();
      colony.dev = Math.max(colony.dev, 99999);
      for (const id in (factory.registry.tech || {})) colony.researched.add(id);
      showToast('🛠 已解锁全部科技(可放置所有建筑)', false);
    },
    buildEngines() {
      let n = 0;
      for (const e of factory.world.query('Construction')) { const c = factory.world.get(e, 'Construction'); if (!c.done) { c.stage = 999; c.done = true; c.built = true; n++; } }
      showToast(n > 0 ? `🛠 ${n} 台行星发动机已立即建成(切「点火发动机」或在属性面板点火)` : '当前没有在建的发动机', n === 0);
    },
  };
  const dbgGui = new GUI({ title: '🛠 调试', container });
  dbgGui.add(dbgTool, 'unlockAll').name('一键解锁全部科技');
  dbgGui.add(dbgTool, 'buildEngines').name('一键建成发动机');
  dbgGui.add(dbgTool, 'infiniteFuel').name('无限燃料').onChange((v) => { factory.ctx.infiniteFuel = v; });
  dbgGui.close();
  function updateResearchStatus() {
    const colony = factory.ctx.colony;
    techTool.dev = (colony ? colony.dev : 0).toFixed(0);
    const tech = factory.registry.tech || {};
    const parts = [];
    for (const id in tech) {
      const t = tech[id];
      const done = colony && colony.researched && colony.researched.has(id);
      parts.push(`${t.name}${done ? '✓' : `✗(需${(t.require && t.require.dev) || 0})`}`);
    }
    if (parts.length) techTool.status = parts.join(' · ');
  }

  function firstDepotWithZone() {
    let any = null;
    for (const e of factory.world.query('Depot', 'DigZone')) {
      if (any == null) any = e;
      const dz = factory.world.get(e, 'DigZone');
      if (dz && dz.zones && dz.zones.length > 0) return e;
    }
    return any;
  }
  function doSpawnExcavators() {
    const depot = firstDepotWithZone();
    if (depot == null) { showToast('请先放置矿场', true); return; }
    const dz = factory.world.get(depot, 'DigZone');
    if (!dz || !dz.zones || dz.zones.length === 0) { showToast('请先圈定挖掘区(模式选「圈定挖掘区」点矿场旁)', true); return; }
    spawnExcavators(factory.world, factory.ctx, fpTool.excavatorCount, depot);
    showToast(`已生成 ${fpTool.excavatorCount} 台挖机`, false);
  }
  function doSpawnMineTrucks() {
    const depot = firstDepotWithZone();
    if (depot == null) { showToast('请先放置矿场', true); return; }
    spawnMineTrucks(factory.world, factory.ctx, fpTool.mineTruckCount, depot);
    showToast(`已生成 ${fpTool.mineTruckCount} 辆采矿车`, false);
  }
  function doSpawnHaulers() {
    let nearDir = [0, 1, 0];
    const depot = factory.world.query('Depot', 'Anchor').next().value;
    if (depot != null) nearDir = [...factory.world.get(depot, 'Anchor').dir];
    else { const wh = factory.world.query('Storage', 'Anchor').next().value; if (wh != null) nearDir = [...factory.world.get(wh, 'Anchor').dir]; }
    spawnHaulers(factory.world, factory.ctx, fpTool.haulerCount, 'hauler_mk1', nearDir);
    showToast(`已生成 ${fpTool.haulerCount} 辆物流车`, false);
  }

  function requiredTechFor(buildingId) {
    const tech = factory.registry.tech || {};
    for (const id in tech) { const t = tech[id]; if (t.unlock && t.unlock.buildings && t.unlock.buildings.includes(buildingId)) return t; }
    return null;
  }
  function tryPlace(buildingId, dir, okMsg) {
    const b = factory.registry.buildings[buildingId];
    if (b && b.locked && !factory.registry.isUnlocked(buildingId)) {
      const t = requiredTechFor(buildingId);
      showToast(`${b.name}未解锁${t ? ` · 需研究「${t.name}」(发展度 ${(t.require && t.require.dev) || 0})` : ''}`, true);
      return null;
    }
    const e = placeBuilding(factory.world, factory.ctx, buildingId, dir);
    if (e != null && okMsg) showToast(okMsg, false);
    return e;
  }

  // 科技锁提示(带/分拣器/分流器/站): 未解锁则 toast 并返回 false
  function checkUnlocked(buildingId) {
    const b = factory.registry.buildings[buildingId];
    if (b && b.locked && !factory.registry.isUnlocked(buildingId)) {
      const t = requiredTechFor(buildingId);
      showToast(`${(b && b.name) || buildingId}未解锁${t ? ` · 需研究「${t.name}」(发展度 ${(t.require && t.require.dev) || 0})` : ''}`, true);
      return false;
    }
    return true;
  }
  const nearestBelt = (dir) => factory.spatial.nearest(dir, (id) => factory.world.has(id, 'Belt'));
  // 最近的"带货口建筑"(机器/仓库/站): 有 Inventory 且不是带/分拣器/分流器
  const nearestBuilding = (dir) => factory.spatial.nearest(dir, (id) =>
    factory.world.has(id, 'Inventory') && !factory.world.has(id, 'Belt'));

  // 放置带(折线的一段): 从 _beltStart→dir 成带, 并与上一段带↔带直连; 终点成为下一段起点(可继续延伸)
  function placeBeltSegment(dir) {
    const from = _beltStart;
    if (sphAngle(from, dir) < 1e-3) { showToast('两点太近, 请点更远处', true); return; }
    const e = placeBelt(factory.world, factory.ctx, from, dir);
    if (e == null) { _beltStart = null; _beltPrev = null; return; }
    if (_beltPrev != null) linkBelts(factory.world, _beltPrev, e);   // 折线: 上一段头→本段尾
    _beltPrev = e; _beltStart = dir;                                 // 终点续接下一段
    showToast('已接一段传送带 · 继续点延伸 · Esc 结束', false);
  }
  const endBeltPath = () => { const had = _beltPrev != null || _beltStart != null; _beltStart = null; _beltPrev = null; return had; };

  // 放置分拣器: 吸附最近带 + 最近建筑口。load=上料(建筑→带), 否则下料(带→建筑)。filtered=过滤分拣器(sorter)
  function placeInserterAttached(dir, load, filtered) {
    const buildingId = filtered ? 'sorter' : 'inserter';
    if (!checkUnlocked(buildingId)) return;
    const belt = nearestBelt(dir);
    const bld = nearestBuilding(dir);
    if (belt == null) { showToast('附近没有传送带, 请先放置传送带', true); return; }
    if (bld == null) { showToast('附近没有可搬运的建筑/仓库/站', true); return; }
    const beltPort = { kind: 'belt', eid: belt, role: load ? 'in' : 'out' };
    const bldRole = load ? 'provide' : (factory.world.has(bld, 'Requester') ? 'request' : 'any');
    const bldPort = { kind: 'inv', eid: bld, role: bldRole };
    const from = load ? bldPort : beltPort;
    const to = load ? beltPort : bldPort;
    // 过滤分拣器: 默认按取货端当前主要物品设过滤(简单起见先不预设, 留空=不过滤; 可后续在属性面板配置)
    const e = placeInserter(factory.world, factory.ctx, from, to, { buildingId });
    if (e != null) showToast(`已放置${filtered ? '过滤' : ''}分拣器 · ${load ? '建筑→带' : '带→建筑'}`, false);
  }

  // 放置分流器: 单点; 自动把"头端靠近该点的带"接为入, "尾端靠近该点的带"接为出
  function placeSplitterAt(dir) {
    if (!checkUnlocked('splitter')) return;
    const CONNECT_R = 0.06;   // 角半径(弧度)内的带端视为相连
    const ins = [], outs = [];
    for (const e of factory.world.query('Belt')) {
      const b = factory.world.get(e, 'Belt');
      if (sphAngle(b.to, dir) < CONNECT_R) ins.push(e);      // 带头(出口)靠近 → 作为入带
      if (sphAngle(b.from, dir) < CONNECT_R) outs.push(e);   // 带尾(入口)靠近 → 作为出带
    }
    const s = placeSplitter(factory.world, factory.ctx, dir, { ins, outs, mode: 'balance' });
    if (s != null) showToast(`已放置分流器 · 入带${ins.length}/出带${outs.length}${ins.length + outs.length === 0 ? '(把带端点对准分流器再放)' : ''}`, ins.length + outs.length === 0);
  }

  // 事件 toast
  const _engineStageName = { site: '选址平整', frame: '骨架搭建', core: '核心组装', commission: '调试' };
  factory.bus.on('engine_stage', (p) => showToast(`行星发动机: 进入「${_engineStageName[p.stage] || p.stage}」阶段`, false));
  factory.bus.on('engine_built', () => showToast('🚀 行星发动机建成! 切「点火发动机」点它即可点火', false));
  factory.bus.on('tech', (p) => showToast(`🔬 科技解锁: ${(p.tech && p.tech.name) || p.id}`, false));

  // ---- 放置/点火 点选 ----
  const dom = renderer.domElement;
  const onPlaceDown = (e) => { if (fpTool.mode !== '关闭' && e.button === 0) _fpDown = { x: e.clientX, y: e.clientY }; };
  const onPlaceUp = (e) => {
    if (fpTool.mode === '关闭' || !_fpDown) { _fpDown = null; return; }
    const moved = Math.hypot(e.clientX - _fpDown.x, e.clientY - _fpDown.y);
    _fpDown = null;
    if (moved > 5) return;
    const d = anchorPick(e.clientX, e.clientY, getCamera(), getPlanet());
    if (!d) return;
    const dir = [d.x, d.y, d.z];
    const m = fpTool.mode;
    if (m === '放置矿场') tryPlace('depot', dir, '已放置矿场 · 请圈定挖掘区并生成挖机/采矿车');
    else if (m === '圈定挖掘区') {
      const depot = factory.spatial.nearest(dir, (id) => factory.world.has(id, 'Depot'));
      if (depot == null) { showToast('附近没有矿场, 请先放置矿场', true); return; }
      setDigZone(factory.world, factory.ctx, depot, dir);
      showToast('已圈定挖掘区 · 生成挖机+采矿车即可开采', false);
    } else if (m === '放置冶炼炉') tryPlace('smelter', dir, '已放置冶炼炉');
    else if (m === '放置制造台') tryPlace('assembler', dir, '已放置制造台');
    else if (m === '放置研究站') tryPlace('lab', dir, '已放置研究站 · 送铁锭进来提升发展度');
    else if (m === '放置仓库') tryPlace('warehouse', dir, '已放置仓库');
    else if (m === '放置输电塔') tryPlace('power_tower', dir, '已放置输电塔');
    else if (m === '放置发电机') tryPlace('generator', dir, '已放置发电机');
    else if (m === '放置发动机') tryPlace('engine_site', dir, '已开建行星发动机 · 依阶段自动索取建材(铁板)');
    else if (m === '放置传送带') {
      if (!checkUnlocked('belt')) return;
      if (_beltStart == null) { _beltStart = dir; showToast('已选起点 · 逐点延伸成折线带 · Esc 结束', false); }
      else placeBeltSegment(dir);
    }
    else if (m === '放置分拣器·上料') placeInserterAttached(dir, true, false);
    else if (m === '放置分拣器·下料') placeInserterAttached(dir, false, false);
    else if (m === '放置过滤分拣器·上料') placeInserterAttached(dir, true, true);
    else if (m === '放置过滤分拣器·下料') placeInserterAttached(dir, false, true);
    else if (m === '放置分流器') placeSplitterAt(dir);
    else if (m === '放置装货站') tryPlace('load_station', dir, '已放置装货站 · 带/分拣器填它, 卡车从它取货');
    else if (m === '放置卸货站') tryPlace('unload_station', dir, '已放置卸货站 · 卡车卸进它, 带/分拣器取走送下游');
    else if (m === '点火发动机') {
      const eng = factoryRenderer.pickBuilding(factory.world, dir);
      if (eng == null || !factory.world.has(eng, 'Construction')) { showToast('请点选一台行星发动机', true); return; }
      const con = factory.world.get(eng, 'Construction');
      if (!con.built) { showToast('发动机尚未建成, 无法点火', true); return; }
      if (con.ignited) { showToast('该发动机已点火', false); return; }
      con.ignited = true;
      showToast('🔥 行星发动机点火! 燃烧废料/矿石产生推力(需物流持续供料)', false);
    } else if (m === '拆除') {
      const eid = factory.spatial.nearest(dir);
      if (eid != null) { if (inspector.selected() === eid) inspector.hide(); demolish(factory.world, factory.ctx, eid); showToast('已拆除', false); }
    }
  };

  // ---- 点击查看属性 ----
  let _inspDown = null;
  const canInspect = () => fpTool.mode === '关闭' && isInspectIdle();
  function pickEntity(clientX, clientY) {
    const d = anchorPick(clientX, clientY, getCamera(), getPlanet());
    if (d) { const b = factoryRenderer.pickBuilding(factory.world, [d.x, d.y, d.z]); if (b != null) return b; }
    _ndc.set((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1);
    _ray.setFromCamera(_ndc, getCamera());
    return factoryRenderer.pickEntity(_ray);
  }
  const onInspectDown = (e) => { if (canInspect() && e.button === 0) _inspDown = { x: e.clientX, y: e.clientY }; };
  const onInspectUp = (e) => {
    if (!_inspDown) return;
    const moved = Math.hypot(e.clientX - _inspDown.x, e.clientY - _inspDown.y);
    _inspDown = null;
    if (moved > 5 || !canInspect()) return;
    const eid = pickEntity(e.clientX, e.clientY);
    if (eid != null) inspector.show(eid); else inspector.hide();
  };
  const onKey = (e) => { if (e.key === 'Escape') { if (endBeltPath()) showToast('已结束传送带', false); inspector.hide(); } };
  dom.addEventListener('pointerdown', onPlaceDown);
  dom.addEventListener('pointerup', onPlaceUp);
  dom.addEventListener('pointerdown', onInspectDown);
  dom.addEventListener('pointerup', onInspectUp);
  window.addEventListener('keydown', onKey);

  // ---- 状态 ----
  const _oreNames = { overburden: '废土', stone: '石', iron_ore: '铁矿', copper_ore: '铜矿', iron_ingot: '铁锭', copper_ingot: '铜锭', iron_plate: '铁板' };
  function updateFactoryStatus() {
    const w = factory.world;
    const totals = {};
    for (const e of w.query('Inventory')) { const inv = w.get(e, 'Inventory'); for (const k in inv.items) totals[k] = (totals[k] || 0) + inv.items[k]; }
    const depots = w.count('Depot'), producers = w.count('Producer'), warehouses = w.count('Storage');
    const excavators = w.count('Excavator'), trucks = w.count('MineTruck') + w.count('Hauler');
    const total = depots + producers + warehouses + excavators + trucks + w.count('Construction');
    if (total === 0) { if (fpTool.mode === '关闭') fpTool.status = '待命'; return; }
    const parts = Object.keys(totals).map((k) => `${_oreNames[k] || k}:${totals[k].toFixed(0)}`);
    fpTool.status = `矿场${depots} 厂${producers} 仓${warehouses} 挖机${excavators} 车${trucks} · ${parts.join(' ') || '空'}`;
  }

  return {
    factory, renderer: factoryRenderer, inspector, fpTool, showToast,
    // 该屏幕点是否命中工厂建筑/agent(宿主用来在放置/查看时让出点击, 不误触发相机聚焦切换)
    hitTest: (clientX, clientY) => pickEntity(clientX, clientY),
    setPlanet(planet) { factory.setPlanet(planet); factoryRenderer.setPlanet(planet); },
    // 固定步长模拟 + 渲染 + 面板刷新。宿主在 animate 里、行星 LOD 更新前调用。
    tick(dt) {
      _acc += dt; let n = 0;
      while (_acc >= FIXED && n < 5) { factory.tick(FIXED); _acc -= FIXED; n++; }
      factoryRenderer.setSelected(inspector.selected());
      factoryRenderer.update(factory.world);
      factoryRenderer.setPowerLines(factory.ctx.power && factory.ctx.power.links);
      inspector.update();
      updateFactoryStatus();
      updateResearchStatus();
    },
    dispose() {
      dom.removeEventListener('pointerdown', onPlaceDown); dom.removeEventListener('pointerup', onPlaceUp);
      dom.removeEventListener('pointerdown', onInspectDown); dom.removeEventListener('pointerup', onInspectUp);
      window.removeEventListener('keydown', onKey);
      fpGui.destroy(); techGui.destroy(); dbgGui.destroy(); inspector.dispose(); factoryRenderer.dispose(); toastEl.remove();
    },
  };
}
