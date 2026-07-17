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
import { createMiningCrewSystem, placeDigZoneEntity, spawnExcavators, spawnMineTrucks } from './systems/mining_crew.js';
import { createProductionSystem } from './systems/production.js';
import { createPowerSystem } from './systems/power.js';
import { createResearchSystem } from './systems/research.js';
import { createConstructionSystem } from './systems/construction.js';
import { createEngineSystem } from './systems/engine.js';
import { createLogisticsSystem, spawnHaulers } from './systems/logistics.js';
import { createBeltSystem } from './systems/belt.js';
import { createInserterSystem } from './systems/inserter.js';
import { createSplitterSystem } from './systems/splitter.js';
import { placeBuilding, demolish, placeBelt, placeInserter, placeInserterMounted, placeSplitter, linkBelts, placeBuildPad, probePad, expandPad, placeBuildingSnapped, padAt, rebuildPadEdits } from './systems/placement.js';
import { angle as sphAngle } from './core/sphere.js';
import { dirToCell, footprintCenterDir, snapYaw, canPlace, snapDir, footprintInPad } from './core/grid.js';
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
  const inspector = createInspector({
    getWorld: () => factory.world, registry: factory.registry, getPower: () => factory.ctx.power,
    onAction: (eid, action, n) => {
      if (action === 'spawn_excavators') {
        spawnExcavators(factory.world, factory.ctx, n || 3, eid);
        showToast(`已生成 ${n || 3} 台挖机 · 归属此矿场`, false);
      } else if (action === 'spawn_minetrucks') {
        spawnMineTrucks(factory.world, factory.ctx, n || 3, eid);
        showToast(`已生成 ${n || 3} 辆采矿车 · 归属此矿场`, false);
      }
    },
  });
  const _ray = new THREE.Raycaster();
  const _ndc = new THREE.Vector2();
  let _acc = 0; const FIXED = 0.05;
  let _expandAcc = 0;   // 探测平台网格扩张节流

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
    inserterDir: '进料', inserterReach: 1,   // 分拣器: 方向(进料/出料) + 抓取距离(1/2/3 格)
    probeTol: 0.02, probeMinCells: 9, probeRadius: 0.15,   // 探测建造区: 平整容差 / 最小格数 / 探测半径(角)
    showRanges: false, status: '待命',
  };
  let _fpDown = null;
  let _beltStart = null;   // 传送带折线放置: 当前段起点(球面方向)
  let _beltPrev = null;    // 上一段带实体(用于带↔带直连成折线)
  let _quarter = 0;        // 网格放置朝向(0..3, 每次 R 键 +90°)
  let _cursor = null;      // 最近一次鼠标屏幕坐标(驱动网格虚影预览)

  const showsGrid = (m) => m === '探测建造区' || m === '平整地面(调试)' || m.startsWith('放置');
  let _gridManual = false;   // B 键手动网格显隐(与放置模式自动显示叠加)
  const updateGridVis = () => factoryRenderer.showBuildGrids(_gridManual || showsGrid(fpTool.mode));
  const fpGui = new GUI({ title: '🏭 工厂', container });
  fpGui.add(fpTool, 'mode', ['关闭', '探测建造区', '放置矿场', '放置挖掘区', '放置冶炼炉', '放置制造台', '放置研究站', '放置仓库', '放置输电塔', '放置发电机', '放置发动机', '点火发动机',
    '放置传送带', '放置分拣器·上料', '放置分拣器·下料', '放置过滤分拣器·上料', '放置过滤分拣器·下料', '放置分流器', '放置装货站', '放置卸货站', '拆除']).name('模式').listen()
    .onChange((v) => { if (v !== '关闭') onModeActivate(); _beltStart = null; _beltPrev = null; updateGridVis(); });
  fpGui.add(fpTool, 'excavatorCount', 1, 20, 1).name('挖机数量');
  fpGui.add(fpTool, 'spawnExcavators').name('生成挖机(就近矿场)');
  fpGui.add(fpTool, 'mineTruckCount', 1, 20, 1).name('采矿车数量');
  fpGui.add(fpTool, 'spawnMineTrucks').name('生成采矿车(就近矿场)');
  fpGui.add(fpTool, 'haulerCount', 1, 20, 1).name('物流车数量');
  fpGui.add(fpTool, 'spawnHaulers').name('生成物流车');
  fpGui.add(fpTool, 'inserterDir', ['进料', '出料']).name('分拣器方向');
  fpGui.add(fpTool, 'inserterReach', 1, 3, 1).name('分拣器抓取距离');
  fpGui.add(fpTool, 'probeTol', 0.002, 0.1, 0.002).name('探测·平整容差');
  fpGui.add(fpTool, 'probeMinCells', 4, 200, 1).name('探测·最小格数');
  fpGui.add(fpTool, 'probeRadius', 0.05, 0.4, 0.01).name('探测·半径');
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
  dbgTool.flattenMode = () => { fpTool.mode = '平整地面(调试)'; onModeActivate(); updateGridVis(); showToast('🛠 平整地面(调试): 点地表人工削平一块并生成网格(会改地形)', false); };
  const dbgGui = new GUI({ title: '🛠 调试', container });
  dbgGui.add(dbgTool, 'unlockAll').name('一键解锁全部科技');
  dbgGui.add(dbgTool, 'buildEngines').name('一键建成发动机');
  dbgGui.add(dbgTool, 'flattenMode').name('平整地面(调试·改地形)');
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

  function firstDepot() {
    for (const e of factory.world.query('Depot')) return e;
    return null;
  }
  // 取最近的有覆盖挖掘区的矿场(全局生成按钮用); 没有则取最近矿场; 再没有返回 null。
  // 优先级: ① 已覆盖 zone 的矿场 > ② 任意矿场。挖机/采矿车只有在有 zone 可挖时才有意义。
  function bestDepotForSpawn() {
    let any = null, withZone = null;
    for (const e of factory.world.query('Depot')) {
      if (any == null) any = e;
      const dep = factory.world.get(e, 'Depot');
      if (dep && dep.coverageZones && dep.coverageZones.length > 0) { withZone = e; break; }
    }
    return withZone || any;
  }
  function doSpawnExcavators() {
    const depot = bestDepotForSpawn();
    if (depot == null) { showToast('请先放置矿场', true); return; }
    spawnExcavators(factory.world, factory.ctx, fpTool.excavatorCount, depot);
    showToast(`已生成 ${fpTool.excavatorCount} 台挖机 · 归属此矿场`, false);
  }
  function doSpawnMineTrucks() {
    const depot = bestDepotForSpawn();
    if (depot == null) { showToast('请先放置矿场', true); return; }
    spawnMineTrucks(factory.world, factory.ctx, fpTool.mineTruckCount, depot);
    showToast(`已生成 ${fpTool.mineTruckCount} 辆采矿车 · 归属此矿场`, false);
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

  // 放置模式 → 建筑 id / 成功提示(走网格吸附)
  const MODE_BUILDING = {
    '放置矿场': 'depot', '放置冶炼炉': 'smelter', '放置制造台': 'assembler', '放置研究站': 'lab',
    '放置仓库': 'warehouse', '放置输电塔': 'power_tower', '放置发电机': 'generator',
    '放置装货站': 'load_station', '放置卸货站': 'unload_station',
  };
  const MODE_MSG = {
    '放置矿场': '已放置矿场 · 请圈定挖掘区并生成挖机/采矿车', '放置冶炼炉': '已放置冶炼炉',
    '放置制造台': '已放置制造台', '放置研究站': '已放置研究站 · 送铁锭进来提升发展度',
    '放置仓库': '已放置仓库', '放置输电塔': '已放置输电塔', '放置发电机': '已放置发电机',
    '放置装货站': '已放置装货站 · 带/分拣器填它, 卡车从它取货', '放置卸货站': '已放置卸货站 · 卡车卸进它, 带/分拣器取走送下游',
  };
  // 网格吸附放置: 平台内吸附落格(占用则拒), 平台外/按住 Alt 自由放置
  function trySnapPlace(buildingId, dir, okMsg, free) {
    if (!checkUnlocked(buildingId)) return null;
    if (free) { const e = placeBuilding(factory.world, factory.ctx, buildingId, dir); if (e != null && okMsg) showToast(okMsg, false); return e; }
    const r = placeBuildingSnapped(factory.world, factory.ctx, buildingId, dir, _quarter);
    if (r.blocked) { showToast('该网格已被占用', true); return null; }
    if (r.eid != null && okMsg) showToast(r.snapped ? `${okMsg} · 已吸附网格` : okMsg, false);
    return r.eid;
  }

  // 网格虚影预览: 在光标吸附格画绿(可放)/红(占用)方块; 非建筑放置模式或不在平台内则隐藏
  function updateGridGhost() {
    const bid = MODE_BUILDING[fpTool.mode];
    if (!bid || !_cursor) { factoryRenderer.setGridCursor(null); return; }
    const d = anchorPick(_cursor.x, _cursor.y, getCamera(), getPlanet());
    if (!d) { factoryRenderer.setGridCursor(null); return; }
    const hit = padAt(factory.world, [d.x, d.y, d.z]);
    if (!hit) { factoryRenderer.setGridCursor(null); return; }
    const pad = hit.pad, R = getPlanet().params.radius;
    const def = factory.registry.buildings[bid] || {};
    const fp = def.footprint || [1, 1], w = fp[0], h = fp[1];
    const c = dirToCell(pad, [d.x, d.y, d.z], R);
    const i0 = c.i - Math.floor(w / 2), j0 = c.j - Math.floor(h / 2);
    const cdir = footprintCenterDir(pad, i0, j0, w, h, R);
    const blocked = !canPlace(pad, i0, j0, w, h) || !footprintInPad(pad, i0, j0, w, h);
    factoryRenderer.setGridCursor(cdir, snapYaw(pad, cdir, _quarter), w * pad.cell, h * pad.cell, blocked);
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
  // 若 dir 落在某建造平台内, 吸附到最近格点; 否则原样返回(供传送带端点吸附网格)
  function snapToGrid(dir) {
    const hit = padAt(factory.world, dir);
    if (!hit) return dir;
    const s = snapDir(hit.pad, dir, getPlanet().params.radius);
    return s.inside ? s.dir : dir;
  }

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

  // 分拣器装在"平台网格上的建筑"边缘(单点): 点击建筑的某条边 → 分拣器嵌在那条边中点, 爪子朝外。
  // 抓取格 = 该边外 reach 格(面板设 1/2/3); 方向 = 面板"进料/出料"; 运行时抓取格里有什么(带/建筑)就交互。
  function placeInserterOnBuilding(dir, filtered) {
    const buildingId = filtered ? 'sorter' : 'inserter';
    if (!checkUnlocked(buildingId)) return;
    const bld = factoryRenderer.pickBuilding(factory.world, dir);
    if (bld == null || factory.world.has(bld, 'Belt') || !factory.world.has(bld, 'GridSlot')) {
      showToast('请点在平台网格里的建筑上(先把建筑放到建造平台内)', true); return;
    }
    const slot = factory.world.get(bld, 'GridSlot');
    const pad = factory.world.get(slot.pad, 'BuildPad');
    const c = dirToCell(pad, dir, getPlanet().params.radius);
    const cx = slot.i + (slot.w - 1) / 2, cy = slot.j + (slot.h - 1) / 2;    // 建筑中心格
    const dx = c.i - cx, dy = c.j - cy;                                       // 点击相对建筑中心的格偏移
    const axis = Math.abs(dx) >= Math.abs(dy) ? { di: dx >= 0 ? 1 : -1, dj: 0 } : { di: 0, dj: dy >= 0 ? 1 : -1 };
    const mode = fpTool.inserterDir === '出料' ? 'out' : 'in';
    const e = placeInserterMounted(factory.world, factory.ctx, bld, axis, fpTool.inserterReach, mode, filtered);
    if (e == null) { showToast('装分拣器失败(建筑需在平台内 / 科技未解锁)', true); return; }
    const name = (factory.registry.buildings[factory.world.get(bld, 'Building').typeId] || {}).name || '建筑';
    showToast(`已在${name}边装${filtered ? '过滤' : ''}分拣器 · ${mode === 'in' ? '进料(抓取格→建筑)' : '出料(建筑→抓取格)'} · 抓取距离${fpTool.inserterReach}`, false);
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
    if (m === '探测建造区') {
      const res = probePad(factory.world, factory.ctx, dir, { tol: fpTool.probeTol, minCells: fpTool.probeMinCells, radius: fpTool.probeRadius });
      if (res == null) showToast('无法探测(当前无地形)', true);
      else if (res.rejected) showToast(`这里不够平整/面积太小(仅 ${res.count} 格) · 换更平整的大片区域`, true);
      else showToast(`已在平整区生成网格(${res.count} 格) · 继续开挖会自动扩张`, false);
    }
    else if (m === '平整地面(调试)') {
      const e = placeBuildPad(factory.world, factory.ctx, dir);
      if (e != null) showToast('已(调试)平整地面并生成网格(R 旋转, Alt 自由放置)', false);
    }
    else if (MODE_BUILDING[m]) trySnapPlace(MODE_BUILDING[m], dir, MODE_MSG[m], e.altKey);
    else if (m === '放置挖掘区') {
      const z = placeDigZoneEntity(factory.world, factory.ctx, dir);
      if (z == null) { showToast('放置挖掘区失败', true); return; }
      // 找到覆盖该 zone 的矿场数(给用户即时反馈)
      let n = 0;
      for (const de of factory.world.query('Depot', 'Anchor')) {
        const dep = factory.world.get(de, 'Depot');
        const a = factory.world.get(de, 'Anchor');
        if (sphAngle(a.dir, dir) <= (dep.coverageRadius || 0.16)) n++;
      }
      showToast(n > 0 ? `已放置挖掘区 · 覆盖范围内 ${n} 个矿场` : '已放置挖掘区(暂无矿场覆盖, 请放置矿场)', n === 0);
    }
    else if (m === '放置发动机') tryPlace('engine_site', dir, '已开建行星发动机 · 依阶段自动索取建材(铁板)');
    else if (m === '放置传送带') {
      if (!checkUnlocked('belt')) return;
      const sdir = snapToGrid(dir);   // 平台内: 端点吸附到网格格点
      if (_beltStart == null) { _beltStart = sdir; showToast('已选起点 · 逐点延伸成折线带(平台内吸附网格) · Esc 结束', false); }
      else placeBeltSegment(sdir);
    }
    else if (m === '放置分拣器') placeInserterOnBuilding(dir, false);
    else if (m === '放置过滤分拣器') placeInserterOnBuilding(dir, true);
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
  // 退出放置模式(切回"关闭"): 供右键调用
  function exitMode() {
    if (fpTool.mode === '关闭') return false;
    fpTool.mode = '关闭';
    endBeltPath();
    updateGridVis();
    showToast('已退出放置模式', false);
    return true;
  }
  const onKey = (e) => {
    if (e.key === 'Escape') {
      if (endBeltPath()) showToast('已结束传送带', false);
      else exitMode();
      inspector.hide();
    }
    else if (e.key === 'r' || e.key === 'R') { _quarter = (_quarter + 1) % 4; }   // 网格放置: 旋转 90°
    else if (e.key === 'b' || e.key === 'B') { _gridManual = !_gridManual; updateGridVis(); showToast(_gridManual ? '网格: 常显(再按 B 关闭)' : '网格: 仅放置模式显示', false); }
  };
  const onPointerMove = (e) => { _cursor = { x: e.clientX, y: e.clientY }; };
  // 右键单击(非拖拽) → 退出放置模式; 拖拽保留给相机
  let _rDown = null;
  const onRightDown = (e) => { if (e.button === 2) _rDown = { x: e.clientX, y: e.clientY }; };
  const onRightUp = (e) => {
    if (e.button !== 2 || !_rDown) return;
    const moved = Math.hypot(e.clientX - _rDown.x, e.clientY - _rDown.y); _rDown = null;
    if (moved <= 5 && fpTool.mode !== '关闭') exitMode();
  };
  const onContext = (e) => { if (fpTool.mode !== '关闭') e.preventDefault(); };   // 放置模式下屏蔽浏览器右键菜单
  dom.addEventListener('pointerdown', onPlaceDown);
  dom.addEventListener('pointerup', onPlaceUp);
  dom.addEventListener('pointerdown', onInspectDown);
  dom.addEventListener('pointerup', onInspectUp);
  dom.addEventListener('pointermove', onPointerMove);
  dom.addEventListener('pointerdown', onRightDown);
  dom.addEventListener('pointerup', onRightUp);
  dom.addEventListener('contextmenu', onContext);
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
    setPlanet(planet) { factory.setPlanet(planet); factoryRenderer.setPlanet(planet); rebuildPadEdits(factory.world, factory.ctx); },
    // 固定步长模拟 + 渲染 + 面板刷新。宿主在 animate 里、行星 LOD 更新前调用。
    tick(dt) {
      _acc += dt; let n = 0;
      while (_acc >= FIXED && n < 5) { factory.tick(FIXED); _acc -= FIXED; n++; }
      factoryRenderer.setSelected(inspector.selected());
      factoryRenderer.update(factory.world);
      factoryRenderer.setPowerLines(factory.ctx.power && factory.ctx.power.links);
      updateGridGhost();
      // 探测平台的网格跟随地形变化(继续开挖后扩张/收缩); 节流 ~0.5s
      _expandAcc += dt;
      if (_expandAcc >= 0.5) {
        _expandAcc = 0;
        for (const pe of factory.world.query('BuildPad')) if (factory.world.get(pe, 'BuildPad').probe) expandPad(factory.world, factory.ctx, pe);
      }
      inspector.update();
      updateFactoryStatus();
      updateResearchStatus();
    },
    dispose() {
      dom.removeEventListener('pointerdown', onPlaceDown); dom.removeEventListener('pointerup', onPlaceUp);
      dom.removeEventListener('pointerdown', onInspectDown); dom.removeEventListener('pointerup', onInspectUp);
      dom.removeEventListener('pointermove', onPointerMove);
      dom.removeEventListener('pointerdown', onRightDown); dom.removeEventListener('pointerup', onRightUp);
      dom.removeEventListener('contextmenu', onContext);
      window.removeEventListener('keydown', onKey);
      fpGui.destroy(); techGui.destroy(); dbgGui.destroy(); inspector.dispose(); factoryRenderer.dispose(); toastEl.remove();
    },
  };
}
