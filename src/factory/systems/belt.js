// 传送带(B0) —— 一段测地线弧上的单向 FIFO 物品流。纯逻辑, 零 three.js → 可 node 无头单测。
//
// 模型(见《物流升级》设计 C.1):
//   Belt {
//     from,to:[x,y,z]  两端球面单位方向; 弧为大圆
//     length           弧长(角, 弧度) → 决定容量
//     speed            物品前进速度(角/秒)
//     spacing          物品最小间距(角) → 防重叠 & 背压
//     cap              最多承载 = floor(length/spacing)
//     items:[{item,s}] 带上物品队列; s∈[0,1] 归一化位置(0=尾/入口, 1=头/出口)
//                      约定 items[0]=头(s 最大), items[last]=尾(s 最小)
//     inPort           信息位: 谁喂尾(分拣器/带), 逻辑上不强依赖
//     outPort          头部到达出口后投递的目标 Port(见 Port 抽象); null=无输出→堆积背压
//   }
//
// 每 tick:
//   1) 物品从头到尾依次前进 ds=speed·dt/length, 受前车 spacing 约束(背压), 头部封顶 s=1。
//   2) 头部到达出口(s≈1) → 尝试投递到 outPort; 投得掉则移除, 投不掉则堵在 s=1(背压)。
//
// 带的低层搬运(beltAddItem/beltPeekHead/beltTakeHead)供分拣器(B1)/分流器(B3)复用。

import { norm, angle } from '../core/sphere.js';
import { invSpace, invAdd } from '../core/inventory.js';

const EPS = 1e-9;

// 归一化间距(带内 s 单位); length 极小时退化为 1(整条带最多 1 个物品)
function spacingNorm(belt) {
  const L = belt.length || EPS;
  const sp = belt.spacing / L;
  return sp > 1 ? 1 : sp;
}

// 带上还能否在尾部(s=0)再放一个物品: 未满 且 现有尾物品已离开入口 spacing 以上
export function beltHasRoomAtTail(belt) {
  if (belt.items.length >= belt.cap) return false;
  const tail = belt.items[belt.items.length - 1];
  if (!tail) return true;
  return tail.s >= spacingNorm(belt) - EPS;
}

// 往带尾放一个物品(入口 s=0)。成功返回 true; 满/间距不足返回 false(上游背压)。
export function beltAddItem(belt, item) {
  if (!beltHasRoomAtTail(belt)) return false;
  belt.items.push({ item, s: 0 });
  return true;
}

// 头部物品(已到达出口 s≈1 才算可取); 无则 null。不移除。
export function beltPeekHead(belt) {
  const h = belt.items[0];
  return h && h.s >= 1 - 1e-6 ? h.item : null;
}

// 取走头部物品(须已到达出口)。成功返回 item; 否则 null。
export function beltTakeHead(belt) {
  const h = belt.items[0];
  if (h && h.s >= 1 - 1e-6) { belt.items.shift(); return h.item; }
  return null;
}

// ---- 中途抽取/投放(方案1): 让分拣器在带的任意 s 位置抓取/放置, 不限于头/尾 ----
const tapWindow = (belt, w) => (w != null ? w : Math.max(spacingNorm(belt), 0.06));

// 看 sPos 附近窗口内最近的物品(不移除); 无则 null。
export function beltTapPeek(belt, sPos, window) {
  const w = tapWindow(belt, window);
  let bi = -1, bd = Infinity;
  for (let i = 0; i < belt.items.length; i++) { const d = Math.abs(belt.items[i].s - sPos); if (d < w && d < bd) { bd = d; bi = i; } }
  return bi >= 0 ? belt.items[bi].item : null;
}
// 取走 sPos 附近最近的物品; 无则 null。
export function beltTapTake(belt, sPos, window) {
  const w = tapWindow(belt, window);
  let bi = -1, bd = Infinity;
  for (let i = 0; i < belt.items.length; i++) { const d = Math.abs(belt.items[i].s - sPos); if (d < w && d < bd) { bd = d; bi = i; } }
  if (bi < 0) return null;
  const it = belt.items[bi].item; belt.items.splice(bi, 1); return it;
}
// 在 sPos 处放一个物品(该处 spacing 内无物品且未满); 保持 items 按 s 降序。成功返回 true。
export function beltTapPut(belt, item, sPos) {
  const sp = spacingNorm(belt);
  const s = sPos < 0 ? 0 : sPos > 1 ? 1 : sPos;
  for (const it of belt.items) if (Math.abs(it.s - s) < sp) return false;
  if (belt.items.length >= belt.cap) return false;
  let idx = belt.items.length;
  for (let i = 0; i < belt.items.length; i++) { if (belt.items[i].s < s) { idx = i; break; } }
  belt.items.splice(idx, 0, { item, s });
  return true;
}

// 把头部物品投递到 outPort。返回是否投递成功。
//   outPort.kind==='inv':  写入实体 Inventory(role==='request' 时须该实体确有此需求)
//   outPort.kind==='belt': 压入目标带尾(带↔带直连)
//   null / 目标不可用:     失败 → 头部堆积(背压)
function deliverHead(world, port, item) {
  if (!port) return false;
  if (port.kind === 'inv') {
    const inv = world.get(port.eid, 'Inventory');
    if (!inv || invSpace(inv) < 1 - EPS) return false;
    if (port.role === 'request') {
      const req = world.get(port.eid, 'Requester');
      if (req && req.needs && !(req.needs[item] > 0)) return false;   // 不是它需要的
    }
    invAdd(inv, item, 1);
    return true;
  }
  if (port.kind === 'belt') {
    const tb = world.get(port.eid, 'Belt');
    if (!tb) return false;
    return beltAddItem(tb, item);
  }
  return false;
}

// 单条带前进一帧
export function stepBelt(world, dt, belt) {
  const L = belt.length || EPS;
  const sp = spacingNorm(belt);
  const dsMax = (belt.speed * dt) / L;
  const items = belt.items;

  // 从头到尾前进: 头封顶 1, 其余不越过前车 - spacing
  for (let i = 0; i < items.length; i++) {
    const limit = i === 0 ? 1 : items[i - 1].s - sp;
    let ns = items[i].s + dsMax;
    if (ns > limit) ns = limit;
    if (ns < 0) ns = 0;
    items[i].s = ns;
  }

  // 头部到出口 → 投递; 投得掉就移除, 下一个成为新头(下一帧继续前进)
  let guard = items.length;   // 防高速带一帧多投时的无限循环
  while (guard-- > 0 && items.length && items[0].s >= 1 - 1e-6) {
    if (deliverHead(world, belt.outPort, items[0].item)) items.shift();
    else break;   // 背压: 投不掉, 头堵在出口
  }
}

// 系统: 每 tick 推进所有带
export function createBeltSystem() {
  return function beltSystem(world, dt /*, ctx */) {
    for (const e of world.query('Belt')) stepBelt(world, dt, world.get(e, 'Belt'));
  };
}

// ---- 放置辅助 ----
// 放一条带: from→to 两端球面方向。opts: { buildingId, machine, speed, spacing, outPort, inPort }
export function createBelt(world, ctx, from, to, opts = {}) {
  const reg = ctx.registry;
  const machine = opts.machine || (reg.buildings[opts.buildingId || 'belt'] || {}).machine || 'belt_mk1';
  const mt = (reg.machineTypes && reg.machineTypes[machine]) || {};
  const speed = opts.speed != null ? opts.speed : (mt.speed != null ? mt.speed : 0.15);
  const spacing = opts.spacing != null ? opts.spacing : (mt.spacing != null ? mt.spacing : 0.006);
  const f = norm(from), t = norm(to);
  const length = Math.max(angle(f, t), 1e-4);
  const cap = Math.max(1, Math.floor(length / spacing));
  const mid = norm([f[0] + t[0], f[1] + t[1], f[2] + t[2]]);

  const e = world.create();
  world.add(e, 'Anchor', { dir: mid, yaw: 0 });                         // 中点锚(供空间索引/查看)
  world.add(e, 'Building', { typeId: opts.buildingId || 'belt', mesh: mt.mesh || 'belt' });
  world.add(e, 'Belt', {
    from: f, to: t, length, speed, spacing, cap,
    items: [], inPort: opts.inPort || null, outPort: opts.outPort || null,
  });
  if (ctx.spatial) ctx.spatial.insert(e, mid);
  if (ctx.bus) ctx.bus.emit('build', { eid: e, buildingId: opts.buildingId || 'belt' });
  return e;
}
