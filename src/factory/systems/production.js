// 生产系统(M3) —— 通用配方执行器。带 Producer + Inventory 的建筑按配方把输入变输出。
//   idle/starved → 输入齐 → 开工时消耗输入(占用) → working 按 time 推进 → 完成时产出到自身库存。
//   输出无空位 → output_full 停等(本项目配方都是"减重", 一般不会触发)。
// 电力(M4): 有 PowerNeed 组件时读 sat —— sat≤0 → no_power(不开工); 否则进度 += dt×sat(缺电降速)。
//   无 PowerNeed → 视为满电(向后兼容)。

import { invSpace, invAdd, invTake } from '../core/inventory.js';

// 把 [{a:1},{b:2}] 这种栈数组合并成 { a:1, b:2 }
export function flattenStacks(arr) {
  const out = {};
  for (const stack of arr || []) for (const item in stack) out[item] = (out[item] || 0) + stack[item];
  return out;
}
function hasAll(inv, need) { for (const it in need) if ((inv.items[it] || 0) < need[it] - 1e-9) return false; return true; }
function sumVals(o) { let s = 0; for (const k in o) s += o[k]; return s; }

export function createProductionSystem() {
  return function productionSystem(world, dt, ctx) {
    const reg = ctx.registry;
    world.each(['Producer', 'Inventory'], (e, p, inv) => {
      const recipe = reg.recipes[p.recipeId];
      if (!recipe) { p.state = 'idle'; return; }
      const pn = world.get(e, 'PowerNeed');
      const sat = pn ? (pn.sat != null ? pn.sat : 0) : 1;
      const need = flattenStacks(recipe.in);
      const make = flattenStacks(recipe.out);

      if (p.progress <= 0) {                        // 待开工: 先看电, 再看输入
        if (sat <= 1e-6) { p.state = 'no_power'; return; }   // 无电不开工(不占用输入)
        if (!hasAll(inv, need)) { p.state = 'starved'; return; }
        for (const it in need) invTake(inv, it, need[it]);   // 消耗输入(占用)
        p.progress = 1e-9;
      }
      if (sat <= 1e-6) { p.state = 'no_power'; return; }      // 开工后断电: 暂停(进度保留)
      p.state = 'working';
      p.progress += dt * sat;                       // 缺电降速
      if (p.progress >= recipe.time) {              // 完成: 产出
        if (invSpace(inv) < sumVals(make) - 1e-9) { p.state = 'output_full'; p.progress = recipe.time; return; }  // 无空位, 等
        for (const it in make) invAdd(inv, it, make[it]);
        p.progress = 0;
      }
    });
  };
}
