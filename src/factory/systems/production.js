// 生产系统(M3) —— 通用配方执行器。带 Producer + Inventory 的建筑按配方把输入变输出。
//   idle/starved → 输入齐 → 开工时消耗输入(占用) → working 按 time 推进 → 完成时产出到自身库存。
//   输出无空位 → output_full 停等(本项目配方都是"减重", 一般不会触发)。
// 电力(M4)接入后: progress 增量再乘供电满足率; 现在视为始终有电。

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
      const need = flattenStacks(recipe.in);
      const make = flattenStacks(recipe.out);

      if (p.progress <= 0) {                        // 待开工: 检查输入齐备
        if (!hasAll(inv, need)) { p.state = 'starved'; return; }
        for (const it in need) invTake(inv, it, need[it]);   // 消耗输入(占用)
        p.progress = 1e-9;
      }
      p.state = 'working';
      p.progress += dt;
      if (p.progress >= recipe.time) {              // 完成: 产出
        if (invSpace(inv) < sumVals(make) - 1e-9) { p.state = 'output_full'; p.progress = recipe.time; return; }  // 无空位, 等
        for (const it in make) invAdd(inv, it, make[it]);
        p.progress = 0;
      }
    });
  };
}
