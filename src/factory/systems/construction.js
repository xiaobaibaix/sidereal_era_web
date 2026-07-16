// 分阶段建造系统(M6) —— 行星发动机按 build-plan 逐阶段建成。
//   计时阶段(type: level/commission): prog += dt, 到 stage.time 进阶(选址平整 / 调试)。
//   投料阶段(type: build/assemble): 把送达自身库存的 in 物料吸收进 contributed, 并把 Requester.needs
//     设为"剩余待送量"(物流据此送料); 各物料齐备则进阶(骨架 / 核心)。
//   走完全部阶段 → done=built=true, 广播 'engine_built'(等待 M7 点火)。
// 纯逻辑, 可 node 单测。建材来源 = 现有生产链(物流把铁板等送到发动机)。

export function createConstructionSystem() {
  return function constructionSystem(world, dt, ctx) {
    const reg = ctx.registry;
    for (const e of world.query('Construction', 'Inventory')) {
      const proj = world.get(e, 'Construction');
      if (proj.done) continue;
      const b = reg.buildings[world.get(e, 'Building').typeId] || {};
      const stages = b.stages || [];
      if (proj.stage >= stages.length) { finish(proj, ctx, e); continue; }

      const st = stages[proj.stage];
      const inv = world.get(e, 'Inventory');
      const req = world.get(e, 'Requester');

      if (st.type === 'build' || st.type === 'assemble') {
        const need = st.in || {};
        let allDone = true;
        for (const it in need) {
          proj.contributed[it] = proj.contributed[it] || 0;
          const have = inv.items[it] || 0;
          if (have > 0) { proj.contributed[it] += have; delete inv.items[it]; }   // 吸收送达的建材
          const remaining = Math.max(0, need[it] - proj.contributed[it]);
          if (req) req.needs[it] = remaining;
          if (proj.contributed[it] < need[it] - 1e-6) allDone = false;
        }
        if (allDone) advance(proj, stages, ctx, e);
      } else {   // 计时阶段
        if (req) req.needs = {};
        proj.prog += dt;
        if (proj.prog >= (st.time || 1)) advance(proj, stages, ctx, e);
      }
    }
  };
}

function advance(proj, stages, ctx, e) {
  proj.stage += 1;
  proj.prog = 0;
  proj.contributed = {};
  if (proj.stage >= stages.length) { finish(proj, ctx, e); return; }
  // 新阶段的 Requester.needs 会在下一 tick 由主循环(投料分支)按剩余量设置; 这里只广播
  const st = stages[proj.stage];
  if (ctx.bus) ctx.bus.emit('engine_stage', { eid: e, stage: st.id, index: proj.stage });
}

function finish(proj, ctx, e) {
  if (proj.done) return;
  proj.done = true; proj.built = true;
  if (ctx.bus) ctx.bus.emit('engine_built', { eid: e });
}
