// 物流系统(M2a: agent 卡车) —— 卡车在"有货的矿机"与"有空位的仓库"之间往返搬运。
//   idle → to_src(开往源) → load(装载) → to_sink(开往仓库) → unload(卸货) → idle
// 卡车把矿机腾空 → 矿机(之前满仓 state=full)下一 tick 恢复挖掘, 闭环流动。
// 统一到 Inventory 端口读写; 后续传送带/定制路线是同一目标的不同策略。

import { invTotal, invSpace, invTake, invAdd } from '../core/inventory.js';
import { moveToward, tangentToward, dot, randInCap } from '../core/sphere.js';

export function createLogisticsSystem(opts = {}) {
  const LOAD_RATE = opts.loadRate != null ? opts.loadRate : 200;   // 装/卸速率(数量/秒)

  return function logisticsSystem(world, dt, ctx) {
    const reg = ctx.registry;
    const R = ctx.planet ? ctx.planet.params.radius : 100;
    for (const e of world.query('Hauler', 'Mover')) {
      stepHauler(world, dt, ctx, e, reg, R, LOAD_RATE);
    }
  };
}

function nearestSource(world, dir) {
  let best = null, bd = -2;
  for (const e of world.query('Miner', 'Inventory', 'Anchor')) {
    if (invTotal(world.get(e, 'Inventory')) < 1) continue;
    const d = dot(dir, world.get(e, 'Anchor').dir);
    if (d > bd) { bd = d; best = e; }
  }
  return best;
}
function nearestSink(world, dir) {
  let best = null, bd = -2;
  for (const e of world.query('Storage', 'Inventory', 'Anchor')) {
    if (invSpace(world.get(e, 'Inventory')) < 1) continue;
    const d = dot(dir, world.get(e, 'Anchor').dir);
    if (d > bd) { bd = d; best = e; }
  }
  return best;
}
const anchorDir = (world, eid) => [...world.get(eid, 'Anchor').dir];

function stepHauler(world, dt, ctx, e, reg, R, loadRate) {
  const h = world.get(e, 'Hauler');
  const mv = world.get(e, 'Mover');
  const mt = reg.machineTypes[h.typeId] || {};
  const cap = h.cap || mt.cap || 100;
  const maxAng = ((mt.speed || 20) / R) * dt;

  switch (h.state) {
    case 'idle': {
      if (h.cargoAmt > 0) { const s = nearestSink(world, mv.dir); if (s == null) return; h.sink = s; mv.target = anchorDir(world, s); h.state = 'to_sink'; return; }
      const src = nearestSource(world, mv.dir), sink = nearestSink(world, mv.dir);
      if (src == null || sink == null) return;   // 无活可干, 原地待命
      h.source = src; h.sink = sink; mv.target = anchorDir(world, src); h.state = 'to_src';
      return;
    }
    case 'to_src': {
      if (h.source == null || !world.alive(h.source)) { h.state = 'idle'; return; }
      const r = moveToward(mv.dir, mv.target, maxAng); mv.dir = r.dir;
      if (r.arrived) h.state = 'load'; else mv.fwd = tangentToward(mv.dir, mv.target);
      return;
    }
    case 'load': {
      if (h.source == null || !world.alive(h.source)) { h.state = h.cargoAmt > 0 ? 'to_sink' : 'idle'; return; }
      const inv = world.get(h.source, 'Inventory');
      const room = cap - h.cargoAmt;
      if (room <= 1e-6) { h.state = 'to_sink'; mv.target = anchorDir(world, h.sink); return; }
      let item = h.cargoItem;
      if (!item || !(inv.items[item] > 0)) item = Object.keys(inv.items)[0];
      if (!item) {   // 源空了
        if (h.cargoAmt > 0) { h.state = 'to_sink'; mv.target = anchorDir(world, h.sink); } else h.state = 'idle';
        return;
      }
      const take = Math.min(loadRate * dt, room, inv.items[item]);
      h.cargoAmt += invTake(inv, item, take); h.cargoItem = item;
      if (h.cargoAmt >= cap - 1e-6) {
        if (h.sink == null || !world.alive(h.sink)) h.sink = nearestSink(world, mv.dir);
        if (h.sink != null) { mv.target = anchorDir(world, h.sink); h.state = 'to_sink'; } else h.state = 'idle';
      }
      return;
    }
    case 'to_sink': {
      if (h.sink == null || !world.alive(h.sink)) { const s = nearestSink(world, mv.dir); if (s == null) return; h.sink = s; mv.target = anchorDir(world, s); }
      const r = moveToward(mv.dir, mv.target, maxAng); mv.dir = r.dir;
      if (r.arrived) h.state = 'unload'; else mv.fwd = tangentToward(mv.dir, mv.target);
      return;
    }
    case 'unload': {
      if (h.sink == null || !world.alive(h.sink)) { h.state = 'idle'; return; }
      const inv = world.get(h.sink, 'Inventory');
      const space = invSpace(inv);
      if (space <= 1e-6) return;   // 仓满, 等
      const put = Math.min(loadRate * dt, h.cargoAmt, space);
      invAdd(inv, h.cargoItem, put); h.cargoAmt -= put;
      if (h.cargoAmt <= 1e-6) { h.cargoAmt = 0; h.cargoItem = null; h.state = 'idle'; }
      return;
    }
    default: h.state = 'idle';
  }
}

// 生成 n 辆卡车(在 nearDir 附近散布)
export function spawnHaulers(world, ctx, n, typeId = 'hauler_mk1', nearDir = [0, 1, 0]) {
  const mt = ctx.registry.machineTypes[typeId] || {};
  const out = [];
  for (let i = 0; i < n; i++) {
    const dir = randInCap(nearDir, 0.08);
    const e = world.create();
    world.add(e, 'Agent', { typeId, kind: 'hauler', mesh: mt.mesh || 'truck' });
    world.add(e, 'Mover', { dir, fwd: tangentToward(dir, nearDir), target: [...dir] });
    world.add(e, 'Hauler', { typeId, state: 'idle', cargoItem: null, cargoAmt: 0, cap: mt.cap || 100, source: null, sink: null });
    if (ctx.spatial) ctx.spatial.insert(e, dir);
    out.push(e);
  }
  if (ctx.bus) ctx.bus.emit('spawn', { kind: 'hauler', count: n });
  return out;
}
