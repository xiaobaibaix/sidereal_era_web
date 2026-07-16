// Port 抽象 —— 统一"从哪取 / 放到哪", 让分拣器/分流器/带解耦。纯逻辑, 零 three.js。
//
//   Port = { kind:'inv'|'belt', eid, role }
//     inv:  读写实体 Inventory。role='provide'(取货须遵守 Provider 供应表) |
//           'request'(放货须遵守 Requester 需求且不超缓冲) | 'any'(直取直放)
//     belt: 带的头(取)或尾(放)。role='out'(取头) | 'in'(放尾)
//
// 物品以"整单位(1 个)"为粒度搬运, 与带上离散物品一致; 库存不足 1 个则视作取不到。

import { invSpace, invAdd, invTake } from './inventory.js';
import { beltPeekHead, beltTakeHead, beltAddItem, beltHasRoomAtTail } from '../systems/belt.js';

const EPS = 1e-9;

function offers(pr, it) { return pr.items === '*' || (Array.isArray(pr.items) && pr.items.includes(it)); }

// 该端此刻可被取走的物品(不移除)。want 指定则只认该物品; 取不到返回 null。
export function portPeek(world, port, want = null) {
  if (!port) return null;
  if (port.kind === 'belt') {
    const b = world.get(port.eid, 'Belt'); if (!b) return null;
    const it = beltPeekHead(b);
    if (!it) return null;
    return (!want || it === want) ? it : null;
  }
  const inv = world.get(port.eid, 'Inventory'); if (!inv) return null;
  const pr = port.role === 'provide' ? world.get(port.eid, 'Provider') : null;
  const pick = (it) => (inv.items[it] || 0) >= 1 - EPS && (!pr || offers(pr, it));
  if (want) return pick(want) ? want : null;
  for (const it in inv.items) if (pick(it)) return it;
  return null;
}

// 取走 1 个整单位; 返回物品 id 或 null。
export function portTakeUnit(world, port, want = null) {
  if (!port) return null;
  if (port.kind === 'belt') {
    const b = world.get(port.eid, 'Belt'); if (!b) return null;
    const it = beltPeekHead(b);
    if (!it || (want && it !== want)) return null;
    return beltTakeHead(b);
  }
  const it = portPeek(world, port, want);
  if (!it) return null;
  invTake(world.get(port.eid, 'Inventory'), it, 1);
  return it;
}

// 该端此刻能否再接收 1 个 item。
export function portCanPut(world, port, item) {
  if (!port) return false;
  if (port.kind === 'belt') {
    const b = world.get(port.eid, 'Belt');
    return !!b && beltHasRoomAtTail(b);
  }
  const inv = world.get(port.eid, 'Inventory'); if (!inv) return false;
  if (invSpace(inv) < 1 - EPS) return false;
  if (port.role === 'request') {
    const req = world.get(port.eid, 'Requester');
    if (req && req.needs) {
      const target = req.needs[item] || 0;
      if (target <= 0) return false;                              // 不是它需要的
      if ((inv.items[item] || 0) >= target - EPS) return false;   // 缓冲已满 → 背压
    }
  }
  return true;
}

// 放入 1 个整单位; 返回是否成功。
export function portPutUnit(world, port, item) {
  if (!portCanPut(world, port, item)) return false;
  if (port.kind === 'belt') return beltAddItem(world.get(port.eid, 'Belt'), item);
  invAdd(world.get(port.eid, 'Inventory'), item, 1);
  return true;
}
