// 建造 / 拆除 —— 把建筑数据组装成实体(组件),并处理挖机的地形坑 edit。
// 与渲染/UI 解耦: App 只需 pick 到方向 dir 后调 placeBuilding。

import { createBelt } from './belt.js';
import { midPortDir } from './inserter.js';

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
    // 矿场: 被动容器(自身不挖)。圈定挖掘区(DigZone.center)+挖机+采矿卡车后才有货进来。
    world.add(e, 'Depot', {});
    world.add(e, 'Inventory', { items: {}, cap: b.cap != null ? b.cap : Infinity });
    world.add(e, 'Provider', { items: '*' });   // 对外供应存储的一切
    world.add(e, 'DigZone', { center: null, radius: b.zoneRadius || 0.05, depth: 0 });
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
  }

  if (bus) bus.emit('build', { eid: e, buildingId });
  return e;
}

// 放置一条传送带(两点放置)。from/to 为球面单位方向; opts 透传给 createBelt(buildingId/outPort/inPort 等)。
// 返回带实体 id(失败返回 null, 例如科技未解锁)。
export function placeBelt(world, ctx, from, to, opts = {}) {
  const { registry } = ctx;
  const buildingId = opts.buildingId || 'belt';
  const b = registry.buildings[buildingId];
  if (b && b.locked && !(registry.isUnlocked && registry.isUnlocked(buildingId))) return null;
  return createBelt(world, ctx, from, to, { ...opts, buildingId });
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

// 拆除: 移除组件/实体, 回收其地形坑/挖掘区 edit 并失效该区域(地形恢复)
export function demolish(world, ctx, eid) {
  const { planet, spatial, bus } = ctx;
  const restore = (edit, map) => {
    if (!edit || !planet) return;
    const i = planet.params.edits.indexOf(edit);
    if (i >= 0) planet.params.edits.splice(i, 1);
    if (map) map.delete(eid);
    planet._buildNoise();
    for (const r of planet.roots) planet._invalidateAffected(r, { x: edit.pos[0], y: edit.pos[1], z: edit.pos[2] }, edit.radius);
    planet._editPending = true;
  };
  restore(ctx.minerEdits && ctx.minerEdits.get(eid), ctx.minerEdits);   // 旧直挖矿机的坑
  restore(ctx.zoneEdits && ctx.zoneEdits.get(eid), ctx.zoneEdits);       // 矿场挖掘区的坑
  if (spatial) spatial.remove(eid);
  world.destroy(eid);
  if (bus) bus.emit('demolish', { eid });
}
