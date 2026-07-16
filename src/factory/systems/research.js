// 科技/发展度系统(M5, 简化占位) —— 研究站消耗物资 → 提升殖民地"发展度(dev)"; 发展度到阈值解锁科技。
//   dev 是"科技水平"的简化度量(后续可换成小人满意度/人口驱动, 接口不变)。
//   研究站(Lab): 每 tick 消耗 input(如铁锭) → dev += 消耗量 × devPerUnit。原料由物流送达(Lab 是 Requester)。
//   科技(tech): require.dev 达标(+可选 builtAny) → 解锁 unlock.buildings/recipes(registry.unlocked), 广播 'tech'。
// 纯逻辑, 可 node 单测。colony 状态惰性挂在 ctx.colony(dev / researched)。

import { invTake } from '../core/inventory.js';

export function createResearchSystem() {
  return function researchSystem(world, dt, ctx) {
    const colony = ctx.colony || (ctx.colony = { dev: 0, researched: new Set() });
    if (!colony.researched) colony.researched = new Set();
    const reg = ctx.registry;

    // 研究站消耗原料 → 发展度
    for (const e of world.query('Lab', 'Inventory')) {
      const lab = world.get(e, 'Lab');
      const inv = world.get(e, 'Inventory');
      const pn = world.get(e, 'PowerNeed');
      const sat = pn ? (pn.sat != null ? pn.sat : 0) : 1;   // 若给研究站接了电则受供电影响
      const have = inv.items[lab.input] || 0;
      const want = lab.inRate * dt * sat;
      const take = Math.min(want, have);
      if (take > 1e-9) { invTake(inv, lab.input, take); colony.dev += take * lab.devPerUnit; lab.state = 'researching'; lab.rate = lab.inRate * sat; }
      else { lab.state = have > 0 ? 'idle' : 'starved'; lab.rate = 0; }
    }

    // 科技解锁检查
    const tech = reg.tech || {};
    for (const id in tech) {
      if (colony.researched.has(id)) continue;
      const t = tech[id];
      const req = t.require || {};
      if (req.dev != null && colony.dev < req.dev) continue;
      if (req.builtAny && !builtAny(world, req.builtAny)) continue;
      colony.researched.add(id);
      if (reg.unlock) { reg.unlock((t.unlock && t.unlock.buildings) || []); reg.unlock((t.unlock && t.unlock.recipes) || []); }
      if (ctx.bus) ctx.bus.emit('tech', { id, tech: t });
    }
  };
}

// 世界中是否存在 typeId ∈ ids 的已建建筑
function builtAny(world, ids) {
  for (const e of world.query('Building')) {
    if (ids.includes(world.get(e, 'Building').typeId)) return true;
  }
  return false;
}
