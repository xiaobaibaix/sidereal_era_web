// 采矿系统 —— 挖机驻扎在其锚点, 每 tick 把地形往下挖一点(长坑), 按挖穿的层产出物质到自身库存。
//   - 先挖表土(overburden), 挖到矿层才出矿;
//   - 挖到"过硬层"(hardness > 机种 hardnessMax): 不再加深, 而是"啃宽矿坑"——停在极限深度持续产出上一可挖层的矿(可持续, 不枯竭);
//     只有连极限深度上一层都挖不动才 blocked(几乎不会发生)。
//   - 满仓 → 停挖等运输(M2 卡车), 被搬空后恢复。
// 地形坑 = 每台挖机一条"受管理的 edit"(depth 随挖掘增长, 到极限后不再变深), 重建/失效做节流(每 ~0.15s 一次), 避免打爆 worker。

import { oreColumn, layerAt } from '../ore.js';
import { invTotal, invAdd } from '../core/inventory.js';

export function createMiningSystem(opts = {}) {
  const COMMIT_EVERY = opts.commitEvery != null ? opts.commitEvery : 0.15;
  let timer = 0, dirty = false;

  return function miningSystem(world, dt, ctx) {
    const planet = ctx.planet, reg = ctx.registry;
    if (!planet) return;
    const oreData = reg.ore;

    world.each(['Miner', 'Anchor', 'Inventory'], (e, m, a, inv) => {
      const mt = reg.machineTypes[m.typeId];
      if (!mt) return;
      if (invTotal(inv) >= (inv.cap == null ? Infinity : inv.cap)) { m.state = 'full'; return; }  // 满仓等运输
      const col = oreColumn(a.dir, oreData);
      const maxH = mt.hardnessMax || 1;
      const rate = (mt.digRate || 0.02) * dt;             // 本 tick 可挖进的深度
      const yps = (mt.digRate || 0.02) * (mt.yield || 100); // 每秒产出量(持续开采用)

      // 可挖极限深度 = 最浅的"过硬层"上沿(挖不动的地方); 也不超过矿柱底
      let capDepth = Infinity, bottom = 0;
      for (const l of col) {
        bottom = Math.max(bottom, l.d1);
        if ((l.hardness || 1) > maxH) capDepth = Math.min(capDepth, l.d0);
      }
      capDepth = Math.min(capDepth, bottom);
      if (!(capDepth > 0)) { m.state = 'blocked'; return; }   // 表层就挖不动(极罕见)

      if (m.dugDepth < capDepth - 1e-9) {
        // 正常下挖: 加深坑(不越过极限深度), 按当前层产出
        const dd = Math.min(rate, capDepth - m.dugDepth);
        const layer = layerAt(col, m.dugDepth);
        m.state = 'mining';
        m.dugDepth += dd;
        m.lastItem = layer.item;
        invAdd(inv, layer.item, dd * (mt.yield || 100));
        const edit = ctx.minerEdits && ctx.minerEdits.get(e);
        if (edit) { edit.depth += dd; dirty = true; }
      } else {
        // 已到极限深度: "啃宽矿坑"持续产出最深可挖层的矿(可持续, 坑不再加深)
        const face = layerAt(col, capDepth - 1e-4);
        if (face && (face.hardness || 1) <= maxH) {
          m.state = 'mining';
          m.lastItem = face.item;
          invAdd(inv, face.item, yps * dt);
        } else {
          m.state = 'blocked';   // 需更高级钻机
        }
      }
    });

    if (dirty) {
      timer += dt;
      if (timer >= COMMIT_EVERY) { commitTerrain(planet, ctx); timer = 0; dirty = false; }
    }
  };
}

// 重建地形闭包 + 失效各矿机坑区域 → 坑随挖掘可见地变深
function commitTerrain(planet, ctx) {
  planet._buildNoise();
  if (ctx.minerEdits) {
    for (const edit of ctx.minerEdits.values()) {
      const d = { x: edit.pos[0], y: edit.pos[1], z: edit.pos[2] };
      for (const r of planet.roots) planet._invalidateAffected(r, d, edit.radius);
    }
  }
  planet._editPending = true;
}
