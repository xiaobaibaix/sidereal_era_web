// 库存工具 —— 建筑/agent 的 Inventory 组件是 { items: { id: amount }, cap }。纯 JS。

export function newInventory(cap) { return { items: {}, cap: cap == null ? Infinity : cap }; }
export function invTotal(inv) { let t = 0; const it = inv.items; for (const k in it) t += it[k]; return t; }
export function invSpace(inv) { return (inv.cap == null ? Infinity : inv.cap) - invTotal(inv); }
export function invAdd(inv, item, amt) { inv.items[item] = (inv.items[item] || 0) + amt; return inv.items[item]; }
export function invTake(inv, item, amt) {
  const have = inv.items[item] || 0;
  const take = Math.min(have, amt);
  const left = have - take;
  if (left <= 1e-9) delete inv.items[item]; else inv.items[item] = left;
  return take;
}
export function invHas(inv, item, amt) { return (inv.items[item] || 0) >= amt; }
