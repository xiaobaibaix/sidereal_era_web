// 采矿系统 —— 挖机驻扎在其锚点, 每 tick 把地形往下挖一点(长坑), 按挖穿的层产出物质到自身库存。
//   - 先挖表土(overburden), 挖到矿层才出矿;
//   - 层硬度 > 机种 hardnessMax → 挖不动(blocked, 需更高级钻机);
//   - 满仓 → 停挖等运输(M2 卡车)。
// 地形坑 = 每台挖机一条"受管理的 edit"(depth 随挖掘增长), 重建/失效做节流(每 ~0.15s 一次), 避免打爆 worker。

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
      const layer = layerAt(col, m.dugDepth);
      if (!layer) { m.state = 'idle'; return; }
      if ((layer.hardness || 1) > (mt.hardnessMax || 1)) { m.state = 'blocked'; return; }          // 太硬挖不动
      m.state = 'mining';
      const dd = (mt.digRate || 0.02) * dt;
      m.dugDepth += dd;
      m.lastItem = layer.item;
      invAdd(inv, layer.item, dd * (mt.yield || 100));
      const edit = ctx.minerEdits && ctx.minerEdits.get(e);
      if (edit) { edit.depth += dd; dirty = true; }
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
