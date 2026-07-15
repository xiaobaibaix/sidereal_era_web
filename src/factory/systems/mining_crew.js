// 矿场采矿小队(挖机 + 采矿卡车) —— 替代"直挖矿机"的新采矿方式。
//   矿场(Depot): 被动容器, 自身不挖。需先"圈定挖掘区"(DigZone.center), 再生成挖机 + 采矿卡车。
//   挖机(Excavator): 在矿场挖掘区里啃地形(区域整体下挖 zone.depth), 按当前矿层把矿产进"自身缓冲";
//                    满仓则停等卡车; 在区内小范围换点(啃宽矿坑)。挖到过硬层后持续产最深可挖层(不枯竭)。
//   采矿卡车(MineTruck): 把挖机缓冲运进矿场库存。
//   下游: 矿场是 Provider, 物流卡车(logistics)从矿场取货送冶炼/仓库 —— 与旧矿机对下游一致。
// 只有"圈定挖掘区 + 有挖机 + 有采矿卡车"三者齐备, 矿场才会进货。

import { oreColumn, layerAt } from '../ore.js';
import { invTotal, invAdd, invTake, invSpace } from '../core/inventory.js';
import { moveToward, tangentToward, dot, randInCap } from '../core/sphere.js';

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
      if (timer >= COMMIT_EVERY) { commitTerrain(planet, ctx); timer = 0; dirty = false; }
    }
  };
}

// 挖机: 在挖掘区里挖 → 产矿到自身缓冲。返回是否改动了地形(需提交)。
function stepExcavator(world, dt, ctx, e, reg, R) {
  const ex = world.get(e, 'Excavator');
  const inv = world.get(e, 'Inventory');
  const mv = world.get(e, 'Mover');
  if (ex.depot == null || !world.alive(ex.depot)) { ex.state = 'idle'; return false; }
  const zone = world.get(ex.depot, 'DigZone');
  if (!zone || !zone.center) { ex.state = 'idle'; return false; }   // 未圈定挖掘区 → 无事可做
  const mt = reg.machineTypes[ex.typeId] || {};
  const cap = inv.cap == null ? Infinity : inv.cap;
  if (invTotal(inv) >= cap) { ex.state = 'full'; return false; }    // 满仓等卡车

  if (!ex.digPoint) {   // 领一个区内挖点, 开过去
    ex.digPoint = randInCap(zone.center, zone.radius * 0.7);
    ex.reloc = 2.5 + Math.random() * 2.5;
    mv.target = [...ex.digPoint];
    ex.state = 'to_zone';
  }
  const maxAng = ((mt.speed || 16) / R) * dt;
  if (ex.state === 'to_zone') {
    const r = moveToward(mv.dir, mv.target, maxAng); mv.dir = r.dir;
    if (!r.arrived) { mv.fwd = tangentToward(mv.dir, mv.target); return false; }
    ex.state = 'digging';
  }

  // 挖掘: 推进挖掘区整体深度 zone.depth, 按当前层产矿到缓冲(逻辑同直挖矿机的可持续开采)
  ex.state = 'digging';
  ex.reloc -= dt;
  const col = oreColumn(zone.center, reg.ore);
  const maxH = mt.hardnessMax || 1;
  let capDepth = Infinity, bottom = 0;
  for (const l of col) { bottom = Math.max(bottom, l.d1); if ((l.hardness || 1) > maxH) capDepth = Math.min(capDepth, l.d0); }
  capDepth = Math.min(capDepth, bottom);
  if (!(capDepth > 0)) { ex.state = 'idle'; return false; }
  const yieldPer = mt.yield || 100;
  let changed = false;
  if (zone.depth < capDepth - 1e-9) {
    const dd = Math.min((mt.digRate || 0.05) * dt, capDepth - zone.depth);
    const layer = layerAt(col, zone.depth);
    zone.depth += dd;
    invAdd(inv, layer.item, dd * yieldPer);
    ex.lastItem = layer.item;
    const edit = ctx.zoneEdits && ctx.zoneEdits.get(ex.depot);
    if (edit) { edit.depth = zone.depth; changed = true; }
  } else {
    const face = layerAt(col, capDepth - 1e-4);   // 已到极限深度: 持续产最深可挖层
    if (face && (face.hardness || 1) <= maxH) { invAdd(inv, face.item, (mt.digRate || 0.05) * yieldPer * dt); ex.lastItem = face.item; }
    else ex.state = 'idle';
  }
  if (ex.reloc <= 0) ex.digPoint = null;   // 换点(区内推进作业面)
  return changed;
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

// 圈定矿场挖掘区: 设中心方向 + 建/换该矿场的挖掘区地形坑 edit(深度随挖掘增长)
export function setDigZone(world, ctx, depotEid, centerDir) {
  const zone = world.get(depotEid, 'DigZone');
  if (!zone) return false;
  const c = [centerDir[0], centerDir[1], centerDir[2]];
  zone.center = c; zone.depth = 0;
  const planet = ctx.planet;
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
    world.add(e, 'Excavator', { typeId, depot: depotEid, state: 'idle', digPoint: null, reloc: 0, lastItem: null });
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
