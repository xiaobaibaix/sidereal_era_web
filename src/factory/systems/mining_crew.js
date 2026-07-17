// 矿场采矿小队(挖机 + 采矿卡车) —— 替代"直挖矿机"的新采矿方式。
//   矿场(Depot): 被动容器, 自身不挖。Depot.coverageRadius 决定其覆盖范围;
//                 覆盖范围内的**独立挖掘区实体**(DigZone)都可被该矿场的挖机开采。
//                 多对多: 一个矿场可覆盖多个挖掘区, 一个挖掘区可被多个矿场共享。
//   挖掘区(DigZone 独立实体): 自己一个实体(Anchor+Building+DigZone), 不再嵌套在 depot 里。
//       放置后立刻被覆盖范围内的所有 depot 自动覆盖(coverage 系统每 tick 刷新 Depot.coverageZones)。
//   挖机(Excavator): 归属某矿场(depot)。在其 depot 的覆盖挖掘区里"逐顶点"啃地形:
//       - 每台挖机有自己的 digReach(挖掘臂角半径), 只能挖到范围内的顶点;
//       - 一次只挖一个顶点(降低 zone.vertices[i].offset), 视觉上"一点点"下降;
//       - 策略: 以最低点为平面基准(planeH=min baseH), 把"高于基准"的顶点全部挖到基准 → 平整出平面;
//       - frontier 扩展: 从基准/动工区向外, 由低到高平整(不再东一个坑西一个坑, 也不挖成碗);
//       - 顶点 ownerId 互斥(挖机间不重叠); 顶点挖到 targetOffset(=baseH-planeH)即释放, 找下一个待平整点。
//   采矿卡车(MineTruck): 把挖机缓冲运进矿场库存。
//   下游: 矿场是 Provider, 物流卡车(logistics)从矿场取货送冶炼/仓库 —— 与旧矿机对下游一致。
//   永久变形: 顶点级变形(offset)同步到 planet.params.digZoneVertices 后, 即便 depot/zone 被拆除,
//   对应条目仍按 zone id 永久保留(地形保持已挖出的坑, 不恢复)。
// 只有"挖掘区落在某 depot 覆盖内 + 该 depot 有挖机 + 有采矿卡车"三者齐备, 矿场才会进货。

import { oreColumn, layerAt } from '../ore.js';
import { invTotal, invAdd, invTake, invSpace } from '../core/inventory.js';
import { moveToward, tangentToward, dot, cross, norm, angle, randInCap } from '../core/sphere.js';

const anchorDir = (world, eid) => [...world.get(eid, 'Anchor').dir];

// 全局 zone id 分配(进程内单调递增; 不同 world 共享, 但 zone id 冲突概率极低且只用于 terrain 渲染层)
let _nextZoneId = 1;

export function createMiningCrewSystem(opts = {}) {
  const COMMIT_EVERY = opts.commitEvery != null ? opts.commitEvery : 0.15;
  const LOAD_RATE = opts.loadRate != null ? opts.loadRate : 200;
  let timer = 0, dirty = false;

  return function miningCrewSystem(world, dt, ctx) {
    const planet = ctx.planet, reg = ctx.registry;
    const R = planet ? planet.params.radius : 100;
    // 1. 刷新所有 depot 的覆盖列表(廉价: 每 depot 一次空间查询)
    refreshAllCoverage(world, ctx);
    // 2. 挖机 / 采矿卡车 推进
    for (const e of world.query('Excavator', 'Inventory', 'Mover')) {
      if (stepExcavator(world, dt, ctx, e, reg, R)) dirty = true;
    }
    for (const e of world.query('MineTruck', 'Mover')) {
      stepMineTruck(world, dt, ctx, e, reg, R, LOAD_RATE);
    }
    if (dirty && planet) {
      timer += dt;
      if (timer >= COMMIT_EVERY) { syncDigZoneVertices(world, ctx); commitTerrain(planet, ctx); timer = 0; dirty = false; }
    }
  };
}

// ---- 覆盖系统: 计算每个 depot 的覆盖挖掘区列表 ----
// 多对多: 一个 zone 可被多个 depot 覆盖, 一个 depot 可覆盖多个 zone。
// Depot.coverageZones = [zoneEid, ...](每 tick 重写)。spatial.queryCap 内部已高效。
export function refreshAllCoverage(world, ctx) {
  if (!ctx.spatial) return;
  for (const e of world.query('Depot', 'Anchor')) {
    const dep = world.get(e, 'Depot');
    const a = world.get(e, 'Anchor');
    const radius = dep.coverageRadius || 0.16;
    const out = [];
    ctx.spatial.queryCap(a.dir, radius, out);
    dep.coverageZones = out.filter((id) => id !== e && world.has(id, 'DigZone'));
  }
}

// 公开: 取某 depot 当前覆盖的所有 zone eid(测试/inspector 用)。一次性计算, 不写缓存。
export function getDepotCoverage(world, ctx, depotEid) {
  if (!ctx.spatial) return [];
  const a = world.get(depotEid, 'Anchor');
  if (!a) return [];
  const dep = world.get(depotEid, 'Depot');
  const radius = (dep && dep.coverageRadius) || 0.16;
  const out = [];
  ctx.spatial.queryCap(a.dir, radius, out);
  return out.filter((id) => id !== depotEid && world.has(id, 'DigZone'));
}

// 公开: 取覆盖某 zone 的所有 depot eid(测试/inspector 用)。
export function getZoneDepots(world, ctx, zoneEid) {
  if (!ctx.spatial) return [];
  const a = world.get(zoneEid, 'Anchor');
  if (!a) return [];
  const out = [];
  for (const e of world.query('Depot', 'Anchor')) {
    const dep = world.get(e, 'Depot');
    const radius = (dep && dep.coverageRadius) || 0.16;
    if (angle(a.dir, world.get(e, 'Anchor').dir) <= radius) out.push(e);
  }
  return out;
}

// 在挖机 depot 覆盖的所有 zone 中找下一个目标。返回 { zoneEid, vertexIdx } or null。
// 策略(B5+ 平整版): 把"高于基准平面 planeH"的顶点全部挖到 planeH, 形成平整平面(不再挖成坑/碗)。
//   - 顶点的 targetOffset = baseH - planeH(clamp 到 hardLimit); offset < targetOffset 即"还有工作"
//   - 选目标: 范围内 + 未被他人锁 + 还有工作量(offset < targetOffset) + 紧邻"已动工/已到位"顶点(frontier)
//   - 在 frontier 中选 baseH 最低的(从基准向外、由低到高平整)
//   - 互斥 ownerId; 已到位(offset>=targetOffset)跳过
//   - 兜底: 范围内无 frontier(挖机离动工区太远)时, 退化到任意有工作量的顶点(最低 baseH 优先)
// 跨 zone 选择: 在所有 zone 的候选中选 baseH 最低的(挖机顺势去最近的低处开工)。
// zones 参数 = [{ eid, data }](data = world.get(eid, 'DigZone'))
function findNextVertex(zones, fromDir, reach, selfEid) {
  // 第一轮: frontier 候选
  let bestEid = null, bestIdx = -1, bestH = Infinity;
  for (const { eid, data } of zones) {
    const vs = data.vertices;
    if (!vs || vs.length === 0) continue;
    let hasAnchor = false;
    for (const v of vs) {
      if (v.offset >= v.targetOffset - 1e-6 || v.offset > 0 || v.ownerId != null) { hasAnchor = true; break; }
    }
    if (!hasAnchor) continue;
    for (let i = 0; i < vs.length; i++) {
      const v = vs[i];
      if (v.ownerId != null && v.ownerId !== selfEid) continue;
      if (v.offset >= v.targetOffset - 1e-6) continue;
      let frontier = false;
      for (const ni of (v.neighbors || [])) {
        const nv = vs[ni];
        if (nv.offset >= nv.targetOffset - 1e-6 || nv.offset > 0
            || (nv.ownerId != null && nv.ownerId !== selfEid)) { frontier = true; break; }
      }
      if (!frontier) continue;
      const ang = angle(fromDir, v.dir);
      if (ang > reach) continue;
      if (v.baseH < bestH) { bestH = v.baseH; bestEid = eid; bestIdx = i; }
    }
  }
  if (bestIdx >= 0) return { zoneEid: bestEid, vertexIdx: bestIdx };

  // 第二轮(兜底): 任意有工作量的顶点, baseH 最低优先
  bestEid = null; bestIdx = -1; bestH = Infinity;
  for (const { eid, data } of zones) {
    const vs = data.vertices;
    if (!vs || vs.length === 0) continue;
    for (let i = 0; i < vs.length; i++) {
      const v = vs[i];
      if (v.ownerId != null && v.ownerId !== selfEid) continue;
      if (v.offset >= v.targetOffset - 1e-6) continue;
      const ang = angle(fromDir, v.dir);
      if (ang > reach) continue;
      if (v.baseH < bestH) { bestH = v.baseH; bestEid = eid; bestIdx = i; }
    }
  }
  return bestIdx >= 0 ? { zoneEid: bestEid, vertexIdx: bestIdx } : null;
}

// 释放挖机对当前顶点的锁定(ownerId=null, targetZone/Vertex=null)
function releaseVertex(zoneData, ex, eid) {
  if (ex.targetVertex == null || ex.targetZone == null) { ex.targetZone = null; ex.targetVertex = null; ex.digProgress = 0; return; }
  const v = zoneData.vertices && zoneData.vertices[ex.targetVertex];
  if (v && v.ownerId === eid) v.ownerId = null;
  ex.targetVertex = null;
  ex.targetZone = null;
  ex.digProgress = 0;
}

// 挖机(逐顶点版): 在 depot 覆盖的任一挖掘区里"找下一个待平整顶点 → 移过去 → 啃到 planeH → 释放 → 找下一个"。
// 状态机: idle(寻点冷却) → moving → digging → idle(平整完一个找下一个)/ full(满仓)
// 返回是否改动了地形(顶点 offset 变了 → 需提交)。
function stepExcavator(world, dt, ctx, e, reg, R) {
  const ex = world.get(e, 'Excavator');
  const inv = world.get(e, 'Inventory');
  const mv = world.get(e, 'Mover');
  if (ex.depot == null || !world.alive(ex.depot)) { ex.state = 'idle'; return false; }
  const dep = world.get(ex.depot, 'Depot');
  const zoneEids = dep && dep.coverageZones;
  if (!zoneEids || zoneEids.length === 0) { ex.state = 'idle'; return false; }
  // 收集 zone data 列表(过滤掉已销毁的)
  const zones = [];
  for (const eid of zoneEids) {
    if (!world.alive(eid)) continue;
    const data = world.get(eid, 'DigZone');
    if (data && data.vertices) zones.push({ eid, data });
  }
  if (zones.length === 0) { ex.state = 'idle'; return false; }

  const mt = reg.machineTypes[ex.typeId] || {};
  const cap = inv.cap == null ? Infinity : inv.cap;

  // 满仓 → 释放锁定 + 等卡车
  if (invTotal(inv) >= cap) {
    if (ex.targetVertex != null && ex.targetZone != null) {
      const zd = world.get(ex.targetZone, 'DigZone');
      if (zd) releaseVertex(zd, ex, e);
    }
    ex.state = 'full';
    return false;
  }

  // 1. 无锁定 → 寻点(受 searchCooldown 节流, 避免每帧扫所有顶点)
  if (ex.targetVertex == null) {
    if (ex.searchCooldown > 0) {
      ex.searchCooldown -= dt;
      ex.state = 'idle';
      return false;
    }
    ex.searchCooldown = 0.3;   // 找不到时半秒后再试
    const pick = findNextVertex(zones, mv.dir, ex.digReach, e);
    if (pick == null) { ex.state = 'idle'; return false; }
    const zd = world.get(pick.zoneEid, 'DigZone');
    const v = zd.vertices[pick.vertexIdx];
    v.ownerId = e;             // 锁定(互斥)
    ex.targetZone = pick.zoneEid;
    ex.targetVertex = pick.vertexIdx;
    ex.digProgress = 0;
    mv.target = [...v.dir];
    ex.state = 'moving';
    // 不 return: 本帧继续尝试移动
  }

  // 防御: zone 在跨 tick 期间被外部删除
  const zoneData = ex.targetZone != null ? world.get(ex.targetZone, 'DigZone') : null;
  if (!zoneData) { ex.targetZone = null; ex.targetVertex = null; ex.state = 'idle'; return false; }
  if (ex.targetVertex == null || ex.targetVertex >= zoneData.vertices.length) {
    releaseVertex(zoneData, ex, e); ex.state = 'idle'; return false;
  }
  const v = zoneData.vertices[ex.targetVertex];

  // 防御: 顶点已挖到平整目标(可能跨 tick 期间被外部改动)
  if (v.offset >= v.targetOffset - 1e-6) {
    releaseVertex(zoneData, ex, e);
    ex.state = 'idle';
    return false;
  }

  // 2. moving: 朝顶点方向移动
  if (ex.state === 'moving') {
    const maxAng = ((mt.speed || 16) / R) * dt;
    const r = moveToward(mv.dir, mv.target, maxAng);
    mv.dir = r.dir;
    if (!r.arrived) { mv.fwd = tangentToward(mv.dir, mv.target); return false; }
    ex.state = 'digging';
  }

  // 3. digging: 推进顶点 offset(按 digRate 节流), 按当前层产矿
  ex.state = 'digging';
  const col = oreColumn(v.dir, reg.ore);
  const dd = Math.min((mt.digRate || 0.05) * dt, v.targetOffset - v.offset);
  if (dd <= 0) {
    releaseVertex(zoneData, ex, e);
    ex.state = 'idle';
    return false;
  }
  v.offset += dd;
  ex.digProgress += dd;
  // 维护 zone.depth = 最深顶点 offset(向后兼容: 旧 inspector/test 读 zone.depth 判断"挖深了没")
  if (v.offset > zoneData.depth) zoneData.depth = v.offset;
  ex.lastItem = null;
  const layer = layerAt(col, v.offset);
  if (layer) {
    invAdd(inv, layer.item, dd * (mt.yield || 100));
    ex.lastItem = layer.item;
    v.lastItem = layer.item;
  }
  // 挖到目标平面 → 释放, 下次 tick 寻下一个待平整顶点
  if (v.offset >= v.targetOffset - 1e-6) {
    releaseVertex(zoneData, ex, e);
    ex.state = 'idle';
  }
  return true;   // offset 变了 → dirty=true → commitTerrain 会 syncDigZoneVertices
}

function nearestExcavatorWithOre(world, depot, dir) {
  let best = null, bd = -2;
  for (const e of world.query('Excavator', 'Inventory', 'Mover')) {
    if (world.get(e, 'Excavator').depot !== depot) continue;
    if (invTotal(world.get(e, 'Inventory')) < 1) continue;
    const d = dot(dir, world.get(e, 'Mover').dir);
    if (d > bd) { bd = d; best = e; }
  }
  return best;
}

// 采矿卡车: 挖机缓冲 → 矿场库存
function stepMineTruck(world, dt, ctx, e, reg, R, loadRate) {
  const t = world.get(e, 'MineTruck');
  const mv = world.get(e, 'Mover');
  if (t.depot == null || !world.alive(t.depot)) { t.state = 'idle'; return; }
  const mt = reg.machineTypes[t.typeId] || {};
  const cap = t.cap || mt.cap || 80;
  const maxAng = ((mt.speed || 22) / R) * dt;

  switch (t.state) {
    case 'idle': {
      if (t.cargoAmt > 0) { mv.target = anchorDir(world, t.depot); t.state = 'to_depot'; return; }
      const src = nearestExcavatorWithOre(world, t.depot, mv.dir);
      if (src == null) return;
      t.source = src; mv.target = [...world.get(src, 'Mover').dir]; t.state = 'to_exca';
      return;
    }
    case 'to_exca': {
      if (t.source == null || !world.alive(t.source)) { t.state = t.cargoAmt > 0 ? 'to_depot' : 'idle'; return; }
      mv.target = [...world.get(t.source, 'Mover').dir];   // 挖机会移动, 持续追踪
      const r = moveToward(mv.dir, mv.target, maxAng); mv.dir = r.dir;
      if (r.arrived) t.state = 'load'; else mv.fwd = tangentToward(mv.dir, mv.target);
      return;
    }
    case 'load': {
      if (t.source == null || !world.alive(t.source)) { t.state = t.cargoAmt > 0 ? 'to_depot' : 'idle'; return; }
      const inv = world.get(t.source, 'Inventory');
      const room = cap - t.cargoAmt;
      if (room <= 1e-6) { mv.target = anchorDir(world, t.depot); t.state = 'to_depot'; return; }
      let item = t.cargoItem;
      if (!item || !(inv.items[item] > 0)) item = Object.keys(inv.items)[0];
      if (!item) { if (t.cargoAmt > 0) { mv.target = anchorDir(world, t.depot); t.state = 'to_depot'; } else t.state = 'idle'; return; }
      const take = Math.min(loadRate * dt, room, inv.items[item]);
      t.cargoAmt += invTake(inv, item, take); t.cargoItem = item;
      if (t.cargoAmt >= cap - 1e-6) { mv.target = anchorDir(world, t.depot); t.state = 'to_depot'; }
      return;
    }
    case 'to_depot': {
      if (!world.alive(t.depot)) { t.state = 'idle'; return; }
      mv.target = anchorDir(world, t.depot);
      const r = moveToward(mv.dir, mv.target, maxAng); mv.dir = r.dir;
      if (r.arrived) t.state = 'unload'; else mv.fwd = tangentToward(mv.dir, mv.target);
      return;
    }
    case 'unload': {
      const inv = world.get(t.depot, 'Inventory');
      const space = invSpace(inv);
      if (space <= 1e-6) return;   // 矿场满, 等
      const put = Math.min(loadRate * dt, t.cargoAmt, space);
      if (put > 0) invAdd(inv, t.cargoItem, put);
      t.cargoAmt -= put;
      if (t.cargoAmt <= 1e-6) { t.cargoAmt = 0; t.cargoItem = null; t.state = 'idle'; }
      return;
    }
    default: t.state = 'idle';
  }
}

function commitTerrain(planet, ctx) {
  planet._buildNoise();
  if (ctx.zoneEdits) {
    for (const edit of ctx.zoneEdits.values()) {
      const d = { x: edit.pos[0], y: edit.pos[1], z: edit.pos[2] };
      for (const r of planet.roots) planet._invalidateAffected(r, d, edit.radius);
    }
  }
  planet._editPending = true;
}

// 存档迁移: world.load 后:
//   (a) 旧版 Depot 上挂的 DigZone.zones[] → 拆成独立挖掘区实体(Anchor+Building+DigZone);
//   (b) 旧版单 zone 形状{center, vertices, ...} 直接挂顶层 → 同样拆出独立实体;
//   (c) planet 不入 world 存档 → load 后 digZoneVertices 是空的, 同步刷新;
//   (d) 旧挖机的 targetZone(数字索引) → 清空(zone eid 体系下索引无意义)。
// 幂等: 已是 R5 格式的跳过。
export function migrateDigZones(world, ctx) {
  const planet = ctx.planet;
  const reg = ctx.registry;
  const hardnessMax = (reg.machineTypes.excavator_mk1 || {}).hardnessMax || 2;
  const depotB = reg.buildings.depot || {};
  let touched = 0;

  // (a) 旧版: Depot + DigZone(内嵌 zones[])。把每个 zone 拆成独立实体。
  for (const e of [...world.query('Depot')]) {
    const dz = world.get(e, 'DigZone');
    if (!dz) continue;
    // 兼容: 旧版单 zone 在顶层(center/vertices 直接挂 dz)
    let legacyList = [];
    if (dz.center && dz.vertices) {
      legacyList.push({
        center: dz.center,
        radius: dz.radius != null ? dz.radius : (depotB.zoneRadius || 0.05),
        resolution: dz.resolution != null ? dz.resolution : (depotB.digResolution || 0.005),
        planeH: dz.planeH || 0, depth: dz.depth || 0, vertices: dz.vertices,
      });
    }
    if (dz.zones && Array.isArray(dz.zones)) legacyList = legacyList.concat(dz.zones);
    if (legacyList.length === 0) { world.remove(e, 'DigZone'); continue; }

    const depotAnchor = world.get(e, 'Anchor');
    for (const legacy of legacyList) {
      if (!legacy || !legacy.center) continue;
      // 旧 zone 可能没有 id 或没有 vertices → 重建
      if (legacy.id == null) legacy.id = _nextZoneId++;
      const hasGoodV = legacy.vertices && legacy.vertices.length > 0
        && legacy.vertices[0].targetOffset != null;
      if (!hasGoodV) {
        legacy.vertices = generateVertices(legacy, planet, reg.ore, hardnessMax);
      }
      // 独立实体: 在 zone 中心位置创建
      const ze = world.create();
      world.add(ze, 'Anchor', { dir: [legacy.center[0], legacy.center[1], legacy.center[2]], yaw: 0 });
      world.add(ze, 'Building', { typeId: 'dig_zone', mesh: 'digZone' });
      // 拷一份干净数据(去掉辅助字段)
      world.add(ze, 'DigZone', {
        id: legacy.id,
        center: [legacy.center[0], legacy.center[1], legacy.center[2]],
        radius: legacy.radius, resolution: legacy.resolution,
        planeH: legacy.planeH || 0, depth: legacy.depth || 0,
        vertices: legacy.vertices,
      });
      if (ctx.spatial) ctx.spatial.insert(ze, legacy.center);
      touched++;
    }
    world.remove(e, 'DigZone');
  }

  // (b) 顶层 DigZone(独立实体, R5 已是) — 缺 vertices / id 的补齐
  for (const e of world.query('DigZone')) {
    if (world.has(e, 'Depot')) continue;   // 上面已处理
    const dz = world.get(e, 'DigZone');
    if (!dz || !dz.center) continue;
    if (dz.id == null) dz.id = _nextZoneId++;
    const needs = !dz.vertices || dz.vertices.length === 0
      || dz.vertices[0].targetOffset == null;
    if (needs) {
      dz.vertices = generateVertices(dz, planet, reg.ore, hardnessMax);
      touched++;
    }
  }

  // (c) 旧挖机的 targetZone 是数字索引 → 清空(zone eid 体系下索引无意义)
  for (const e of world.query('Excavator')) {
    const ex = world.get(e, 'Excavator');
    if (typeof ex.targetZone === 'number') { ex.targetZone = null; ex.targetVertex = null; touched++; }
  }

  if (touched > 0 || (planet && !planet.params.digZoneVertices)) syncDigZoneVertices(world, ctx);
  return touched;
}

// 把 world 里所有 DigZone(顶层独立实体)的顶点(挖机已改的 offset)同步到 planet.params.digZoneVertices。
// 单向数据流: world(DigZone) → planet.params → terrain.js / worker 的 heightAt。
// 永久变形语义: planet.params.digZoneVertices 是**按 zone id 索引、只增不删**的列表。
//   - 活跃 zone(在 world 里)→ 按 id 找/建条目, 原地更新 offsets;
//   - 孤儿 zone(zone 实体已拆除, 不在 world 里)→ 条目保留, 不再更新, 永久留在地形上。
// 这样拆除矿场/换区不会让已挖出的坑恢复。
export function syncDigZoneVertices(world, ctx) {
  const planet = ctx.planet;
  if (!planet) return;
  if (!planet.params.digZoneVertices) planet.params.digZoneVertices = [];
  const list = planet.params.digZoneVertices;
  const byId = new Map();
  for (const en of list) if (en.id != null) byId.set(en.id, en);
  for (const e of world.query('DigZone')) {
    const dz = world.get(e, 'DigZone');
    if (!dz || !dz.center || !dz.vertices || dz.vertices.length === 0) continue;
    if (dz.id == null) dz.id = _nextZoneId++;
    // 同步字段: 每顶点 {dir, offset, targetOffset}, zone 级 {planeH}
    //   - targetOffset: 该顶点要被挖到的目标深度(baseH - planeH, clamp 到 hardLimit)
    //   - planeH: 整平基准(最低 baseH), 用于 zone-level flatten
    //   这两项让 terrain.js 能算 "progress = IDW(offset/targetOffset)" 并把 h 整平到 planeH,
    //   而不是粗暴减 IDW(offset)(那样 baseNoise 的高频起伏会形成 bumps)。
    const projV = (v) => ({ dir: v.dir, offset: v.offset, targetOffset: v.targetOffset });
    let entry = byId.get(dz.id);
    if (!entry) {
      entry = {
        id: dz.id,
        center: dz.center,
        radius: dz.radius,
        planeH: dz.planeH || 0,
        maxInfluence: (dz.resolution || 0.005) * 1.5,
        vertices: dz.vertices.map(projV),
      };
      list.push(entry);
      byId.set(dz.id, entry);
    } else {
      const ev = entry.vertices;
      if (ev.length !== dz.vertices.length) {
        entry.center = dz.center; entry.radius = dz.radius;
        entry.planeH = dz.planeH || 0;
        entry.maxInfluence = (dz.resolution || 0.005) * 1.5;
        entry.vertices = dz.vertices.map(projV);
      } else {
        entry.planeH = dz.planeH || 0;
        for (let i = 0; i < ev.length; i++) {
          ev[i].offset = dz.vertices[i].offset;
          ev[i].targetOffset = dz.vertices[i].targetOffset;
        }
      }
    }
  }
}

// ---- 顶点网格(B升级): 在挖掘区球冠内均匀采样的离散顶点 ----
// 每个顶点 = { dir, baseH, offset, ownerId, hardLimit, lastItem }
//   - dir: 单位方向(球面采样点)
//   - baseH: 该方向的原始地形高度(生成时算好, 不再变; offset 是相对它的下挖量)
//   - offset: 已挖深度(>=0, heightAt 中减去)
//   - ownerId: 当前锁定该顶点的 Excavator eid; null = 空闲可被选
//   - hardLimit: 该顶点能挖到的最大 offset(由该方向矿柱"最浅过硬层"决定; 挖到此即挖穿)
//   - lastItem: 上一次该顶点产出的物品(显示用)
// 采样: 轴坐标六边形环 -> 切平面偏移 -> 投影到球面(归一化) -> 角距离筛 <= zone.radius。

// 在 center 切平面上找一组正交基(t1, t2)
function perpBasis(center) {
  const ref = Math.abs(center[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0];
  const t1 = norm(cross(ref, center));
  const t2 = norm(cross(center, t1));
  return [t1, t2];
}
// 沿切平面偏移 (ax 沿 t1, ay 沿 t2), 然后归一到单位球面
function offsetOnCap(center, t1, t2, ax, ay) {
  return norm([
    center[0] + t1[0] * ax + t2[0] * ay,
    center[1] + t1[1] * ax + t2[1] * ay,
    center[2] + t1[2] * ax + t2[2] * ay,
  ]);
}

// 在 zone 的球冠内生成顶点数组(挖掘区的离散"逻辑顶点", 与渲染顶点无关)
// 顶点同时记录六边形邻居(neighbors)和 targetOffset(平整目标): 用于"平整到最低点基准平面"的策略。
export function generateVertices(zone, planet, oreData, hardnessMax) {
  if (!zone || !zone.center) return [];
  const res = zone.resolution || 0.005;
  const c = zone.center;
  const [t1, t2] = perpBasis(c);
  const ringR = Math.ceil(zone.radius / res);
  const out = [];
  const qrToIdx = new Map();   // "q,r" → out 索引(用于反查邻居)
  for (let q = -ringR; q <= ringR; q++) {
    for (let r = -ringR; r <= ringR; r++) {
      // 六边形轴坐标裁剪: |q|, |r|, |q+r| 都 <= ringR
      if (Math.abs(q) > ringR || Math.abs(r) > ringR || Math.abs(q + r) > ringR) continue;
      const ax = (r + q / 2) * Math.sqrt(3) * res;
      const ay = q * 1.5 * res;
      const dir = offsetOnCap(c, t1, t2, ax, ay);
      const ang = angle(dir, c);
      if (ang > zone.radius) continue;
      // baseH = 该方向"当前"地形高度(含已有挖掘/整平), 不是原始噪声。
      //   → 已被挖低的地方 baseH 就低, targetOffset≈0, 挖机不会重复去挖已经够低的位置。
      //   (heightAt 已含其它 edits 与其它 zone 的永久变形; 本 zone 此刻尚未同步进 digZoneVertices, 无自反馈)
      const baseH = planet
        ? (planet.heightAt ? planet.heightAt(dir[0], dir[1], dir[2])
          : (planet.baseHeightAt ? planet.baseHeightAt(dir[0], dir[1], dir[2]) : 0))
        : 0;
      const col = oreColumn(dir, oreData);
      let cap = Infinity, bottom = 0;
      for (const l of col) {
        bottom = Math.max(bottom, l.d1);
        if ((l.hardness || 1) > hardnessMax) cap = Math.min(cap, l.d0);
      }
      qrToIdx.set(`${q},${r}`, out.length);
      out.push({
        dir, baseH, offset: 0, ownerId: null,
        hardLimit: Math.min(cap, bottom), lastItem: null,
        targetOffset: 0,
        neighbors: [], _qr: [q, r],
      });
    }
  }
  const HEX_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]];
  for (const v of out) {
    const [q, r] = v._qr;
    for (const [dq, dr] of HEX_DIRS) {
      const ni = qrToIdx.get(`${q + dq},${r + dr}`);
      if (ni != null) v.neighbors.push(ni);
    }
    delete v._qr;
  }
  // 平面基准 = 最低 baseH; 每个顶点的 targetOffset = clamp(baseH - planeH, 0, hardLimit)
  recomputePlaneImpl(zone, out);
  return out;
}

function recomputePlaneImpl(zone, vertices) {
  if (!vertices || vertices.length === 0) return;
  let planeH = Infinity;
  for (const v of vertices) if (v.baseH < planeH) planeH = v.baseH;
  zone.planeH = planeH;
  for (const v of vertices) {
    v.targetOffset = Math.min(Math.max(0, v.baseH - planeH), v.hardLimit);
  }
}

export function recomputePlane(zone) {
  recomputePlaneImpl(zone, zone.vertices);
}

// 放置一个**独立挖掘区实体**(R5: zone 不再嵌在 depot 里, 自己一个实体)。
//   - 该 zone 自动被覆盖范围内的所有 depot 覆盖(多对多);
//   - 删除 zone(或覆盖它的 depot)前, 顶点级变形永久保留。
// 参数 dir: 球面方向(不需要归一)。opts: { radius, resolution }(默认从 building 表 dig_zone 取)。
// 返回新 zone 实体 eid。
export function placeDigZoneEntity(world, ctx, dir, opts = {}) {
  const planet = ctx.planet;
  const reg = ctx.registry;
  const c = norm([dir[0], dir[1], dir[2]]);
  const bZ = (reg.buildings && reg.buildings.dig_zone) || {};
  const radius = opts.radius != null ? opts.radius : (bZ.zoneRadius || 0.05);
  const resolution = opts.resolution != null ? opts.resolution : (bZ.digResolution || 0.005);
  const hardnessMax = (reg.machineTypes.excavator_mk1 || {}).hardnessMax || 2;
  const id = _nextZoneId++;
  const data = {
    id, center: [c[0], c[1], c[2]],
    radius, resolution,
    planeH: 0, depth: 0, vertices: null,
  };
  data.vertices = generateVertices(data, planet, reg.ore, hardnessMax);

  const e = world.create();
  world.add(e, 'Anchor', { dir: [c[0], c[1], c[2]], yaw: 0 });
  world.add(e, 'Building', { typeId: 'dig_zone', mesh: 'digZone' });
  world.add(e, 'DigZone', data);
  if (ctx.spatial) ctx.spatial.insert(e, c);

  if (planet) {
    // 旧版"圆形 edit"(depth=0, 无视觉影响)仍保留, 用于地形失效/invalidate 触发重生成。
    if (!ctx.zoneEdits) ctx.zoneEdits = new Map();
    const edit = { pos: [c[0], c[1], c[2]], radius, depth: 0, falloff: 'smooth', dry: true };
    planet.params.edits.push(edit);
    ctx.zoneEdits.set(e, edit);   // key = zone 实体 eid
    if (planet._buildNoise) planet._buildNoise();
    if (planet.roots) for (const r of planet.roots) planet._invalidateAffected(r, { x: c[0], y: c[1], z: c[2] }, radius);
    planet._editPending = true;
    syncDigZoneVertices(world, ctx);
  }
  if (ctx.bus) ctx.bus.emit('build', { eid: e, buildingId: 'dig_zone' });
  return e;
}

// 拆除独立挖掘区实体。地形顶点变形永久保留(仅停止 AI 在该 zone 工作)。
export function removeDigZoneEntity(world, ctx, zoneEid) {
  if (!world.alive(zoneEid)) return false;
  // 释放锁定该 zone 顶点的挖机
  for (const e of world.query('Excavator')) {
    const ex = world.get(e, 'Excavator');
    if (ex.targetZone === zoneEid) { ex.targetZone = null; ex.targetVertex = null; ex.state = 'idle'; }
  }
  // 回收 dry edit(永久变形 digZoneVertices 不清)
  if (ctx.zoneEdits && ctx.zoneEdits.has(zoneEid)) {
    const edit = ctx.zoneEdits.get(zoneEid);
    if (ctx.planet) {
      const planet = ctx.planet;
      const i = planet.params.edits.indexOf(edit);
      if (i >= 0) planet.params.edits.splice(i, 1);
      planet._buildNoise();
      for (const r of planet.roots) planet._invalidateAffected(r, { x: edit.pos[0], y: edit.pos[1], z: edit.pos[2] }, edit.radius);
      planet._editPending = true;
    }
    ctx.zoneEdits.delete(zoneEid);
  }
  if (ctx.spatial) ctx.spatial.remove(zoneEid);
  world.destroy(zoneEid);
  syncDigZoneVertices(world, ctx);
  if (ctx.bus) ctx.bus.emit('demolish', { eid: zoneEid });
  return true;
}

// 兼容包装(R5 前): setDigZone(world, ctx, depotEid, centerDir) → 创建独立挖掘区实体。
// depotEid 现已忽略(zone 自动被覆盖范围内的 depot 覆盖)。返回新 zone 实体 eid。
export function setDigZone(world, ctx, _depotEidIgnored, centerDir) {
  return placeDigZoneEntity(world, ctx, centerDir);
}

// 生成挖机(绑定到某矿场, 散布在该矿场覆盖的挖掘区附近; 覆盖范围内任意 zone 都可被它开采)
export function spawnExcavators(world, ctx, n, depotEid, typeId = 'excavator_mk1') {
  const mt = ctx.registry.machineTypes[typeId] || {};
  // 优先散布到 depot 当前覆盖的某个 zone 中心附近(挖机臂半径有限, 离 zone 太远挖不到);
  // 若 depot 暂无覆盖 zone, 退到 depot 自身位置(等用户后续放 zone)。
  const zoneEids = getDepotCoverage(world, ctx, depotEid);
  const near = zoneEids.length > 0
    ? [...world.get(zoneEids[0], 'Anchor').dir]
    : anchorDir(world, depotEid);
  const spread = zoneEids.length > 0 ? 0.04 : 0.06;
  const out = [];
  for (let i = 0; i < n; i++) {
    const dir = randInCap(near, spread);
    const e = world.create();
    world.add(e, 'Agent', { typeId, kind: 'excavator', mesh: mt.mesh || 'excavator' });
    world.add(e, 'Mover', { dir, fwd: tangentToward(dir, near), target: [...dir] });
    world.add(e, 'Excavator', {
      typeId, depot: depotEid, state: 'idle',
      digReach: mt.digReach || 0.025, digStep: mt.digStep || 0.02,
      targetZone: null, targetVertex: null, digProgress: 0, searchCooldown: 0,
      lastItem: null,
    });
    world.add(e, 'Inventory', { items: {}, cap: mt.cap || 60 });
    if (ctx.spatial) ctx.spatial.insert(e, dir);
    out.push(e);
  }
  if (ctx.bus) ctx.bus.emit('spawn', { kind: 'excavator', count: n });
  return out;
}

// 生成采矿卡车(绑定到某矿场, 在矿场附近散布)
export function spawnMineTrucks(world, ctx, n, depotEid, typeId = 'mine_truck_mk1') {
  const mt = ctx.registry.machineTypes[typeId] || {};
  const near = anchorDir(world, depotEid);
  const out = [];
  for (let i = 0; i < n; i++) {
    const dir = randInCap(near, 0.06);
    const e = world.create();
    world.add(e, 'Agent', { typeId, kind: 'minetruck', mesh: mt.mesh || 'truck' });
    world.add(e, 'Mover', { dir, fwd: tangentToward(dir, near), target: [...dir] });
    world.add(e, 'MineTruck', { typeId, depot: depotEid, state: 'idle', cargoItem: null, cargoAmt: 0, cap: mt.cap || 80, source: null });
    if (ctx.spatial) ctx.spatial.insert(e, dir);
    out.push(e);
  }
  if (ctx.bus) ctx.bus.emit('spawn', { kind: 'minetruck', count: n });
  return out;
}
