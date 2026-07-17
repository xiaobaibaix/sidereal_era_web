// B升级 无头单测(R5): 逐顶点挖掘 - 全阶段(数据结构 + 平整策略 + 永久变形 + 独立 zone 实体)
//   - 放置挖掘区(placeDigZoneEntity)后 zone 独立实体有 vertices, 字段齐, 顶点都在 zone.radius 内, hardLimit 正确。
//   - 平整策略: 最低 baseH 作基准(planeH), frontier 由低到高扩展。
//   - R5: zone 是独立实体(Anchor+Building+DigZone), 不再嵌在 depot 里;
//         多对多覆盖(depot.coverageRadius 决定; 一个 zone 可被多 depot 覆盖, 一个 depot 可覆盖多 zone)。
//   - 永久变形: 拆除 zone/depot 后, planet.params.digZoneVertices 按 zone id 永久保留。
// 运行: node src/factory/test_mining_vertex.mjs

import assert from 'node:assert';
import { createWorld } from './core/world.js';
import { createRegistry } from './core/registry.js';
import { createSpatial } from './core/spatial.js';
import { createEventBus } from './core/events.js';
import { placeBuilding, demolish } from './systems/placement.js';
import {
  setDigZone, placeDigZoneEntity, removeDigZoneEntity,
  generateVertices, spawnExcavators, syncDigZoneVertices, migrateDigZones,
  recomputePlane, createMiningCrewSystem,
  getDepotCoverage, getZoneDepots,
} from './systems/mining_crew.js';
import { angle } from './core/sphere.js';
import { invTotal } from './core/inventory.js';
import { oreColumn, layerAt } from './ore.js';
import gameData from './data/gamedata.js';

let pass = 0;
const ok = (n) => { pass++; console.log('  ✓', n); };

function stubPlanet(baseH = 1.0) {
  return {
    params: { edits: [], radius: 100, maxHeight: 8, seaLevel: 0 },
    roots: [], _editPending: false,
    _buildNoise() {}, _invalidateAffected() {},
    baseHeightAt(x, y, z) { return baseH + 0.3 * Math.sin(x * 50) + 0.3 * Math.cos(z * 70); },
    heightAt(x, y, z) { return this.baseHeightAt(x, y, z); },
    position: { x: 0, y: 0, z: 0 },
  };
}
function makeCtx(planet) {
  const registry = createRegistry().load(gameData);
  return { planet, registry, spatial: createSpatial(), bus: createEventBus() };
}
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0]/l, v[1]/l, v[2]/l]; };
// 从 world 重建 spatial(save/load 后 ctx.spatial 是空的, 需手动重灌)
function rebuildSpatial(world, ctx) {
  for (const e of world.query('Anchor')) {
    const a = world.get(e, 'Anchor');
    ctx.spatial.insert(e, a.dir);
  }
}
// 取 world 里第一个 zone 实体的 DigZone 数据(测试多数为单 zone 场景)
const Z = (world) => {
  for (const e of world.query('DigZone')) return world.get(e, 'DigZone');
  return null;
};
const ZEid = (world) => {
  for (const e of world.query('DigZone')) return e;
  return null;
};

// ===========================================================================
// 阶段 1: 数据结构 + 顶点网格生成
// ===========================================================================

// ---- 1. generateVertices: 顶点数 / 字段 / 全部在 zone 内 ----
{
  const planet = stubPlanet(0.4);
  const ctx = makeCtx(planet);
  const world = createWorld();
  placeBuilding(world, ctx, 'depot', norm([0, 1, 0]));   // 覆盖范围内任意 depot
  assert.equal(world.count('DigZone'), 0, '未圈定前无 DigZone 实体');

  const center = norm([0.1, 1, 0.05]);
  const ze = placeDigZoneEntity(world, ctx, center);
  const zone = world.get(ze, 'DigZone');
  assert.ok(Array.isArray(zone.vertices), 'placeDigZoneEntity 后 vertices 是数组');
  assert.ok(zone.vertices.length > 50, `顶点数合理(实际 ${zone.vertices.length})`);
  assert.ok(zone.vertices.length < 2000, `顶点数有上限(实际 ${zone.vertices.length})`);

  for (const v of zone.vertices) {
    assert.ok(Array.isArray(v.dir) && v.dir.length === 3, '顶点 dir 是 3 维');
    assert.ok(typeof v.baseH === 'number', '顶点 baseH 是数字');
    assert.equal(v.offset, 0, '初始 offset=0');
    assert.equal(v.ownerId, null, '初始 ownerId=null');
    assert.ok(v.hardLimit > 0, 'hardLimit > 0');
  }
  for (const v of zone.vertices) {
    const ang = angle(v.dir, zone.center);
    assert.ok(ang <= zone.radius + 1e-6, `顶点在 zone 内(ang=${ang.toFixed(4)} <= ${zone.radius})`);
  }
  for (const v of zone.vertices) {
    assert.ok(Math.abs(v.hardLimit - 0.8) < 1e-6, `hardLimit=0.8(铜层上沿, 实际 ${v.hardLimit})`);
  }
  ok('generateVertices: 顶点数/字段齐/全在 zone 内/hardLimit=0.8');
}

// ---- 2. 顶点方向都是单位向量 ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  placeBuilding(world, ctx, 'depot', norm([1, 0, 0]));
  placeDigZoneEntity(world, ctx, norm([0.9, 0.1, 0.1]));
  const zone = Z(world);
  for (const v of zone.vertices) {
    const l = Math.hypot(v.dir[0], v.dir[1], v.dir[2]);
    assert.ok(Math.abs(l - 1) < 1e-6, `顶点 dir 是单位向量(|v|=${l.toFixed(4)})`);
  }
  ok('顶点方向都是单位向量');
}

// ---- 3. 不同 digResolution 生成不同密度的网格 ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  placeBuilding(world, ctx, 'depot', norm([0, 1, 0]));
  placeDigZoneEntity(world, ctx, norm([0.1, 1, 0.05]), { resolution: 0.005 });
  const n1 = Z(world).vertices.length;

  placeDigZoneEntity(world, ctx, norm([0.1, 1, 0.05]), { resolution: 0.003 });
  // 取最后一个 zone 实体
  let last = null;
  for (const e of world.query('DigZone')) last = world.get(e, 'DigZone');
  const n2 = last.vertices.length;

  assert.ok(n2 > n1, `更细的 resolution 应生成更多顶点(${n2} > ${n1})`);
  ok(`digResolution 控制密度: 0.005→${n1}, 0.003→${n2}`);
}

// ---- 4. spawnExcavators: Excavator 携带新字段 ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  const depot = placeBuilding(world, ctx, 'depot', norm([0, 1, 0]));
  placeDigZoneEntity(world, ctx, norm([0.1, 1, 0.05]));
  const [ex1, ex2] = spawnExcavators(world, ctx, 2, depot);
  for (const eid of [ex1, ex2]) {
    const ex = world.get(eid, 'Excavator');
    assert.equal(ex.state, 'idle', '初始 state=idle');
    assert.equal(ex.targetZone, null, '初始 targetZone=null');
    assert.equal(ex.targetVertex, null, '初始 targetVertex=null');
    assert.equal(ex.digProgress, 0, '初始 digProgress=0');
    assert.equal(ex.searchCooldown, 0, '初始 searchCooldown=0');
    assert.ok(typeof ex.digReach === 'number' && ex.digReach > 0, `digReach 正常(${ex.digReach})`);
    assert.equal(ex.depot, depot, '挖机绑定 depot');
  }
  ok('spawnExcavators: Excavator 携带逐顶点字段');
}

// ---- 5. R5 多对多覆盖: 多 depot 共享一个 zone; 一个 depot 覆盖多 zone ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  // 三个矿场紧密聚集(都在 [0,1,0] 附近, 互相在覆盖范围内)
  const d1 = placeBuilding(world, ctx, 'depot', norm([0, 1, 0]));
  const d2 = placeBuilding(world, ctx, 'depot', norm([0.02, 1, 0.01]));
  // 一个 zone 放在三个矿场都能覆盖到的位置
  const ze = placeDigZoneEntity(world, ctx, norm([0.01, 1, 0.005]));
  // 该 zone 应被所有 depot 覆盖
  const deps = getZoneDepots(world, ctx, ze);
  assert.ok(deps.includes(d1) && deps.includes(d2), `zone 被多个 depot 覆盖(共 ${deps.length} 个)`);
  // 各 depot 都覆盖到这个 zone
  assert.ok(getDepotCoverage(world, ctx, d1).includes(ze), 'd1 覆盖该 zone');
  assert.ok(getDepotCoverage(world, ctx, d2).includes(ze), 'd2 也覆盖该 zone');

  // 再放第二个 zone, 让 d1 同时覆盖两个 zone
  const ze2 = placeDigZoneEntity(world, ctx, norm([0.05, 1, 0.0]));
  assert.equal(getDepotCoverage(world, ctx, d1).length, 2, 'd1 覆盖 2 个 zone');
  ok('R5 多对多: 多 depot 共享一个 zone, 一 depot 覆盖多 zone');
}

console.log(`\n阶段 1 全部通过 (${pass} 组断言)`);

// ===========================================================================
// 阶段 2: terrain.js 顶点采样层(syncDigZoneVertices 数据流 + IDW 算法)
// ===========================================================================
pass = 0;

// ---- 6. syncDigZoneVertices: DigZone → planet.params.digZoneVertices ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  placeBuilding(world, ctx, 'depot', norm([0, 1, 0]));
  placeDigZoneEntity(world, ctx, norm([0.1, 1, 0.05]));
  assert.ok(Array.isArray(planet.params.digZoneVertices), 'placeDigZoneEntity 触发同步');
  assert.equal(planet.params.digZoneVertices.length, 1, '一个 zone → params 一项');
  const z0 = planet.params.digZoneVertices[0];
  assert.ok(Array.isArray(z0.center) && z0.center.length === 3, '同步项含 center');
  assert.equal(typeof z0.radius, 'number', '同步项含 radius');
  assert.equal(typeof z0.maxInfluence, 'number', '同步项含 maxInfluence');
  assert.ok(Math.abs(z0.maxInfluence - 0.0075) < 1e-6, `maxInfluence = resolution×1.5 = 0.0075(实际 ${z0.maxInfluence})`);
  assert.ok(Array.isArray(z0.vertices) && z0.vertices.length > 0, '同步项含 vertices');
  for (const v of z0.vertices) {
    assert.ok(Array.isArray(v.dir) && typeof v.offset === 'number', '顶点 {dir, offset}');
    assert.ok(!('ownerId' in v) && !('hardLimit' in v) && !('baseH' in v), '同步项只含 dir+offset(精简)');
  }
  ok('syncDigZoneVertices: 字段格式 + 精简(只传 dir/offset)');
}

// ---- 7. 顶点 offset 改变后, 重同步会反映到 params ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  placeBuilding(world, ctx, 'depot', norm([0, 1, 0]));
  placeDigZoneEntity(world, ctx, norm([0.1, 1, 0.05]));
  const zone = Z(world);
  const before = planet.params.digZoneVertices[0].vertices[0].offset;
  zone.vertices[0].offset = 0.5;
  syncDigZoneVertices(world, ctx);
  const after = planet.params.digZoneVertices[0].vertices[0].offset;
  assert.ok(after > before + 0.4, `offset 改变后重同步生效(前 ${before} → 后 ${after})`);
  ok('顶点 offset 变更后 sync 反映到 params');
}

// ---- 8. 拆除 depot 后, 顶点变形永久保留(地形不恢复) ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  const d1 = placeBuilding(world, ctx, 'depot', norm([0, 1, 0]));
  const d2 = placeBuilding(world, ctx, 'depot', norm([1, 0, 0]));
  placeDigZoneEntity(world, ctx, norm([0.1, 1, 0]));   // 在 d1 覆盖内
  placeDigZoneEntity(world, ctx, norm([1, 0.1, 0]));   // 在 d2 覆盖内
  assert.equal(planet.params.digZoneVertices.length, 2, '两 zone 都同步');
  // 模拟 zone1 已经挖了一些
  const z1 = Z(world);
  for (const v of z1.vertices) v.offset = 0.3;
  syncDigZoneVertices(world, ctx);

  demolish(world, ctx, d1);
  // 永久变形: params 里 entry 仍在(按 id 永久保留)
  assert.equal(planet.params.digZoneVertices.length, 2, '拆除 d1 后, 它的顶点变形仍保留(永久)');
  ok('拆除 depot 后, 顶点变形永久保留(不恢复)');
}

// ---- 9. IDW 算法验证 ----
function idw(ux, uy, uz, vertices, maxInfluence) {
  let weight = 0, sumOff = 0;
  for (const v of vertices) {
    if (v.offset <= 0) continue;
    const cos = ux * v.dir[0] + uy * v.dir[1] + uz * v.dir[2];
    if (cos <= 0) continue;
    const ang = Math.acos(Math.min(1, cos));
    if (ang > maxInfluence) continue;
    const w = 1 / Math.max(ang, 1e-4);
    weight += w; sumOff += v.offset * w;
  }
  return weight > 0 ? sumOff / weight : 0;
}
{
  const dir = norm([0.3, 1.0, 0.2]);
  const vertices = [
    { dir, offset: 0.4 },
    { dir: norm([0.31, 1.0, 0.2]), offset: 0.2 },
    { dir: norm([1, 0, 0]), offset: 1.0 },
  ];
  const maxInf = 0.01;
  const h0 = idw(dir[0], dir[1], dir[2], vertices, maxInf);
  assert.ok(h0 > 0.39 && h0 < 0.41, `中心点 IDW ≈ 中心顶点 offset(${h0.toFixed(4)} ≈ 0.4)`);
  const farVerts = [{ dir: norm([1, 0, 0]), offset: 1.0 }];
  const hf = idw(dir[0], dir[1], dir[2], farVerts, maxInf);
  assert.equal(hf, 0, '远超 maxInfluence 的顶点不参与 IDW');
  const zeroVerts = [{ dir, offset: 0 }, { dir, offset: 0 }];
  const hz = idw(dir[0], dir[1], dir[2], zeroVerts, maxInf);
  assert.equal(hz, 0, 'offset=0 的顶点不影响 heightAt');
  ok('IDW 算法: 中心点主导 / 远点剪枝 / offset=0 跳过');
}

console.log(`\n阶段 2 全部通过 (${pass} 组断言)`);

// ===========================================================================
// 阶段 3: 挖机状态机(R3 范围 / R4 平面 / R6 互斥 / R5 找下一个)
// ===========================================================================
pass = 0;

// ---- 10. R3: 挖机只挖 digReach 内的顶点 ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  const depot = placeBuilding(world, ctx, 'depot', norm([0, 1, 0]));
  placeDigZoneEntity(world, ctx, norm([0, 1, 0]));
  const zone = Z(world);
  const [ex] = spawnExcavators(world, ctx, 1, depot);
  world.get(ex, 'Mover').dir = [...zone.center];
  world.get(ex, 'Excavator').digReach = 0.006;
  world.addSystem('mining_crew', createMiningCrewSystem());
  world.tick(0.05, ctx);
  const targetIdx = world.get(ex, 'Excavator').targetVertex;
  assert.ok(targetIdx != null, '挖机锁定了一个顶点');
  const targetV = zone.vertices[targetIdx];
  const ang = angle(targetV.dir, zone.center);
  assert.ok(ang <= 0.006 + 1e-6, `锁定顶点在 digReach 内(ang=${ang.toFixed(4)} <= 0.006)`);
  ok('R3: 挖机只锁定 digReach 内的顶点');
}

// ---- 11. R4(平面版): 挖机不挖基准点, 锁定高于基准的 frontier 顶点 ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  const depot = placeBuilding(world, ctx, 'depot', norm([0, 1, 0]));
  placeDigZoneEntity(world, ctx, norm([0, 1, 0]));
  const zone = Z(world);
  const baseIdx = zone.vertices.findIndex((v) => (v.neighbors || []).length >= 3);
  assert.ok(baseIdx >= 0, '存在>=3邻居的内部顶点');
  for (const v of zone.vertices) v.baseH = 0.5;
  zone.vertices[baseIdx].baseH = 0.2;
  recomputePlane(zone);
  assert.equal(zone.planeH, 0.2, 'planeH = 最低 baseH');
  assert.equal(zone.vertices[baseIdx].targetOffset, 0, '基准点 targetOffset=0(无需挖)');

  const [ex] = spawnExcavators(world, ctx, 1, depot);
  world.get(ex, 'Excavator').digReach = 1.0;
  world.get(ex, 'Mover').dir = [...zone.vertices[baseIdx].dir];
  world.addSystem('mining_crew', createMiningCrewSystem());
  world.tick(0.05, ctx);
  const targetIdx = world.get(ex, 'Excavator').targetVertex;
  assert.ok(targetIdx != null, '锁定了一个顶点');
  assert.notEqual(targetIdx, baseIdx, '不锁基准点(基准无需挖)');
  assert.ok(zone.vertices[targetIdx].targetOffset > 0, '锁定的顶点高于基准(有工作量)');
  assert.ok(
    (zone.vertices[baseIdx].neighbors || []).includes(targetIdx),
    '锁定基准的邻居(frontier 扩展, 不远程跳)'
  );
  ok('R4(平面版): 不挖基准点, 锁定其邻居中高于基准的顶点');
}

// ---- 11b. 平整策略: 由低到高扩展 ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  const depot = placeBuilding(world, ctx, 'depot', norm([0, 1, 0]));
  placeDigZoneEntity(world, ctx, norm([0, 1, 0]));
  const zone = Z(world);
  const baseIdx = zone.vertices.findIndex((v) => (v.neighbors || []).length >= 2);
  assert.ok(baseIdx >= 0, '存在>=2邻居的顶点');
  for (const v of zone.vertices) { v.baseH = 1.0; v.hardLimit = 2.0; }
  zone.vertices[baseIdx].baseH = 0.2;
  const nbs = zone.vertices[baseIdx].neighbors;
  assert.ok(nbs.length >= 2, '基准有>=2邻居');
  zone.vertices[nbs[0]].baseH = 0.3;
  zone.vertices[nbs[1]].baseH = 0.9;
  recomputePlane(zone);

  const [ex] = spawnExcavators(world, ctx, 1, depot);
  world.get(ex, 'Excavator').digReach = 1.0;
  world.get(ex, 'Mover').dir = [...zone.vertices[baseIdx].dir];
  world.addSystem('mining_crew', createMiningCrewSystem());
  world.tick(0.05, ctx);
  const targetIdx = world.get(ex, 'Excavator').targetVertex;
  assert.equal(targetIdx, nbs[0], '锁定 baseH 较低的邻居(由低到高平整)');
  ok('平整策略: 多候选时选 baseH 最低的(由低到高扩展)');
}

// ---- 12. R6: 两台挖机不会锁同一个顶点 ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  const depot = placeBuilding(world, ctx, 'depot', norm([0, 1, 0]));
  placeDigZoneEntity(world, ctx, norm([0, 1, 0]));
  const zone = Z(world);
  const [ex1, ex2] = spawnExcavators(world, ctx, 2, depot);
  world.get(ex1, 'Mover').dir = [...zone.center];
  world.get(ex2, 'Mover').dir = [...zone.center];
  world.get(ex1, 'Excavator').digReach = 1.0;
  world.get(ex2, 'Excavator').digReach = 1.0;
  world.addSystem('mining_crew', createMiningCrewSystem());
  for (let i = 0; i < 5; i++) world.tick(0.05, ctx);
  const t1 = world.get(ex1, 'Excavator').targetVertex;
  const t2 = world.get(ex2, 'Excavator').targetVertex;
  assert.ok(t1 != null && t2 != null, '两台挖机都锁定了顶点');
  assert.notEqual(t1, t2, '两台挖机锁了不同顶点(R6 互斥)');
  ok('R6: 两台挖机不会锁同一个顶点');
}

// ---- 13. 平整到 targetOffset 后释放 + 找下一个 ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  const depot = placeBuilding(world, ctx, 'depot', norm([0, 1, 0]));
  placeDigZoneEntity(world, ctx, norm([0, 1, 0]));
  const zone = Z(world);
  for (const v of zone.vertices) { v.baseH = 0.5; v.hardLimit = 2.0; }
  const baseIdx = zone.vertices.findIndex((v) => (v.neighbors || []).length >= 3);
  zone.vertices[baseIdx].baseH = 0.45;
  recomputePlane(zone);
  const [ex] = spawnExcavators(world, ctx, 1, depot);
  world.get(ex, 'Excavator').digReach = 1.0;
  world.get(ex, 'Mover').dir = [...zone.vertices[baseIdx].dir];
  world.addSystem('mining_crew', createMiningCrewSystem());
  let lastTarget = null, switches = 0;
  for (let i = 0; i < 400; i++) {
    world.tick(0.05, ctx);
    const t = world.get(ex, 'Excavator').targetVertex;
    if (t != null && t !== lastTarget) { switches++; lastTarget = t; }
  }
  assert.ok(switches >= 2, `挖机至少切换过 2 次目标(实际 ${switches})`);
  const done = zone.vertices.filter((v) => v.offset >= v.targetOffset - 1e-6).length;
  assert.ok(done >= 2, `至少 2 个顶点已平整到 targetOffset(实际 ${done})`);
  ok('平整到 targetOffset 后释放, 找下一个');
}

// ---- 14. 端到端: 挖机产矿到自身缓冲 ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  // 在 [0,1,0] 附近找一个铁矿方向(depot 覆盖半径 0.16, 给些余量)
  let ironDir = null;
  for (let i = 0; i < 800 && !ironDir; i++) {
    const t = i * 0.012;
    const d = norm([Math.sin(t) * 0.1, 1, Math.cos(t) * 0.1]);
    const col = oreColumn(d, gameData.ore);
    if (layerAt(col, 0.3).item === 'iron_ore') ironDir = d;
  }
  const depot = placeBuilding(world, ctx, 'depot', norm([0, 1, 0]));
  if (ironDir) {
    placeDigZoneEntity(world, ctx, ironDir);
    const [ex] = spawnExcavators(world, ctx, 1, depot);
    world.get(ex, 'Excavator').digReach = 1.0;
    world.addSystem('mining_crew', createMiningCrewSystem());
    for (let i = 0; i < 200; i++) world.tick(0.05, ctx);
    const inv = world.get(ex, 'Inventory');
    assert.ok(invTotal(inv) > 0, `挖机产出矿产(共 ${invTotal(inv).toFixed(1)})`);
  }
  ok('端到端: 挖机产矿到自身缓冲');
}

// ---- 15. 满仓 → state=full, 释放锁定 ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  const depot = placeBuilding(world, ctx, 'depot', norm([0, 1, 0]));
  placeDigZoneEntity(world, ctx, norm([0, 1, 0]));
  const zone = Z(world);
  const [ex] = spawnExcavators(world, ctx, 1, depot);
  const inv = world.get(ex, 'Inventory');
  inv.items.iron_ore = (inv.cap || 60);
  world.get(ex, 'Excavator').digReach = 1.0;
  world.get(ex, 'Mover').dir = [...zone.center];
  world.addSystem('mining_crew', createMiningCrewSystem());
  world.tick(0.05, ctx);
  assert.equal(world.get(ex, 'Excavator').state, 'full', '满仓 → state=full');
  assert.equal(world.get(ex, 'Excavator').targetVertex, null, '满仓时释放锁定');
  ok('满仓 → state=full + 释放锁定');
}

console.log(`\n阶段 3 全部通过 (${pass} 组断言)`);

// ---- 15b. 平整收敛 ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  const depot = placeBuilding(world, ctx, 'depot', norm([0, 1, 0]));
  placeDigZoneEntity(world, ctx, norm([0, 1, 0]));
  const zone = Z(world);
  const [ex1, ex2] = spawnExcavators(world, ctx, 2, depot);
  for (const eid of [ex1, ex2]) {
    world.get(eid, 'Excavator').digReach = 1.0;
    world.get(eid, 'Mover').dir = [...zone.center];
    world.get(eid, 'Inventory').cap = Infinity;
  }
  ctx.registry.machineTypes.excavator_mk1.digRate = 1.0;
  world.addSystem('mining_crew', createMiningCrewSystem());
  for (let i = 0; i < 2000; i++) world.tick(0.05, ctx);
  let maxShort = 0;
  for (const v of zone.vertices) {
    const short = v.targetOffset - v.offset;
    if (short > maxShort) maxShort = short;
  }
  assert.ok(maxShort < 1e-3, `所有顶点平整到 targetOffset(最大欠挖 ${maxShort.toFixed(4)} < 1e-3)`);
  ctx.registry.machineTypes.excavator_mk1.digRate = 0.05;
  ok(`平整收敛: 所有顶点到 targetOffset → 形成平整平面(欠挖 ${maxShort.toFixed(4)})`);
}

// ===========================================================================
// 阶段 4 (R5): 多对多覆盖 + 永久变形 + 拆除
// ===========================================================================
pass = 0;

// ---- R5-A. 多 depot 共享一个 zone: 挖机可来自任一 depot, 各 depot 都能收矿 ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  const d1 = placeBuilding(world, ctx, 'depot', norm([0, 1, 0]));
  const d2 = placeBuilding(world, ctx, 'depot', norm([0.02, 1, 0.01]));
  const ze = placeDigZoneEntity(world, ctx, norm([0.01, 1, 0.005]));

  // 该 zone 被 d1 和 d2 都覆盖
  const cov1 = getDepotCoverage(world, ctx, d1);
  const cov2 = getDepotCoverage(world, ctx, d2);
  assert.ok(cov1.includes(ze) && cov2.includes(ze), '两 depot 都覆盖该 zone');
  // 各自生成挖机
  spawnExcavators(world, ctx, 1, d1);
  spawnExcavators(world, ctx, 1, d2);
  assert.equal(world.count('Excavator'), 2, '两个 depot 各生 1 挖机');
  ok('R5-A: 多 depot 共享一个 zone(挖机归属各自 depot)');
}

// ---- R5-B. 一个 depot 覆盖多个 zone: 挖机在多 zone 间找工件 ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  const depot = placeBuilding(world, ctx, 'depot', norm([0, 1, 0]));
  // 在 depot 覆盖内放两个相邻 zone
  const ze1 = placeDigZoneEntity(world, ctx, norm([0.02, 1, 0]));
  const ze2 = placeDigZoneEntity(world, ctx, norm([0.07, 1, 0]));
  assert.equal(getDepotCoverage(world, ctx, depot).length, 2, 'depot 覆盖 2 个 zone');

  const [ex] = spawnExcavators(world, ctx, 1, depot);
  world.get(ex, 'Excavator').digReach = 1.0;
  world.get(ex, 'Inventory').cap = Infinity;
  world.addSystem('mining_crew', createMiningCrewSystem());
  // 跑一段, 挖机应在两个 zone 间找工件
  for (let i = 0; i < 200; i++) world.tick(0.05, ctx);
  const dug1 = world.get(ze1, 'DigZone').vertices.filter(v => v.offset > 0).length;
  const dug2 = world.get(ze2, 'DigZone').vertices.filter(v => v.offset > 0).length;
  assert.ok(dug1 + dug2 > 0, `挖机在多 zone 中找到工作(共挖 ${dug1 + dug2} 顶点)`);
  ok('R5-B: 一 depot 覆盖多 zone, 挖机跨 zone 工作');
}

// ---- R5-C. 拆除 zone 实体后, 顶点变形永久保留 ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  placeBuilding(world, ctx, 'depot', norm([0, 1, 0]));
  const ze = placeDigZoneEntity(world, ctx, norm([0.1, 1, 0.05]));
  const zone = world.get(ze, 'DigZone');
  for (const v of zone.vertices) v.offset = 0.4;
  syncDigZoneVertices(world, ctx);
  assert.equal(planet.params.digZoneVertices.length, 1, '圈定后 1 个 entry');

  removeDigZoneEntity(world, ctx, ze);
  // 永久变形: entry 仍在
  assert.equal(planet.params.digZoneVertices.length, 1, '拆除 zone 后 entry 保留(永久变形)');
  assert.equal(planet.params.digZoneVertices[0].vertices.filter(v => v.offset > 0).length,
               zone.vertices.length, '顶点 offset 全部保留(地形不恢复)');
  assert.equal(world.count('DigZone'), 0, 'world 中 zone 实体已销毁');
  ok('R5-C: 拆除 zone 实体后, 顶点变形永久保留');
}

// ---- R5-D. 拆除 depot: 它的挖机/卡车一并销毁, 但 zone 实体保留(可能被其他 depot 覆盖) ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  const d1 = placeBuilding(world, ctx, 'depot', norm([0, 1, 0]));
  const d2 = placeBuilding(world, ctx, 'depot', norm([0.02, 1, 0.01]));
  const ze = placeDigZoneEntity(world, ctx, norm([0.01, 1, 0.005]));
  spawnExcavators(world, ctx, 2, d1);
  spawnExcavators(world, ctx, 1, d2);
  assert.equal(world.count('Excavator'), 3, '共 3 挖机');
  assert.equal(world.count('DigZone'), 1, '1 个 zone');

  demolish(world, ctx, d1);
  assert.equal(world.count('Excavator'), 1, 'd1 的 2 挖机销毁, 只剩 d2 的 1 个');
  assert.equal(world.count('DigZone'), 1, 'zone 实体仍在(独立于 depot)');
  assert.ok(getDepotCoverage(world, ctx, d2).includes(ze), 'd2 仍覆盖该 zone');
  ok('R5-D: 拆除 depot 销毁归属挖机/卡车, zone 独立保留');
}

console.log(`\n阶段 4 (R5) 全部通过 (${pass} 组断言)`);

// ===========================================================================
// 阶段 5: 存档与端到端(migrateDigZones + toJSON/fromJSON 往返)
// ===========================================================================
pass = 0;

import { toJSON, fromJSON } from './core/save.js';

// ---- 16. migrateDigZones: 旧版"Depot+DigZone.zones[]"存档 → 拆出独立 zone 实体 ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  const depot = placeBuilding(world, ctx, 'depot', norm([0, 1, 0]));
  // 模拟旧版(R4) 存档: depot 上挂 DigZone.zones[], 内嵌一个 zone(无 vertices)
  world.add(depot, 'DigZone', {
    zones: [{
      id: 99, center: [...norm([0.1, 1, 0.05])],
      radius: 0.05, resolution: 0.005, planeH: 0, depth: 0,
      vertices: null,
    }],
  });
  planet.params.digZoneVertices = null;

  const touched = migrateDigZones(world, ctx);
  assert.ok(touched >= 1, `迁移触发(实际 ${touched})`);
  assert.ok(!world.has(depot, 'DigZone'), '迁移后 depot 不再有 DigZone');
  assert.equal(world.count('DigZone'), 1, '拆出 1 个独立 zone 实体');
  const ze = ZEid(world);
  const zd = world.get(ze, 'DigZone');
  assert.equal(zd.id, 99, '迁移保留原 zone id(永久变形靠 id)');
  assert.ok(zd.vertices && zd.vertices.length > 0, '迁移后顶点已生成');
  ok('migrateDigZones: 旧版嵌套 zone → 独立实体(id 保留)');
}

// ---- 16b. migrateDigZones: 幂等(R5 已是独立实体 → 不动) ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  placeBuilding(world, ctx, 'depot', norm([0, 1, 0]));
  placeDigZoneEntity(world, ctx, norm([0.1, 1, 0.05]));
  const beforeCount = world.count('DigZone');
  const touched = migrateDigZones(world, ctx);
  assert.equal(world.count('DigZone'), beforeCount, '已是 R5 格式, 实体数不变');
  assert.equal(touched, 0, '幂等: 不重复迁移');
  ok('migrateDigZones: 幂等(R5 跳过)');
}

// ---- 17. 端到端: 挖一阵 → 存档 → 载入新世界 → 继续挖, 状态一致 ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  const depot = placeBuilding(world, ctx, 'depot', norm([0, 1, 0]));
  placeDigZoneEntity(world, ctx, norm([0.1, 1, 0.05]));
  const [ex] = spawnExcavators(world, ctx, 1, depot);
  world.get(ex, 'Excavator').digReach = 1.0;
  world.addSystem('mining_crew', createMiningCrewSystem());
  for (let i = 0; i < 50; i++) world.tick(0.05, ctx);
  const zone = Z(world);
  const dugCountBefore = zone.vertices.filter((v) => v.offset > 0).length;
  const maxOffsetBefore = Math.max(...zone.vertices.map((v) => v.offset));
  assert.ok(dugCountBefore > 0, `挖过若干顶点(实际 ${dugCountBefore})`);
  assert.ok(maxOffsetBefore > 0, `最深 offset > 0(${maxOffsetBefore.toFixed(3)})`);

  const json = toJSON(world);
  const w2 = createWorld();
  fromJSON(json, w2);
  assert.equal(w2.count('DigZone'), 1, '载入后 DigZone 数量保留');
  assert.equal(w2.count('Excavator'), 1, '载入后 Excavator 数量保留');
  const zone2 = Z(w2);
  assert.ok(Array.isArray(zone2.vertices) && zone2.vertices.length === zone.vertices.length, '顶点表完整保留');
  const maxOffsetAfter = Math.max(...zone2.vertices.map((v) => v.offset));
  assert.ok(Math.abs(maxOffsetAfter - maxOffsetBefore) < 1e-9, `载入后 offset 一致(前 ${maxOffsetBefore} → 后 ${maxOffsetAfter})`);

  const ctx2 = makeCtx(stubPlanet());
  rebuildSpatial(w2, ctx2);   // 重新填充 spatial(save/load 后空)
  migrateDigZones(w2, ctx2);
  w2.addSystem('mining_crew', createMiningCrewSystem());
  for (let i = 0; i < 50; i++) w2.tick(0.05, ctx2);
  const maxOffsetContinue = Math.max(...zone2.vertices.map((v) => v.offset));
  assert.ok(maxOffsetContinue > maxOffsetBefore, `载入后继续挖掘更深(前 ${maxOffsetBefore.toFixed(3)} → 后 ${maxOffsetContinue.toFixed(3)})`);
  ok(`端到端存档: 挖→存→载入→续挖状态一致(max off ${maxOffsetBefore.toFixed(3)} → ${maxOffsetContinue.toFixed(3)})`);
}

console.log(`\n阶段 5 全部通过 (${pass} 组断言)`);
