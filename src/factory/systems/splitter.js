// 分流器(B3) —— 传送带的节点: N 条入带 + M 条出带, 把入带物品按策略分到出带。纯逻辑。
//
// 模型(见《物流升级》设计 C.3):
//   Splitter {
//     ins:[beltId...], outs:[beltId...],
//     mode: 'balance' | 'priority' | 'filter',
//     filters: { beltId: [items] },   filter 模式各出带只接受的物品(无条目=通吃/兜底)
//     rate,                           每秒路由个数
//     rr,                             balance 出带轮询指针
//     rrIn,                           入带轮询指针(合流公平)
//     charge,                         速率累积器
//   }
//
// 从入带头(须到出口 s≈1)取一个物品, 按 mode 选一条有空位的出带压入其尾。
// 出带满 / 无匹配 → 该物品路由不出去 → 留在入带头(背压)。

import { beltPeekHead, beltTakeHead, beltAddItem, beltHasRoomAtTail } from './belt.js';

function hasRoom(world, beltId) {
  const b = world.get(beltId, 'Belt');
  return !!b && beltHasRoomAtTail(b);
}

// 为 item 选一条出带(返回 beltId 或 null)
function chooseOut(world, sp, item) {
  const outs = sp.outs || [];
  if (outs.length === 0) return null;

  if (sp.mode === 'priority') {
    for (const b of outs) if (hasRoom(world, b)) return b;   // 优先喂前面的出带
    return null;
  }

  if (sp.mode === 'filter') {
    const filters = sp.filters || {};
    for (const b of outs) {                                   // 先找"接受该物品"的过滤出带
      const f = filters[b];
      if (f && f.length && f.includes(item) && hasRoom(world, b)) return b;
    }
    for (const b of outs) {                                   // 再找无过滤(兜底)出带
      const f = filters[b];
      if ((!f || f.length === 0) && hasRoom(world, b)) return b;
    }
    return null;
  }

  // 默认 balance: 从 rr 起轮询, 找第一条有空位的出带
  const n = outs.length;
  const start = sp.rr || 0;
  for (let k = 0; k < n; k++) {
    const idx = (start + k) % n;
    if (hasRoom(world, outs[idx])) { sp.rr = (idx + 1) % n; return outs[idx]; }
  }
  return null;
}

// 一次路由: 从某条入带头取一个物品, 送到选中的出带。成功返回 true。
function routeOne(world, sp) {
  const ins = sp.ins || [];
  const ni = ins.length;
  if (ni === 0) return false;
  const start = sp.rrIn || 0;
  for (let k = 0; k < ni; k++) {
    const inIdx = (start + k) % ni;
    const inB = world.get(ins[inIdx], 'Belt');
    if (!inB) continue;
    const item = beltPeekHead(inB);        // 须已到出口
    if (!item) continue;
    const outId = chooseOut(world, sp, item);
    if (outId == null) continue;           // 暂时无处可去 → 换下一入带
    beltTakeHead(inB);
    beltAddItem(world.get(outId, 'Belt'), item);
    sp.rrIn = (inIdx + 1) % ni;            // 下次从下一入带开始(合流公平)
    return true;
  }
  return false;
}

// 单个分流器一帧
export function stepSplitter(world, dt, sp) {
  sp.charge = (sp.charge || 0) + (sp.rate || 8) * dt;
  while (sp.charge >= 1) {
    if (!routeOne(world, sp)) break;
    sp.charge -= 1;
  }
  if (sp.charge > 1) sp.charge = 1;
}

// 系统: 每 tick 处理所有分流器(应在 belt 系统之后跑)
export function createSplitterSystem() {
  return function splitterSystem(world, dt /*, ctx */) {
    for (const e of world.query('Splitter')) stepSplitter(world, dt, world.get(e, 'Splitter'));
  };
}
