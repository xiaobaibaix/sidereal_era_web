// 矿场采矿小队(挖机 + 采矿卡车) —— 替代"直挖矿机"的新采矿方式。
//   矿场(Depot): 被动容器, 自身不挖。需先"圈定挖掘区"(DigZone.center), 再生成挖机 + 采矿卡车。
//   挖机(Excavator): 在矿场挖掘区里"逐顶点"啃地形(B升级):
//       - 每台挖机有自己的 digReach(挖掘臂角半径), 只能挖到范围内的顶点;
//       - 一次只挖一个顶点(降低 zone.vertices[i].offset), 视觉上"一点点"下降;
//       - 策略: 优先挖范围内最高的顶点; 顶点 ownerId 互斥(挖机间不重叠);
//       - 顶点挖穿(offset >= hardLimit)即释放, 寻找下一个高点。
//   采矿卡车(MineTruck): 把挖机缓冲运进矿场库存。
//   下游: 矿场是 Provider, 物流卡车(logistics)从矿场取货送冶炼/仓库 —— 与旧矿机对下游一致。
// 只有"圈定挖掘区 + 有挖机 + 有采矿卡车"三者齐备, 矿场才会进货。

import { oreColumn, layerAt } from '../ore.js';
import { invTotal, invAdd, invTake, invSpace } from '../core/inventory.js';
import { moveToward, tangentToward, dot, cross, norm, angle, randInCap } from '../core/sphere.js';

const anchorDir = (world, eid) => [...world.get(eid, 'Anchor').dir];

export function createMiningCrewSystem(opts = {}) {
  const COMMIT_EVERY = opts.commitEvery != null ? opts.commitEvery : 0.15;
  const LOAD_RATE = opts.loadRate != null ? opts.loadRate : 200;
  let timer = 0, dirty = false;

  return function miningCrewSystem(world, dt, ctx) {
    const planet = ctx.planet, reg = ctx.registry;
    const R = planet ? planet.params.radius : 100;
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

// 在 zone 顶点中找"挖机能挖到的最高顶点"。返回顶点索引 or null。
//   R3: ang <= reach(挖机臂半径内)
//   R4: 选 baseH-offset 最高的(当前实际高度最大)
//   R6: 跳过被其他挖机占用的顶点(ownerId != null && != selfEid)
function findHighestVertex(zone, fromDir, reach, selfEid) {
  let bestIdx = -1, bestH = -Infinity;
  for (let i = 0; i < zone.vertices.length; i++) {
    const v = zone.vertices[i];
    if (v.ownerId != null && v.ownerId !== selfEid) continue;   // R6 互斥
    if (v.offset >= v.hardLimit - 1e-6) continue;               // 已挖穿
    const ang = angle(fromDir, v.dir);
    if (ang > reach) continue;                                  // R3 超范围
    const h = v.baseH - v.offset;                               // 当前实际高度
    if (h > bestH) { bestH = h; bestIdx = i; }
  }
  return bestIdx >= 0 ? bestIdx : null;
}

// 释放挖机对当前顶点的锁定(ownerId=null, targetVertex=null)
function releaseVertex(zone, ex, eid) {
  if (ex.targetVertex == null) return;
  const v = zone.vertices[ex.targetVertex];
  if (v && v.ownerId === eid) v.ownerId = null;
  ex.targetVertex = null;
  ex.digProgress = 0;
}

// 挖机(逐顶点版): 在挖掘区里"找最高顶点 → 移过去 → 啃一个顶点 → 挖穿释放 → 找下一个"。
// 状态机: idle(寻点冷却) → moving → digging → idle(挖穿后寻下一个)/ full(满仓)
// 返回是否改动了地形(顶点 offset 变了 → 需提交)。
function stepExcavator(world, dt, ctx, e, reg, R) {
  const ex = world.get(e, 'Excavator');
  const inv = world.get(e, 'Inventory');
  const mv = world.get(e, 'Mover');
  if (ex.depot == null || !world.alive(ex.depot)) { ex.state = 'idle'; return false; }
  const zone = world.get(ex.depot, 'DigZone');
  if (!zone || !zone.center || !zone.vertices || zone.vertices.length === 0) {
    ex.state = 'idle'; return false;
  }
  const mt = reg.machineTypes[ex.typeId] || {};
  const cap = inv.cap == null ? Infinity : inv.cap;

  // 满仓 → 释放锁定 + 等卡车
  if (invTotal(inv) >= cap) {
    if (ex.targetVertex != null) releaseVertex(zone, ex, e);
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
    const idx = findHighestVertex(zone, mv.dir, ex.digReach, e);
    if (idx == null) { ex.state = 'idle'; return false; }
    const v = zone.vertices[idx];
    v.ownerId = e;             // 锁定(R6 互斥)
    ex.targetVertex = idx;
    ex.digProgress = 0;
    mv.target = [...v.dir];
    ex.state = 'moving';
    // 不 return: 本帧继续尝试移动
  }

  const v = zone.vertices[ex.targetVertex];

  // 防御: 顶点已被挖穿(可能跨 tick 期间被外部释放/改动)
  if (v.offset >= v.hardLimit - 1e-6) {
    releaseVertex(zone, ex, e);
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
  const dd = Math.min((mt.digRate || 0.05) * dt, v.hardLimit - v.offset);
  if (dd <= 0) {
    releaseVertex(zone, ex, e);
    ex.state = 'idle';
    return false;
  }
  v.offset += dd;
  ex.digProgress += dd;
  // 维护 zone.depth = 最深顶点 offset(向后兼容: 旧 inspector/test 读 zone.depth 判断"挖深了没")
  if (v.offset > zone.depth) zone.depth = v.offset;
  ex.lastItem = null;
  const layer = layerAt(col, v.offset);
  if (layer) {
    invAdd(inv, layer.item, dd * (mt.yield || 100));
    ex.lastItem = layer.item;
    v.lastItem = layer.item;
  }
  // 挖穿 → 释放, 下次 tick 寻新顶点(R5 找下一个高点)
  if (v.offset >= v.hardLimit - 1e-6) {
    releaseVertex(zone, ex, e);
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

// 存档迁移: world.load 后, 旧存档的 DigZone 可能没有 vertices 字段(本特性之前)。
// 扫描所有"已圈定(center != null)但无 vertices"的 DigZone, 用当前 planet/ore 重新生成顶点网格。
// 同时刷新 planet.params.digZoneVertices(因为 planet 不入 world 存档, load 后是空的)。
// 幂等: vertices 已存在的跳过; center 未圈的跳过。
export function migrateDigZones(world, ctx) {
  const planet = ctx.planet;
  const reg = ctx.registry;
  const hardnessMax = (reg.machineTypes.excavator_mk1 || {}).hardnessMax || 2;
  let touched = 0;
  for (const e of world.query('DigZone')) {
    const z = world.get(e, 'DigZone');
    if (!z.center) continue;
    if (z.vertices && z.vertices.length > 0) continue;   // 已有 → 跳过
    z.vertices = generateVertices(z, planet, reg.ore, hardnessMax);
    touched++;
  }
  if (touched > 0 || (planet && !planet.params.digZoneVertices)) syncDigZoneVertices(world, ctx);
  return touched;
}

// 把 world 里所有 DigZone 的顶点(挖机已改的 offset)同步到 planet.params.digZoneVertices。
// 单向数据流: world(DigZone 组件) → planet.params → terrain.js / worker 的 heightAt。
// 在 setDigZone 后 + commitTerrain 前(挖机改顶点后)调用, 让渲染看到顶点级下沉。
export function syncDigZoneVertices(world, ctx) {
  const planet = ctx.planet;
  if (!planet) return;
  const out = [];
  for (const e of world.query('DigZone')) {
    const z = world.get(e, 'DigZone');
    if (!z.center || !z.vertices || z.vertices.length === 0) continue;
    out.push({
      center: z.center,
      radius: z.radius,
      maxInfluence: (z.resolution || 0.005) * 1.5,
      vertices: z.vertices.map((v) => ({ dir: v.dir, offset: v.offset })),
    });
  }
  planet.params.digZoneVertices = out;
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
export function generateVertices(zone, planet, oreData, hardnessMax) {
  if (!zone || !zone.center) return [];
  const res = zone.resolution || 0.005;
  const c = zone.center;
  const [t1, t2] = perpBasis(c);
  const ringR = Math.ceil(zone.radius / res);
  const out = [];
  for (let q = -ringR; q <= ringR; q++) {
    for (let r = -ringR; r <= ringR; r++) {
      // 六边形轴坐标裁剪: |q|, |r|, |q+r| 都 <= ringR
      if (Math.abs(q) > ringR || Math.abs(r) > ringR || Math.abs(q + r) > ringR) continue;
      // 轴坐标 -> 切平面偏移(pointy-top 六边形: x=√3·(r+q/2), y=3/2·q ... 这里用简化版即可)
      const ax = (r + q / 2) * Math.sqrt(3) * res;
      const ay = q * 1.5 * res;
      const dir = offsetOnCap(c, t1, t2, ax, ay);
      const ang = angle(dir, c);
      if (ang > zone.radius) continue;
      const baseH = planet && planet.baseHeightAt ? planet.baseHeightAt(dir[0], dir[1], dir[2]) : 0;
      // hardLimit: 该方向矿柱"最浅过硬层"的上沿; 全软则到矿柱底
      const col = oreColumn(dir, oreData);
      let cap = Infinity, bottom = 0;
      for (const l of col) {
        bottom = Math.max(bottom, l.d1);
        if ((l.hardness || 1) > hardnessMax) cap = Math.min(cap, l.d0);
      }
      out.push({
        dir, baseH, offset: 0, ownerId: null,
        hardLimit: Math.min(cap, bottom), lastItem: null,
      });
    }
  }
  return out;
}

// 圈定矿场挖掘区: 设中心方向 + 生成顶点网格 + 建/换该矿场的挖掘区地形坑 edit(向后兼容)
export function setDigZone(world, ctx, depotEid, centerDir) {
  const zone = world.get(depotEid, 'DigZone');
  if (!zone) return false;
  const c = [centerDir[0], centerDir[1], centerDir[2]];
  zone.center = c; zone.depth = 0;
  const planet = ctx.planet;
  const reg = ctx.registry;
  // 生成顶点网格(逐顶点挖掘的基础); hardnessMax 取 excavator_mk1 的(挖机能力上限)
  const hardnessMax = (reg.machineTypes.excavator_mk1 || {}).hardnessMax || 2;
  zone.vertices = generateVertices(zone, planet, reg.ore, hardnessMax);
  if (planet) {
    if (!ctx.zoneEdits) ctx.zoneEdits = new Map();
    const old = ctx.zoneEdits.get(depotEid);
    if (old) { const i = planet.params.edits.indexOf(old); if (i >= 0) planet.params.edits.splice(i, 1); }
    const sea = planet.params.seaLevel || 0;
    const h0 = planet.baseHeightAt ? planet.baseHeightAt(c[0], c[1], c[2]) : planet.heightAt(c[0], c[1], c[2]);
    const edit = { pos: c, radius: zone.radius, depth: 0, falloff: 'smooth', dry: h0 > sea };
    planet.params.edits.push(edit);
    ctx.zoneEdits.set(depotEid, edit);
    if (planet._buildNoise) planet._buildNoise();
    if (planet.roots) for (const r of planet.roots) planet._invalidateAffected(r, { x: c[0], y: c[1], z: c[2] }, zone.radius);
    planet._editPending = true;
    // 顶点表立即同步到 terrain 参数(让 heightAt 即时读到顶点网格)
    syncDigZoneVertices(world, ctx);
  }
  return true;
}

// 生成挖机(绑定到某矿场, 在其挖掘区/矿场附近散布)
export function spawnExcavators(world, ctx, n, depotEid, typeId = 'excavator_mk1') {
  const mt = ctx.registry.machineTypes[typeId] || {};
  const zone = world.get(depotEid, 'DigZone');
  const near = (zone && zone.center) ? zone.center : anchorDir(world, depotEid);
  const spread = (zone ? zone.radius : 0.05) * 1.2;
  const out = [];
  for (let i = 0; i < n; i++) {
    const dir = randInCap(near, spread);
    const e = world.create();
    world.add(e, 'Agent', { typeId, kind: 'excavator', mesh: mt.mesh || 'excavator' });
    world.add(e, 'Mover', { dir, fwd: tangentToward(dir, near), target: [...dir] });
    // 逐顶点挖机(B升级):
    //   digReach=挖掘臂角半径; digStep=单次目标降低量;
    //   targetVertex=当前锁定的 zone.vertices 索引; digProgress=该顶点累计挖量;
    //   searchCooldown=寻点冷却(避免每帧扫描所有顶点)
    world.add(e, 'Excavator', {
      typeId, depot: depotEid, state: 'idle',
      digPoint: null, reloc: 0, lastItem: null,        // 旧字段(legacy, 重写后逐步淘汰)
      digReach: mt.digReach || 0.025, digStep: mt.digStep || 0.02,
      targetVertex: null, digProgress: 0, searchCooldown: 0,
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
