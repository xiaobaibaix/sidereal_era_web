// 建造 / 拆除 —— 把建筑数据组装成实体(组件),并处理挖机的地形坑 edit。
// 与渲染/UI 解耦: App 只需 pick 到方向 dir 后调 placeBuilding。

// 放置一个建筑; 返回实体 id(失败返回 null)
export function placeBuilding(world, ctx, buildingId, dir, yaw = 0) {
  const { planet, registry, spatial, bus } = ctx;
  const b = registry.buildings[buildingId];
  if (!b) return null;

  const e = world.create();
  world.add(e, 'Anchor', { dir: [dir[0], dir[1], dir[2]], yaw: yaw || 0 });
  world.add(e, 'Building', { typeId: buildingId, mesh: b.mesh || buildingId });
  if (spatial) spatial.insert(e, dir);

  if (b.kind === 'miner') {
    world.add(e, 'Miner', { typeId: b.machine || buildingId, dugDepth: 0, state: 'mining', lastItem: null });
    world.add(e, 'Inventory', { items: {}, cap: b.cap != null ? b.cap : Infinity });
    if (planet) {
      const edit = { pos: [dir[0], dir[1], dir[2]], radius: b.digRadius || 0.03, depth: 0, falloff: 'smooth', dry: true };
      planet.params.edits.push(edit);
      if (!ctx.minerEdits) ctx.minerEdits = new Map();
      ctx.minerEdits.set(e, edit);
    }
  } else if (b.kind === 'storage') {
    world.add(e, 'Storage', {});
    world.add(e, 'Inventory', { items: {}, cap: b.cap != null ? b.cap : Infinity });
  }

  if (bus) bus.emit('build', { eid: e, buildingId });
  return e;
}

// 拆除: 移除组件/实体, 回收其地形坑 edit 并失效该区域(地形恢复)
export function demolish(world, ctx, eid) {
  const { planet, spatial, bus } = ctx;
  const edit = ctx.minerEdits && ctx.minerEdits.get(eid);
  if (edit && planet) {
    const i = planet.params.edits.indexOf(edit);
    if (i >= 0) planet.params.edits.splice(i, 1);
    ctx.minerEdits.delete(eid);
    planet._buildNoise();
    for (const r of planet.roots) planet._invalidateAffected(r, { x: edit.pos[0], y: edit.pos[1], z: edit.pos[2] }, edit.radius);
    planet._editPending = true;
  }
  if (spatial) spatial.remove(eid);
  world.destroy(eid);
  if (bus) bus.emit('demolish', { eid });
}
