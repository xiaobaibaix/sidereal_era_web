// 物流系统(M2a agent 卡车 + M3 需求驱动路由) —— 卡车按"供需匹配"在建筑间搬运物品。
//   idle → to_src(开往源) → load(装某物) → to_sink(开往目的) → unload(卸货) → idle
// 供需模型(数据驱动, 不写死机种):
//   Provider{items:'*'|[id...]}  该建筑愿意从库存对外供应这些物品(矿机=一切; 生产建筑=其产出)。
//   Requester{needs:{id:target}} 该建筑需要这些物品补到 target(生产建筑=配方输入缓冲)。
//   Storage{}                    通用终端仓, 接收任何物品(最低优先级, 供应链吃不下的余量归仓)。
// 派活优先级: 先喂"有货可取的需求方"(推动生产链), 再把供应方余量运进仓库。
// 后续传送带/定制路线是同一目标(把物品从源送到需求)的不同策略。

import { invSpace, invTake, invAdd } from '../core/inventory.js';
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

const anchorDir = (world, eid) => [...world.get(eid, 'Anchor').dir];

// 该 Provider 当前愿意供应且有存货的某个物品(可指定 want; 不指定则任取一个)
function offeredItem(pr, inv, want) {
  const offers = (it) => pr.items === '*' || (Array.isArray(pr.items) && pr.items.includes(it));
  if (want) return (offers(want) && (inv.items[want] || 0) > 1e-6) ? want : null;
  for (const it in inv.items) if (inv.items[it] > 1e-6 && offers(it)) return it;
  return null;
}

// 离 fromDir 最近、能供应 item 的 Provider
function nearestProviderWith(world, item, fromDir, exclude) {
  let best = null, bd = -2;
  for (const e of world.query('Provider', 'Inventory', 'Anchor')) {
    if (e === exclude) continue;
    const pr = world.get(e, 'Provider');
    const inv = world.get(e, 'Inventory');
    if (!offeredItem(pr, inv, item)) continue;
    const d = dot(fromDir, world.get(e, 'Anchor').dir);
    if (d > bd) { bd = d; best = e; }
  }
  return best;
}

// item 的目的地: 优先"仍需该物品且有空位的 Requester", 否则"有空位的 Storage"; 就近。
function sinkForItem(world, item, fromDir) {
  let best = null, bd = -2;
  for (const e of world.query('Requester', 'Inventory', 'Anchor')) {
    const req = world.get(e, 'Requester');
    const inv = world.get(e, 'Inventory');
    if (!(req.needs && req.needs[item] > 0)) continue;
    if ((inv.items[item] || 0) >= req.needs[item] - 1e-6) continue;
    if (invSpace(inv) <= 1e-6) continue;
    const d = dot(fromDir, world.get(e, 'Anchor').dir);
    if (d > bd) { bd = d; best = e; }
  }
  if (best != null) return best;
  for (const e of world.query('Storage', 'Inventory', 'Anchor')) {
    if (invSpace(world.get(e, 'Inventory')) <= 1e-6) continue;
    const d = dot(fromDir, world.get(e, 'Anchor').dir);
    if (d > bd) { bd = d; best = e; }
  }
  return best;
}

// 给空车找活: 先喂需求方(有货可取), 再把供应方余量送仓库。返回 { source, sink, item } | null
function findJob(world, fromDir) {
  // 1) 需求驱动: 某 Requester 缺某物 且 有 Provider 能供 → 送过去
  for (const R of world.query('Requester', 'Inventory', 'Anchor')) {
    const req = world.get(R, 'Requester');
    const rinv = world.get(R, 'Inventory');
    if (invSpace(rinv) <= 1e-6) continue;
    for (const item in req.needs) {
      if ((rinv.items[item] || 0) >= req.needs[item] - 1e-6) continue;
      const P = nearestProviderWith(world, item, fromDir, R);
      if (P != null) return { source: P, sink: R, item };
    }
  }
  // 2) 余量归仓: 供应方有货 且 有仓库(或仍缺货的需求方)可收
  for (const P of world.query('Provider', 'Inventory', 'Anchor')) {
    const pr = world.get(P, 'Provider');
    const pinv = world.get(P, 'Inventory');
    const item = offeredItem(pr, pinv);
    if (!item) continue;
    const S = sinkForItem(world, item, fromDir);
    if (S != null && S !== P) return { source: P, sink: S, item };
  }
  return null;
}

function stepHauler(world, dt, ctx, e, reg, R, loadRate) {
  const h = world.get(e, 'Hauler');
  const mv = world.get(e, 'Mover');
  const mt = reg.machineTypes[h.typeId] || {};
  const cap = h.cap || mt.cap || 100;
  const maxAng = ((mt.speed || 20) / R) * dt;

  switch (h.state) {
    case 'idle': {
      if (h.cargoAmt > 0) {   // 手里还有货 → 找目的地卸掉
        const s = sinkForItem(world, h.cargoItem, mv.dir);
        if (s == null) return;
        h.sink = s; h.item = h.cargoItem; mv.target = anchorDir(world, s); h.state = 'to_sink'; return;
      }
      const job = findJob(world, mv.dir);
      if (job == null) return;   // 无活可干, 原地待命
      h.source = job.source; h.sink = job.sink; h.item = job.item;
      mv.target = anchorDir(world, job.source); h.state = 'to_src';
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
      if (room <= 1e-6) { toSink(world, h, mv); return; }
      const avail = inv.items[h.item] || 0;
      if (avail <= 1e-6) {   // 源没这个物品了
        if (h.cargoAmt > 0) toSink(world, h, mv); else h.state = 'idle';
        return;
      }
      const take = Math.min(loadRate * dt, room, avail);
      h.cargoAmt += invTake(inv, h.item, take); h.cargoItem = h.item;
      if (h.cargoAmt >= cap - 1e-6) toSink(world, h, mv);
      return;
    }
    case 'to_sink': {
      if (h.sink == null || !world.alive(h.sink)) { const s = sinkForItem(world, h.cargoItem, mv.dir); if (s == null) return; h.sink = s; mv.target = anchorDir(world, s); }
      const r = moveToward(mv.dir, mv.target, maxAng); mv.dir = r.dir;
      if (r.arrived) h.state = 'unload'; else mv.fwd = tangentToward(mv.dir, mv.target);
      return;
    }
    case 'unload': {
      if (h.sink == null || !world.alive(h.sink)) { h.state = 'idle'; return; }
      const inv = world.get(h.sink, 'Inventory');
      const space = invSpace(inv);
      if (space <= 1e-6) return;   // 目的地满, 等
      const put = Math.min(loadRate * dt, h.cargoAmt, space);
      invAdd(inv, h.cargoItem, put); h.cargoAmt -= put;
      if (h.cargoAmt <= 1e-6) { h.cargoAmt = 0; h.cargoItem = null; h.item = null; h.state = 'idle'; }
      return;
    }
    default: h.state = 'idle';
  }
}

// 转入 to_sink: 为当前载货选目的地
function toSink(world, h, mv) {
  const item = h.cargoItem || h.item;
  const s = (h.sink != null && world.alive(h.sink)) ? h.sink : sinkForItem(world, item, mv.dir);
  if (s == null) { h.state = 'idle'; return; }
  h.sink = s; mv.target = anchorDir(world, s); h.state = 'to_sink';
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
    world.add(e, 'Hauler', { typeId, state: 'idle', item: null, cargoItem: null, cargoAmt: 0, cap: mt.cap || 100, source: null, sink: null });
    if (ctx.spatial) ctx.spatial.insert(e, dir);
    out.push(e);
  }
  if (ctx.bus) ctx.bus.emit('spawn', { kind: 'hauler', count: n });
  return out;
}
