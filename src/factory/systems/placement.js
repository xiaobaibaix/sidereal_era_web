// 建造 / 拆除 —— 把建筑数据组装成实体(组件),并处理挖机的地形坑 edit。
// 与渲染/UI 解耦: App 只需 pick 到方向 dir 后调 placeBuilding。

import { createBelt } from './belt.js';
import { midPortDir } from './inserter.js';
import { norm } from '../core/sphere.js';
import { angle } from '../core/sphere.js';
import { makePad, offsetToDir, dirToCell, cellToDir, footprintCenterDir, footprintInPad, canPlace, markPlaced, freePlaced, snapYaw, discCells, floodFlatCells, expandFlatCells } from '../core/grid.js';

// 全局网格参考向量(整场统一 → 所有平台网格方向一致)。首次按"与该点最垂直的世界轴"选定并缓存到 ctx。
function gridRef(ctx, center) {
  if (ctx.gridRef) return ctx.gridRef;
  const ax = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  let best = ax[0], bd = Infinity;
  for (const a of ax) { const d = Math.abs(a[0] * center[0] + a[1] * center[1] + a[2] * center[2]); if (d < bd) { bd = d; best = a; } }
  ctx.gridRef = best;
  return best;
}

// 采样平台圆区内基础地形的最低点, 作为整平目标 level(只挖不填 → 全平)。无 planet 返回 0。
function sampleMinLevel(planet, pad, R) {
  if (!planet || !planet.baseHeightAt) return 0;
  let lo = planet.baseHeightAt(pad.center[0], pad.center[1], pad.center[2]);
  const rings = [0.4, 0.75, 0.98], K = 8;
  for (const rr of rings) {
    const rad = rr * pad.radius * R;   // 弧长(米)
    for (let k = 0; k < K; k++) {
      const a = (k / K) * Math.PI * 2;
      const d = offsetToDir(pad, Math.cos(a) * rad, Math.sin(a) * rad, R);
      const h = planet.baseHeightAt(d[0], d[1], d[2]);
      if (h < lo) lo = h;
    }
  }
  return lo;
}

// 放置一个建造平台(BuildPad): 平整圆区(level 编辑) + 建 pad 实体(供网格吸附)。返回实体 id(失败返回 null)。
// opts: { buildingId, cell, radius, level }
export function placeBuildPad(world, ctx, center, opts = {}) {
  const { planet, registry, spatial, bus } = ctx;
  const buildingId = opts.buildingId || 'build_pad';
  const def = (registry.buildings && registry.buildings[buildingId]) || {};
  if (def.locked && !(registry.isUnlocked && registry.isUnlocked(buildingId))) return null;
  const cell = opts.cell != null ? opts.cell : (def.cell != null ? def.cell : 3.0);
  const radius = opts.radius != null ? opts.radius : (def.radius != null ? def.radius : 0.06);
  const R = planet ? planet.params.radius : 100;
  const pad = makePad(center, { cell, radius, ref: gridRef(ctx, norm(center)) });
  pad.level = opts.level != null ? opts.level : sampleMinLevel(planet, pad, R);
  const cells = discCells(pad, R);   // 调试平整: 规整圆盘格集合

  const e = world.create();
  world.add(e, 'Anchor', { dir: [pad.center[0], pad.center[1], pad.center[2]], yaw: 0 });
  world.add(e, 'BuildPad', {
    center: [pad.center[0], pad.center[1], pad.center[2]],
    e: [pad.e[0], pad.e[1], pad.e[2]], n: [pad.n[0], pad.n[1], pad.n[2]],
    cell, radius, level: pad.level, R, cells, occupied: {},
  });

  // 整平地形: level 编辑(削平圆区内高于 level 的地形到平面)
  if (planet) {
    if (!ctx.padEdits) ctx.padEdits = new Map();
    const edit = { type: 'level', pos: [pad.center[0], pad.center[1], pad.center[2]], radius, level: pad.level, progress: 1, falloff: 'smooth' };
    planet.params.edits.push(edit);
    if (planet._buildNoise) planet._buildNoise();
    if (planet.roots) for (const r of planet.roots) planet._invalidateAffected(r, { x: pad.center[0], y: pad.center[1], z: pad.center[2] }, radius);
    planet._editPending = true;
    ctx.padEdits.set(e, edit);
  }
  if (spatial) spatial.insert(e, pad.center);
  if (bus) bus.emit('build', { eid: e, buildingId });
  return e;
}

// 读档后重建"平台实体 → 整平编辑"映射(ctx.padEdits): 按 center 匹配 planet.params.edits 里的 level 编辑。
// 供读档后拆除平台时能恢复地形(整平编辑在 planet 存档里, 但 eid→edit 的运行时映射不随 world 存档保存)。
export function rebuildPadEdits(world, ctx) {
  const planet = ctx.planet;
  if (!planet || !planet.params || !Array.isArray(planet.params.edits)) return;
  ctx.padEdits = ctx.padEdits || new Map();
  for (const pe of world.query('BuildPad')) {
    if (ctx.padEdits.has(pe)) continue;
    const pad = world.get(pe, 'BuildPad');
    const edit = planet.params.edits.find((ed) => ed && ed.type === 'level' && ed.pos
      && Math.abs(ed.pos[0] - pad.center[0]) < 1e-6
      && Math.abs(ed.pos[1] - pad.center[1]) < 1e-6
      && Math.abs(ed.pos[2] - pad.center[2]) < 1e-6);
    if (edit) ctx.padEdits.set(pe, edit);
  }
}

// 放置一个建筑; 返回实体 id(失败返回 null)
export function placeBuilding(world, ctx, buildingId, dir, yaw = 0) {
  const { planet, registry, spatial, bus } = ctx;
  const b = registry.buildings[buildingId];
  if (!b) return null;
  if (b.locked && !(registry.isUnlocked && registry.isUnlocked(buildingId))) return null;   // 科技未解锁

  const e = world.create();
  world.add(e, 'Anchor', { dir: [dir[0], dir[1], dir[2]], yaw: yaw || 0 });
  world.add(e, 'Building', { typeId: buildingId, mesh: b.mesh || buildingId });
  if (spatial) spatial.insert(e, dir);

  if (b.kind === 'miner') {
    world.add(e, 'Miner', { typeId: b.machine || buildingId, dugDepth: 0, state: 'mining', lastItem: null });
    world.add(e, 'Inventory', { items: {}, cap: b.cap != null ? b.cap : Infinity });
    world.add(e, 'Provider', { items: '*' });   // 矿机对外供应它挖到的一切
    if (planet) {
      const edit = { pos: [dir[0], dir[1], dir[2]], radius: b.digRadius || 0.03, depth: 0, falloff: 'smooth', dry: true };
      planet.params.edits.push(edit);
      if (!ctx.minerEdits) ctx.minerEdits = new Map();
      ctx.minerEdits.set(e, edit);
    }
  } else if (b.kind === 'storage') {
    world.add(e, 'Storage', {});
    world.add(e, 'Inventory', { items: {}, cap: b.cap != null ? b.cap : Infinity });
  } else if (b.kind === 'depot') {
    // 矿场: 被动容器(自身不挖)。覆盖范围内(R5)的独立挖掘区实体被自动绑定到该矿场;
    // 矿场生成挖机/采矿卡车后, 挖机去覆盖范围内的挖掘区开采 → 卡车运回该矿场。
    // coverageRadius=覆盖角半径(来自 building 表); coverageZones=每 tick 由 mining_crew 刷新的 zone eid 列表。
    world.add(e, 'Depot', { coverageRadius: b.coverageRadius || 0.16, coverageZones: [] });
    world.add(e, 'Inventory', { items: {}, cap: b.cap != null ? b.cap : Infinity });
    world.add(e, 'Provider', { items: '*' });   // 对外供应存储的一切
  } else if (b.kind === 'producer') {
    const recipeId = b.recipe || (b.recipes && b.recipes[0]);
    const recipe = registry.recipes[recipeId] || { in: [], out: [] };
    world.add(e, 'Producer', { typeId: b.machine || buildingId, recipeId, progress: 0, state: 'idle' });
    world.add(e, 'Inventory', { items: {}, cap: b.cap != null ? b.cap : Infinity });
    // 供应: 配方输出物; 需求: 配方输入物, 维持 bufferMult 份缓冲
    const outIds = [];
    for (const stack of recipe.out || []) for (const it in stack) outIds.push(it);
    world.add(e, 'Provider', { items: outIds });
    const needs = {};
    const mult = b.bufferMult != null ? b.bufferMult : 4;
    for (const stack of recipe.in || []) for (const it in stack) needs[it] = (needs[it] || 0) + stack[it] * mult;
    world.add(e, 'Requester', { needs });
    if (b.power > 0) world.add(e, 'PowerNeed', { demand: b.power, sat: 1 });   // 需供电(sat 由 power 系统每 tick 覆写; 无 power 系统时保持 1)
  } else if (b.kind === 'tower') {
    world.add(e, 'PowerTower', { range: b.range || 0.12 });
  } else if (b.kind === 'generator') {
    world.add(e, 'PowerGen', { output: b.output || 100 });
  } else if (b.kind === 'lab') {
    // 研究站: 消耗 input(如铁锭) → 提升发展度。是 input 的需求方(物流会送料)。
    world.add(e, 'Lab', { input: b.input, inRate: b.inRate || 1, devPerUnit: b.devPerUnit || 1, state: 'idle', rate: 0 });
    world.add(e, 'Inventory', { items: {}, cap: b.cap != null ? b.cap : 100 });
    const mult = b.bufferMult != null ? b.bufferMult : 10;
    world.add(e, 'Requester', { needs: { [b.input]: (b.inRate || 1) * mult } });
  } else if (b.kind === 'engine') {
    // 行星发动机: 分阶段建造(construction 系统驱动)。按当前阶段向物流请求建材。
    world.add(e, 'Construction', { stage: 0, prog: 0, contributed: {}, done: false, built: false });
    world.add(e, 'Inventory', { items: {}, cap: b.cap != null ? b.cap : 1000 });
    world.add(e, 'Requester', { needs: {} });   // 由 construction 按阶段设置
  } else if (b.kind === 'loadstation') {
    // 装货站(B2): 缓冲仓 + 对卡车表现为 Provider。带/分拣器填它, 卡车从它取货(远距离起点)。
    world.add(e, 'Inventory', { items: {}, cap: b.cap != null ? b.cap : 1000 });
    world.add(e, 'Provider', { items: b.filter || '*' });        // 卡车取货依此过滤; 默认供应一切
    world.add(e, 'LoadStation', { filter: b.filter || null });
  } else if (b.kind === 'unloadstation') {
    // 卸货站(B2): 缓冲仓 + 对卡车表现为 Requester。卡车卸进它, 带/分拣器取走送下游(远距离终点)。
    world.add(e, 'Inventory', { items: {}, cap: b.cap != null ? b.cap : 1000 });
    world.add(e, 'Requester', { needs: b.needs || {} });         // 空需求 → 通用卸货(接收任何物品)
    world.add(e, 'Provider', { items: '*' });                    // 供下游分拣器取走
    world.add(e, 'UnloadStation', {});
  }

  if (bus) bus.emit('build', { eid: e, buildingId });
  return e;
}

// 找包含某方向的建造平台(按格集合判定); 多个重叠时返回"最深(level 最低)"的(洞里点击吸附到低平台)。返回 { eid, pad } 或 null
export function padAt(world, dir) {
  let best = null, bestLevel = Infinity;
  for (const pe of world.query('BuildPad')) {
    const p = world.get(pe, 'BuildPad');
    if (!dirToCell(p, dir, p.R || 100).inside) continue;
    const lv = p.level != null ? p.level : 0;
    if (best == null || lv < bestLevel - 1e-9) { best = { eid: pe, pad: p }; bestLevel = lv; }
  }
  return best;
}

// 探测建造区(不改地形): 在 clickDir 处洪泛检测平整连通区; 格数达标则建 BuildPad(网格贴合平地形状)。
// opts: { cell, radius(探测半径上限,角), tol(高度容差), minCells(最小格数) }。返回 { eid, count } | { rejected, count } | null
export function probePad(world, ctx, clickDir, opts = {}) {
  const { planet, spatial, bus } = ctx;
  if (!planet || !planet.heightAt) return null;
  const R = planet.params.radius;
  const cell = opts.cell != null ? opts.cell : 3.0;
  const radius = opts.radius != null ? opts.radius : 0.15;
  const tol = opts.tol != null ? opts.tol : 0.02;
  const minCells = opts.minCells != null ? opts.minCells : 9;
  const pad = makePad(clickDir, { cell, radius, ref: gridRef(ctx, norm(clickDir)) });
  const sample = (d) => planet.heightAt(d[0], d[1], d[2]);
  const maxRadiusCells = Math.max(2, Math.ceil((radius * R) / cell));
  const res = floodFlatCells(pad, sample, R, { tol, maxRadiusCells });
  if (res.count < minCells) return { rejected: true, count: res.count };

  const e = world.create();
  world.add(e, 'Anchor', { dir: [pad.center[0], pad.center[1], pad.center[2]], yaw: 0 });
  world.add(e, 'BuildPad', {
    center: [pad.center[0], pad.center[1], pad.center[2]],
    e: [pad.e[0], pad.e[1], pad.e[2]], n: [pad.n[0], pad.n[1], pad.n[2]],
    cell, radius, level: res.level, tol, R, cells: res.cells, occupied: {}, probe: true,
  });
  if (spatial) spatial.insert(e, pad.center);
  if (bus) bus.emit('build', { eid: e, buildingId: 'build_pad' });
  return { eid: e, count: res.count };
}

// 让探测平台的网格跟随地形变化(继续开挖后扩张/收缩)。返回新格数。
export function expandPad(world, ctx, padEid) {
  const p = world.get(padEid, 'BuildPad');
  if (!p || !ctx.planet || !ctx.planet.heightAt) return 0;
  const R = ctx.planet.params.radius;
  const sample = (d) => ctx.planet.heightAt(d[0], d[1], d[2]);
  const maxRadiusCells = Math.max(2, Math.ceil(((p.radius || 0.15) * R) / p.cell));
  const res = expandFlatCells(p, sample, R, { tol: p.tol != null ? p.tol : 0.02, maxRadiusCells });
  if (res.count > 0) p.cells = res.cells;
  return res.count;
}

// 网格吸附放置: dir 落在某平台内 → 吸附格点 + 对齐朝向 + footprint 占位检查(占用则拒);
// 平台外 → 自由放置(现状)。quarter=玩家旋转(0..3)。
// 返回 { eid, snapped, blocked }。
export function placeBuildingSnapped(world, ctx, buildingId, dir, quarter = 0) {
  const { planet, registry } = ctx;
  const def = (registry.buildings && registry.buildings[buildingId]) || {};
  const hit = padAt(world, dir);
  if (!hit) {                                        // 平台外: 自由放置
    const e = placeBuilding(world, ctx, buildingId, dir, 0);
    return { eid: e, snapped: false, blocked: false };
  }
  const { eid: padEid, pad } = hit;
  const R = planet ? planet.params.radius : 100;
  const fp = def.footprint || [1, 1];
  const w = fp[0], h = fp[1];
  const c = dirToCell(pad, dir, R);                  // 最近格点
  const i0 = c.i - Math.floor(w / 2), j0 = c.j - Math.floor(h / 2);   // footprint 最小角(居中于该格)
  if (!footprintInPad(pad, i0, j0, w, h)) return { eid: null, snapped: true, blocked: true, offpad: true };   // 部分格不在平地
  if (!canPlace(pad, i0, j0, w, h)) return { eid: null, snapped: true, blocked: true };
  const cdir = footprintCenterDir(pad, i0, j0, w, h, R);
  const yaw = snapYaw(pad, cdir, quarter);
  const e = placeBuilding(world, ctx, buildingId, cdir, yaw);
  if (e != null) {
    markPlaced(pad, i0, j0, w, h, e);
    world.add(e, 'GridSlot', { pad: padEid, i: i0, j: j0, w, h });
  }
  return { eid: e, snapped: true, blocked: false };
}

// 放置一条传送带(两点放置)。from/to 为球面单位方向; opts 透传给 createBelt(buildingId/outPort/inPort 等)。
// 返回带实体 id(失败返回 null, 例如科技未解锁)。
export function placeBelt(world, ctx, from, to, opts = {}) {
  const { registry } = ctx;
  const buildingId = opts.buildingId || 'belt';
  const b = registry.buildings[buildingId];
  if (b && b.locked && !(registry.isUnlocked && registry.isUnlocked(buildingId))) return null;
  const e = createBelt(world, ctx, from, to, { ...opts, buildingId });
  registerBeltPadCells(world, ctx, e);
  return e;
}

// 若带的两端都在同一建造平台内, 记录它经过的网格格(供分拣器按抓取格找到该带 + 该格的 s 位置)。
// belt.pad = 平台 eid; belt.cells = { "i,j": s }(s: 0=尾→1=头)。
export function registerBeltPadCells(world, ctx, beltEid) {
  const bl = beltEid != null && world.get(beltEid, 'Belt');
  if (!bl) return;
  const R = ctx.planet ? ctx.planet.params.radius : 100;
  const hitA = padAt(world, bl.from), hitB = padAt(world, bl.to);
  if (!hitA || !hitB || hitA.eid !== hitB.eid) { bl.pad = null; bl.cells = null; return; }
  const pad = hitA.pad;
  const ca = dirToCell(pad, bl.from, R), cb = dirToCell(pad, bl.to, R);
  const steps = Math.max(Math.abs(cb.i - ca.i), Math.abs(cb.j - ca.j));
  const cells = {};
  for (let k = 0; k <= steps; k++) {
    const t = steps ? k / steps : 0;
    const i = Math.round(ca.i + (cb.i - ca.i) * t);
    const j = Math.round(ca.j + (cb.j - ca.j) * t);
    cells[i + ',' + j] = t;   // t = s 位置(尾→头)
  }
  bl.pad = hitA.eid; bl.cells = cells;
  bl.cellGap = steps > 0 ? 1 / steps : 1;   // 每格的 s 跨度(供分拣器抽取窗口, 防高速带跳过)
}

// 放置一条折线带(多段): points=[dir0,dir1,...] → 生成 N-1 段带, 每段头部(outPort)直连下一段带尾(不经分拣器)。
// 返回带实体 id 数组(失败返回 [])。
export function placeBeltPath(world, ctx, points, opts = {}) {
  const { registry } = ctx;
  const buildingId = opts.buildingId || 'belt';
  const b = registry.buildings[buildingId];
  if (b && b.locked && !(registry.isUnlocked && registry.isUnlocked(buildingId))) return [];
  if (!points || points.length < 2) return [];
  const belts = [];
  for (let i = 0; i < points.length - 1; i++) {
    belts.push(createBelt(world, ctx, points[i], points[i + 1], { ...opts, buildingId }));
  }
  for (let i = 0; i < belts.length - 1; i++) {
    world.get(belts[i], 'Belt').outPort = { kind: 'belt', eid: belts[i + 1], role: 'in' };   // 带↔带直连
  }
  return belts;
}

// 把已存在的带 a 的头部直连到带 b 的尾部(带↔带直连, 不经分拣器)。
export function linkBelts(world, aBelt, bBelt) {
  const a = world.get(aBelt, 'Belt');
  if (a && world.has(bBelt, 'Belt')) { a.outPort = { kind: 'belt', eid: bBelt, role: 'in' }; return true; }
  return false;
}

// 放置一个分拣器。from/to 为 Port {kind:'inv'|'belt', eid, role}(取货端/放货端)。
// opts: { buildingId, rate, filter }。返回实体 id(失败返回 null)。
export function placeInserter(world, ctx, from, to, opts = {}) {
  const { registry, spatial, bus } = ctx;
  const buildingId = opts.buildingId || 'inserter';
  const b = registry.buildings[buildingId];
  if (b && b.locked && !(registry.isUnlocked && registry.isUnlocked(buildingId))) return null;
  const mt = registry.machineTypes[(b && b.machine) || 'inserter_mk1'] || {};
  const rate = opts.rate != null ? opts.rate : (mt.rate != null ? mt.rate : 4);
  const filter = opts.filter != null ? opts.filter : null;
  const dir = midPortDir(world, from, to);

  const e = world.create();
  world.add(e, 'Anchor', { dir: [dir[0], dir[1], dir[2]], yaw: opts.yaw || 0 });
  world.add(e, 'Building', { typeId: buildingId, mesh: (b && b.mesh) || mt.mesh || 'inserter' });
  world.add(e, 'Inserter', { from, to, rate, filter, carry: null, charge: 0 });
  if (spatial) spatial.insert(e, dir);
  if (bus) bus.emit('build', { eid: e, buildingId });
  return e;
}

// 分拣器装在建筑边缘(网格版): mountEid=所在建筑(须在平台上, 有 GridSlot); axis={di,dj}=向外的网格轴;
// reach=抓取格距边缘的格数(1/2/3); mode='in'(抓取格→建筑) | 'out'(建筑→抓取格); filtered=sorter。
// 分拣器嵌在该边中点, 爪子朝外; 抓取格(gi,gj)由 footprint 边缘 + reach 决定。运行时动态解析抓取格里的实体。
export function placeInserterMounted(world, ctx, mountEid, axis, reach, mode, filtered) {
  const { registry, spatial, bus } = ctx;
  const buildingId = filtered ? 'sorter' : 'inserter';
  const b = registry.buildings[buildingId];
  if (b && b.locked && !(registry.isUnlocked && registry.isUnlocked(buildingId))) return null;
  const slot = world.get(mountEid, 'GridSlot');
  if (!slot || !world.alive(slot.pad)) return null;                 // 必须放在平台上的建筑
  const pad = world.get(slot.pad, 'BuildPad');
  const R = ctx.planet ? ctx.planet.params.radius : 100;
  const mt = registry.machineTypes[(b && b.machine) || 'inserter_mk1'] || {};
  const rate = mt.rate != null ? mt.rate : 4;
  const rr = Math.max(1, Math.min(3, reach || 1));
  const { i, j, w, h } = slot;
  const di = axis.di | 0, dj = axis.dj | 0;
  const alongI = i + (w - 1) / 2, alongJ = j + (h - 1) / 2;   // 边的真中点(沿边方向)
  const NUDGE = 0.2;                                          // 贴住建筑外沿(靠外沿格, 不悬空)

  // 抓取格(整数格, reach 外移) + 锚点(边中点, 贴外沿) + 朝向 quarter(向外)
  let gi, gj, ai, aj, quarter;
  if (di > 0) { gi = i + w - 1 + rr; gj = Math.round(alongJ); ai = i + w - 1 + NUDGE; aj = alongJ; quarter = 0; }
  else if (di < 0) { gi = i - rr; gj = Math.round(alongJ); ai = i - NUDGE; aj = alongJ; quarter = 2; }
  else if (dj > 0) { gj = j + h - 1 + rr; gi = Math.round(alongI); aj = j + h - 1 + NUDGE; ai = alongI; quarter = 1; }
  else { gj = j - rr; gi = Math.round(alongI); aj = j - NUDGE; ai = alongI; quarter = 3; }

  const anchorDir = cellToDir(pad, ai, aj, R);
  const yaw = snapYaw(pad, anchorDir, quarter);

  const e = world.create();
  world.add(e, 'Anchor', { dir: [anchorDir[0], anchorDir[1], anchorDir[2]], yaw });
  world.add(e, 'Building', { typeId: buildingId, mesh: (b && b.mesh) || mt.mesh || 'inserter' });
  world.add(e, 'Inserter', { mount: mountEid, pad: slot.pad, gi, gj, reach: rr, mode: mode === 'out' ? 'out' : 'in', rate, filter: filtered ? [] : null, carry: null, charge: 0 });
  if (spatial) spatial.insert(e, anchorDir);
  if (bus) bus.emit('build', { eid: e, buildingId });
  return e;
}

// 放置一个分流器(单点放置)。dir 为球面方向; opts: { buildingId, ins:[beltId], outs:[beltId], mode, filters, rate }。
// dir 缺省时用入/出带端点中点。返回实体 id(失败返回 null)。
export function placeSplitter(world, ctx, dir = null, opts = {}) {
  const { registry, spatial, bus } = ctx;
  const buildingId = opts.buildingId || 'splitter';
  const b = registry.buildings[buildingId];
  if (b && b.locked && !(registry.isUnlocked && registry.isUnlocked(buildingId))) return null;
  const mt = registry.machineTypes[(b && b.machine) || 'splitter_mk1'] || {};
  const ins = opts.ins ? [...opts.ins] : [];
  const outs = opts.outs ? [...opts.outs] : [];
  const mode = opts.mode || 'balance';
  const rate = opts.rate != null ? opts.rate : (mt.rate != null ? mt.rate : 8);

  // 锚点: 优先给定 dir; 否则取相连带端点中点
  let anchor = dir;
  if (!anchor) {
    const acc = [0, 0, 0]; let cnt = 0;
    const addEnd = (beltId, end) => { const bl = world.get(beltId, 'Belt'); if (bl) { const p = bl[end]; acc[0] += p[0]; acc[1] += p[1]; acc[2] += p[2]; cnt++; } };
    for (const id of ins) addEnd(id, 'to');       // 入带的头端接分流器
    for (const id of outs) addEnd(id, 'from');     // 出带的尾端接分流器
    anchor = cnt > 0 ? norm(acc) : [0, 1, 0];
  }

  const e = world.create();
  world.add(e, 'Anchor', { dir: [anchor[0], anchor[1], anchor[2]], yaw: opts.yaw || 0 });
  world.add(e, 'Building', { typeId: buildingId, mesh: (b && b.mesh) || mt.mesh || 'splitter' });
  world.add(e, 'Splitter', { ins, outs, mode, filters: opts.filters || {}, rate, rr: 0, rrIn: 0, charge: 0 });
  if (spatial) spatial.insert(e, anchor);
  if (bus) bus.emit('build', { eid: e, buildingId });
  return e;
}

// 拆除: 移除组件/实体, 回收其地形坑 edit 并失效该区域。
// 注意: 挖掘区(DigZone)的顶点级变形是"永久"的 —— 不再清空 planet.params.digZoneVertices,
// 已挖出的坑留在地形上, 只有"显式 terrain restore UI"才能抹平(目前没有)。这样拆除矿场/换区
// 不会让已经啃出来的坑恢复。
export function demolish(world, ctx, eid) {
  const { planet, spatial, bus } = ctx;
  const restoreOne = (edit, map, key) => {
    if (!edit || !planet) return;
    const i = planet.params.edits.indexOf(edit);
    if (i >= 0) planet.params.edits.splice(i, 1);
    if (map) map.delete(key);
    planet._buildNoise();
    for (const r of planet.roots) planet._invalidateAffected(r, { x: edit.pos[0], y: edit.pos[1], z: edit.pos[2] }, edit.radius);
    planet._editPending = true;
  };
  // 旧直挖矿机的坑(单 edit, key = eid)
  restoreOne(ctx.minerEdits && ctx.minerEdits.get(eid), ctx.minerEdits, eid);
  // 独立挖掘区(R5): ctx.zoneEdits key = zone 实体 eid。拆除 zone → 清其 dry edit。
  // 旧版兼容: 还可能有 "eid:zoneId" 形式(depot 嵌套时代), 一并清。
  if (ctx.zoneEdits) {
    const prefix = eid + ':';
    for (const key of [...ctx.zoneEdits.keys()]) {
      if (key === eid || (typeof key === 'string' && key.startsWith(prefix))) {
        restoreOne(ctx.zoneEdits.get(key), ctx.zoneEdits, key);
      }
    }
  }
  // 建造平台的整平区(网格建造)
  restoreOne(ctx.padEdits && ctx.padEdits.get(eid), ctx.padEdits, eid);
  // 释放锁定到该实体的挖机(若是 zone 实体)
  if (world.has(eid, 'DigZone')) {
    for (const exE of world.query('Excavator')) {
      const ex = world.get(exE, 'Excavator');
      if (ex.targetZone === eid) { ex.targetZone = null; ex.targetVertex = null; ex.state = 'idle'; }
    }
  }
  // 释放归属该 depot 的挖机/采矿卡车(depot 拆了, 它们失业)
  if (world.has(eid, 'Depot')) {
    for (const exE of world.query('Excavator')) {
      const ex = world.get(exE, 'Excavator');
      if (ex.depot === eid) world.destroy(exE);
    }
    for (const trE of world.query('MineTruck')) {
      const tr = world.get(trE, 'MineTruck');
      if (tr.depot === eid) world.destroy(trE);
    }
  }
  // 释放网格占位
  const slot = world.get(eid, 'GridSlot');
  if (slot && world.alive(slot.pad)) { const pad = world.get(slot.pad, 'BuildPad'); if (pad) freePlaced(pad, slot.i, slot.j, slot.w, slot.h); }
  if (spatial) spatial.remove(eid);
  world.destroy(eid);
  if (bus) bus.emit('demolish', { eid });
}
