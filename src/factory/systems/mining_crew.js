// 矿场采矿小队(挖机 + 采矿卡车) —— 替代"直挖矿机"的新采矿方式。
//   矿场(Depot): 被动容器, 自身不挖。需先"圈定挖掘区"(DigZone.zones[]), 再生成挖机 + 采矿卡车。
//   一个矿场可圈定**多个**挖掘区(每点一次"圈定挖掘区"加一个, 互不影响, 删除矿场前都保留)。
//   挖机(Excavator): 在矿场的任一挖掘区里"逐顶点"啃地形(B升级):
//       - 每台挖机有自己的 digReach(挖掘臂角半径), 只能挖到范围内的顶点;
//       - 一次只挖一个顶点(降低 zone.vertices[i].offset), 视觉上"一点点"下降;
//       - 策略: 以最低点为平面基准(planeH=min baseH), 把"高于基准"的顶点全部挖到基准 → 平整出平面;
//       - frontier 扩展: 从基准/动工区向外, 由低到高平整(不再东一个坑西一个坑, 也不挖成碗);
//       - 顶点 ownerId 互斥(挖机间不重叠); 顶点挖到 targetOffset(=baseH-planeH)即释放, 找下一个待平整点。
//   采矿卡车(MineTruck): 把挖机缓冲运进矿场库存。
//   下游: 矿场是 Provider, 物流卡车(logistics)从矿场取货送冶炼/仓库 —— 与旧矿机对下游一致。
//   永久变形: 顶点级变形(offset)同步到 planet.params.digZoneVertices 后, 即便 depot 被拆除,
//   对应条目仍按 zone id 永久保留(地形保持已挖出的坑, 不恢复)。
// 只有"圈定挖掘区 + 有挖机 + 有采矿卡车"三者齐备, 矿场才会进货。

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

// 在挖机 depot 的所有 zone 中找下一个目标。返回 { zoneIdx, vertexIdx } or null。
// 策略(B5+ 平整版): 把"高于基准平面 planeH"的顶点全部挖到 planeH, 形成平整平面(不再挖成坑/碗)。
//   - 顶点的 targetOffset = baseH - planeH(clamp 到 hardLimit); offset < targetOffset 即"还有工作"
//   - 选目标: 范围内 + 未被他人锁 + 还有工作量(offset < targetOffset) + 紧邻"已动工/已到位"顶点(frontier)
//   - 在 frontier 中选 baseH 最低的(从基准向外、由低到高平整)
//   - R3 仅 ang <= reach; R6 互斥 ownerId; 已到位(offset>=targetOffset)跳过
//   - 兜底: 范围内无 frontier(挖机离动工区太远)时, 退化到任意有工作量的顶点(最低 baseH 优先)
// 跨 zone 选择: 在所有 zone 的候选中选 baseH 最低的(挖机顺势去最近的低处开工)。
function findNextVertex(zones, fromDir, reach, selfEid) {
  // 第一轮: frontier 候选(每个 zone 自己有 anchor → 该 zone 内的 frontier 顶点)
  let bestZone = -1, bestIdx = -1, bestH = Infinity;
  for (let zi = 0; zi < zones.length; zi++) {
    const vs = zones[zi].vertices;
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
      if (v.baseH < bestH) { bestH = v.baseH; bestZone = zi; bestIdx = i; }
    }
  }
  if (bestIdx >= 0) return { zoneIdx: bestZone, vertexIdx: bestIdx };

  // 第二轮(兜底): 任意有工作量的顶点, baseH 最低优先
  bestZone = -1; bestIdx = -1; bestH = Infinity;
  for (let zi = 0; zi < zones.length; zi++) {
    const vs = zones[zi].vertices;
    if (!vs || vs.length === 0) continue;
    for (let i = 0; i < vs.length; i++) {
      const v = vs[i];
      if (v.ownerId != null && v.ownerId !== selfEid) continue;
      if (v.offset >= v.targetOffset - 1e-6) continue;
      const ang = angle(fromDir, v.dir);
      if (ang > reach) continue;
      if (v.baseH < bestH) { bestH = v.baseH; bestZone = zi; bestIdx = i; }
    }
  }
  return bestIdx >= 0 ? { zoneIdx: bestZone, vertexIdx: bestIdx } : null;
}

// 释放挖机对当前顶点的锁定(ownerId=null, targetZone/Vertex=null)
function releaseVertex(zone, ex, eid) {
  if (ex.targetVertex == null) return;
  const v = zone.vertices[ex.targetVertex];
  if (v && v.ownerId === eid) v.ownerId = null;
  ex.targetVertex = null;
  ex.targetZone = null;
  ex.digProgress = 0;
}

// 挖机(逐顶点版): 在矿场任一挖掘区里"找下一个待平整顶点 → 移过去 → 啃到 planeH → 释放 → 找下一个"。
// 状态机: idle(寻点冷却) → moving → digging → idle(平整完一个找下一个)/ full(满仓)
// 返回是否改动了地形(顶点 offset 变了 → 需提交)。
function stepExcavator(world, dt, ctx, e, reg, R) {
  const ex = world.get(e, 'Excavator');
  const inv = world.get(e, 'Inventory');
  const mv = world.get(e, 'Mover');
  if (ex.depot == null || !world.alive(ex.depot)) { ex.state = 'idle'; return false; }
  const dz = world.get(ex.depot, 'DigZone');
  const zones = dz && dz.zones;
  if (!zones || zones.length === 0) { ex.state = 'idle'; return false; }
  const mt = reg.machineTypes[ex.typeId] || {};
  const cap = inv.cap == null ? Infinity : inv.cap;

  // 满仓 → 释放锁定 + 等卡车
  if (invTotal(inv) >= cap) {
    if (ex.targetVertex != null && zones[ex.targetZone]) releaseVertex(zones[ex.targetZone], ex, e);
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
    const zone = zones[pick.zoneIdx];
    const v = zone.vertices[pick.vertexIdx];
    v.ownerId = e;             // 锁定(R6 互斥)
    ex.targetZone = pick.zoneIdx;
    ex.targetVertex = pick.vertexIdx;
    ex.digProgress = 0;
    mv.target = [...v.dir];
    ex.state = 'moving';
    // 不 return: 本帧继续尝试移动
  }

  const zone = zones[ex.targetZone];
  // 防御: zone 在跨 tick 期间被外部删除
  if (!zone) { ex.targetZone = null; ex.targetVertex = null; ex.state = 'idle'; return false; }
  const v = zone.vertices[ex.targetVertex];

  // 防御: 顶点已挖到平整目标(可能跨 tick 期间被外部改动)
  if (v.offset >= v.targetOffset - 1e-6) {
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
  const dd = Math.min((mt.digRate || 0.05) * dt, v.targetOffset - v.offset);
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
  // 挖到目标平面 → 释放, 下次 tick 寻下一个待平整顶点(R5 找下一个)
  if (v.offset >= v.targetOffset - 1e-6) {
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

// 存档迁移: world.load 后:
//   (a) 旧版 DigZone 是单 zone 形状{center, vertices, ...} → 转成新版 { zones: [...] };
//   (b) 旧版 zone 的 vertices 没生成(本特性之前) 或 pre-plane 格式(无 targetOffset) → 重生顶点;
//   (c) planet 不入 world 存档 → load 后 digZoneVertices 是空的, 同步刷新。
// 幂等: 已是新格式且 vertices 完整的跳过。
export function migrateDigZones(world, ctx) {
  const planet = ctx.planet;
  const reg = ctx.registry;
  const hardnessMax = (reg.machineTypes.excavator_mk1 || {}).hardnessMax || 2;
  let touched = 0;
  for (const e of world.query('DigZone')) {
    const dz = world.get(e, 'DigZone');
    // (a) 旧格式(单 zone): center/vertices 在 dz 顶层 → 包成 zones 数组
    if (dz.center != null || (dz.vertices && !dz.zones)) {
      const legacy = {
        center: dz.center,
        radius: dz.radius != null ? dz.radius : (dz._defRadius || 0.05),
        resolution: dz.resolution != null ? dz.resolution : (dz._defResolution || 0.005),
        planeH: dz.planeH || 0,
        depth: dz.depth || 0,
        vertices: dz.vertices,
      };
      dz.zones = [legacy];
      delete dz.center; delete dz.vertices; delete dz.planeH; delete dz.depth;
      touched++;
    }
    if (!dz.zones) continue;
    for (const z of dz.zones) {
      if (!z.center) continue;
      const needs = !z.vertices || z.vertices.length === 0
        || z.vertices[0].targetOffset == null
        || z.id == null;   // 缺 id 也要补(永久变形靠 id 索引)
      if (!needs) continue;
      if (z.id == null) z.id = _nextZoneId++;
      z.vertices = generateVertices(z, planet, reg.ore, hardnessMax);
      touched++;
    }
  }
  if (touched > 0 || (planet && !planet.params.digZoneVertices)) syncDigZoneVertices(world, ctx);
  return touched;
}

// 把 world 里所有 DigZone 的顶点(挖机已改的 offset)同步到 planet.params.digZoneVertices。
// 单向数据流: world(DigZone.zones) → planet.params → terrain.js / worker 的 heightAt。
// 永久变形语义: planet.params.digZoneVertices 是**按 zone id 索引、只增不删**的列表。
//   - 活跃 zone(在 world 里)→ 按 id 找/建条目, 原地更新 offsets;
//   - 孤儿 zone(depot 已拆除, 不在 world 里)→ 条目保留, 不再更新, 永久留在地形上。
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
    if (!dz || !dz.zones) continue;
    for (const z of dz.zones) {
      if (!z.center || !z.vertices || z.vertices.length === 0) continue;
      if (z.id == null) z.id = _nextZoneId++;
      let entry = byId.get(z.id);
      if (!entry) {
        entry = {
          id: z.id,
          center: z.center,
          radius: z.radius,
          maxInfluence: (z.resolution || 0.005) * 1.5,
          vertices: z.vertices.map((v) => ({ dir: v.dir, offset: v.offset })),
        };
        list.push(entry);
        byId.set(z.id, entry);
      } else {
        // 原地更新 offsets(顶点表长度在 generateVertices 后稳定, 直接索引覆盖)
        const ev = entry.vertices;
        if (ev.length !== z.vertices.length) {
          // 长度不一致(可能 resolution 变了)→ 重建整张表
          entry.center = z.center; entry.radius = z.radius;
          entry.maxInfluence = (z.resolution || 0.005) * 1.5;
          entry.vertices = z.vertices.map((v) => ({ dir: v.dir, offset: v.offset }));
        } else {
          for (let i = 0; i < ev.length; i++) ev[i].offset = z.vertices[i].offset;
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
      qrToIdx.set(`${q},${r}`, out.length);
      out.push({
        dir, baseH, offset: 0, ownerId: null,
        hardLimit: Math.min(cap, bottom), lastItem: null,
        targetOffset: 0,                       // 临时占位, 平面基准算完即填
        neighbors: [], _qr: [q, r],            // _qr 临时, 邻居算完即删
      });
    }
  }
  // 六边形 6 邻居(轴向): E/W, NE/SW 翻转看坐标系, 这里是 pointy-top 的 6 向
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
  // 挖机把所有"高于基准"的顶点挖到基准 → 平整出平面(planeH)。最低点天然在基准上(targetOffset=0)。
  recomputePlaneImpl(zone, out);
  return out;
}

// 内部实现: 给定 zone + 顶点数组, 计算平面基准和每个顶点的 targetOffset。
// 导出版(recomputePlane)供测试在改完 baseH 后重算。
function recomputePlaneImpl(zone, vertices) {
  if (!vertices || vertices.length === 0) return;
  let planeH = Infinity;
  for (const v of vertices) if (v.baseH < planeH) planeH = v.baseH;
  zone.planeH = planeH;
  for (const v of vertices) {
    v.targetOffset = Math.min(Math.max(0, v.baseH - planeH), v.hardLimit);
  }
}

// 公开: 手动改完顶点 baseH/hardLimit 后, 重新计算 planeH 和每顶点 targetOffset。
// 正常玩法里 baseH 不变(只在 setDigZone 时算一次), 此函数主要给测试用。
export function recomputePlane(zone) {
  recomputePlaneImpl(zone, zone.vertices);
}

// 圈定矿场挖掘区: 加一个**新**zone 到该矿场的 zones 列表(已圈的 zone 保留)。
//   - 每点一次"圈定挖掘区"加一个独立 zone, 互不影响;
//   - 删除矿场(或显式 removeDigZone)前, 已圈的 zone 永久保留;
//   - 即便删除, 该 zone 在 planet.params.digZoneVertices 里的顶点变形仍按 id 永久保留(永久变形)。
// 参数 centerDir: 球面方向(不需要归一, 函数内归一)。
export function setDigZone(world, ctx, depotEid, centerDir) {
  let dz = world.get(depotEid, 'DigZone');
  if (!dz) {
    dz = { zones: null };
    world.add(depotEid, 'DigZone', dz);
  }
  if (!dz.zones) dz.zones = [];
  const c = norm([centerDir[0], centerDir[1], centerDir[2]]);
  const planet = ctx.planet;
  const reg = ctx.registry;
  // 半径/分辨率: 用 depot 默认(placement.js 写在 _defRadius/_defResolution), 否则 building 表里取
  const depotB = reg.buildings.depot || {};
  const radius = dz._defRadius != null ? dz._defRadius : (depotB.zoneRadius || 0.05);
  const resolution = dz._defResolution != null ? dz._defResolution : (depotB.digResolution || 0.005);
  // 生成顶点网格(逐顶点挖掘的基础); hardnessMax 取 excavator_mk1 的(挖机能力上限)
  const hardnessMax = (reg.machineTypes.excavator_mk1 || {}).hardnessMax || 2;
  const z = {
    id: _nextZoneId++,
    center: [c[0], c[1], c[2]],
    radius, resolution,
    planeH: 0, depth: 0, vertices: null,
  };
  z.vertices = generateVertices(z, planet, reg.ore, hardnessMax);
  dz.zones.push(z);

  if (planet) {
    // 注: 旧版"圆形 edit"(depth=0, 无视觉影响)仍保留, 用于地形失效/invalidate 触发重生成。
    // 每个圈定都触发一次失效, 让 chunks 重生成 → 读到顶点级变形。
    if (!ctx.zoneEdits) ctx.zoneEdits = new Map();
    const edit = { pos: [c[0], c[1], c[2]], radius, depth: 0, falloff: 'smooth', dry: true };
    planet.params.edits.push(edit);
    ctx.zoneEdits.set(depotEid + ':' + z.id, edit);
    if (planet._buildNoise) planet._buildNoise();
    if (planet.roots) for (const r of planet.roots) planet._invalidateAffected(r, { x: c[0], y: c[1], z: c[2] }, radius);
    planet._editPending = true;
    syncDigZoneVertices(world, ctx);
  }
  return true;
}

// 删除矿场指定 zone(按 zone id)。不传 zoneId 则删第一个。地形变形永久保留(仅停止 AI 在该 zone 工作)。
export function removeDigZone(world, ctx, depotEid, zoneId) {
  const dz = world.get(depotEid, 'DigZone');
  if (!dz || !dz.zones || dz.zones.length === 0) return false;
  const idx = zoneId != null ? dz.zones.findIndex((z) => z.id === zoneId) : 0;
  if (idx < 0) return false;
  // 释放可能锁定该 zone 顶点的挖机
  for (const e of world.query('Excavator')) {
    const ex = world.get(e, 'Excavator');
    if (ex.depot !== depotEid) continue;
    if (ex.targetZone === idx) { ex.targetZone = null; ex.targetVertex = null; ex.state = 'idle'; }
    else if (ex.targetZone != null && ex.targetZone > idx) ex.targetZone--;   // 索引回填
  }
  dz.zones.splice(idx, 1);
  // 不清 planet.params.digZoneVertices 中对应 id 的条目(永久变形)
  syncDigZoneVertices(world, ctx);
  return true;
}

// 生成挖机(绑定到某矿场, 在其挖掘区/矿场附近散布)
export function spawnExcavators(world, ctx, n, depotEid, typeId = 'excavator_mk1') {
  const mt = ctx.registry.machineTypes[typeId] || {};
  const dz = world.get(depotEid, 'DigZone');
  const firstZone = dz && dz.zones && dz.zones[0];
  const near = firstZone ? firstZone.center : anchorDir(world, depotEid);
  const spread = (firstZone ? firstZone.radius : 0.05) * 1.2;
  const out = [];
  for (let i = 0; i < n; i++) {
    const dir = randInCap(near, spread);
    const e = world.create();
    world.add(e, 'Agent', { typeId, kind: 'excavator', mesh: mt.mesh || 'excavator' });
    world.add(e, 'Mover', { dir, fwd: tangentToward(dir, near), target: [...dir] });
    // 逐顶点挖机(B升级):
    //   digReach=挖掘臂角半径; digStep=单次目标降低量;
    //   targetZone/targetVertex=当前锁定的 zone.vertices 索引; digProgress=该顶点累计挖量;
    //   searchCooldown=寻点冷却(避免每帧扫描所有顶点)
    world.add(e, 'Excavator', {
      typeId, depot: depotEid, state: 'idle',
      digPoint: null, reloc: 0, lastItem: null,        // 旧字段(legacy, 重写后逐步淘汰)
      digReach: mt.digReach || 0.025, digStep: mt.digStep || 0.02,
      targetZone: null, targetVertex: null, digProgress: 0, searchCooldown: 0,
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
