// 分拣器 / 分拣臂(B1) —— 在相邻两端点间按 rate 搬运单个物品, 可选物品过滤(sorter)。纯逻辑。
//
// 模型(见《物流升级》设计 C.2):
//   Inserter {
//     from: Port,   取货端。inv:{kind:'inv',eid,role:'provide'|'any'} | belt:{kind:'belt',eid,role:'out'}
//     to:   Port,   放货端。inv:{kind:'inv',eid,role:'request'|'any'} | belt:{kind:'belt',eid,role:'in'}
//     rate,         每秒搬运个数
//     filter,       null=不过滤; [items]=sorter, 只搬这些物品
//     carry,        手上物品 id | null(放不下时握住 → 背压)
//     charge,       速率累积器: += rate·dt, 每满 1 触发一次搬运
//   }
//
// 语义靠 Port 抽象(core/port.js)统一: 从 Provider 只取其供应物、往 Requester 只放其需求物且不超缓冲、
// 从带取头(须到出口)、往带放尾(遵守 spacing/cap)。目标放不下 → 握在手里, 天然背压到上游。

import { portPeek, portTakeUnit, portPutUnit } from '../core/port.js';
import { norm } from '../core/sphere.js';

// 依 filter 选一个此刻可取的物品(不移除); 取不到返回 null。
function pickable(world, from, filter) {
  if (!filter || filter.length === 0) return portPeek(world, from, null);
  for (const it of filter) { const p = portPeek(world, from, it); if (p) return p; }
  return null;
}

// 单个分拣器一次搬运尝试; 成功(取到/放下)返回 true, 无货可取或放不下返回 false。
function doOneMove(world, ins) {
  if (ins.carry != null) {                                  // 手上有货 → 先放
    if (portPutUnit(world, ins.to, ins.carry)) { ins.carry = null; return true; }
    return false;                                           // 放不下 → 继续握着
  }
  const item = pickable(world, ins.from, ins.filter);
  if (item == null) return false;                           // 无可取物
  const got = portTakeUnit(world, ins.from, item);
  if (got == null) return false;
  if (!portPutUnit(world, ins.to, got)) ins.carry = got;    // 取到但放不下 → 握住
  return true;
}

// 单个分拣器一帧
export function stepInserter(world, dt, ins) {
  ins.charge = (ins.charge || 0) + (ins.rate || 1) * dt;
  while (ins.charge >= 1) {
    if (!doOneMove(world, ins)) break;                      // 停手(无货/背压), 保留余量
    ins.charge -= 1;
  }
  if (ins.charge > 1) ins.charge = 1;                       // 封顶: 阻塞时不无限累积, 疏通后至多补 1 次
}

// 系统。opts.phase:
//   'all'(默认)  处理全部分拣器
//   'load'       仅"往带上放"的分拣器(to 是 belt) —— 应在 belt 系统之前跑(上带)
//   'unload'     仅"不往带上放"的分拣器(to 非 belt) —— 应在 belt 系统之后跑(下带)
export function createInserterSystem(opts = {}) {
  const phase = opts.phase || 'all';
  return function inserterSystem(world, dt /*, ctx */) {
    for (const e of world.query('Inserter')) {
      const ins = world.get(e, 'Inserter');
      if (phase !== 'all') {
        const toBelt = ins.to && ins.to.kind === 'belt';
        if (phase === 'load' && !toBelt) continue;
        if (phase === 'unload' && toBelt) continue;
      }
      stepInserter(world, dt, ins);
    }
  };
}

// 一个 Port 的代表方向(用于分拣器锚点/空间索引)。带取相应端, 库存取其 Anchor。
export function portDir(world, port) {
  if (!port) return null;
  if (port.kind === 'belt') {
    const b = world.get(port.eid, 'Belt');
    if (!b) return null;
    return port.role === 'in' ? [...b.from] : [...b.to];   // in=尾, out/其他=头
  }
  const a = world.get(port.eid, 'Anchor');
  return a ? [...a.dir] : null;
}

// 两端方向的中点(球面), 供锚点; 任一缺失则退回另一端 / [0,1,0]。
export function midPortDir(world, from, to) {
  const a = portDir(world, from), b = portDir(world, to);
  if (a && b) return norm([a[0] + b[0], a[1] + b[1], a[2] + b[2]]);
  return a || b || [0, 1, 0];
}
