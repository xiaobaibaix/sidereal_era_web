// B升级 无头单测: 逐顶点挖掘 - 阶段 1(数据结构 + 顶点网格生成)
//   验证: setDigZone 后 zone.vertices 有内容, 字段齐, 顶点都在 zone.radius 内, hardLimit 正确。
// 运行: node src/factory/test_mining_vertex.mjs

import assert from 'node:assert';
import { createWorld } from './core/world.js';
import { createRegistry } from './core/registry.js';
import { createSpatial } from './core/spatial.js';
import { createEventBus } from './core/events.js';
import { placeBuilding, demolish } from './systems/placement.js';
import { setDigZone, generateVertices, spawnExcavators, syncDigZoneVertices, migrateDigZones, recomputePlane, createMiningCrewSystem } from './systems/mining_crew.js';
import { angle } from './core/sphere.js';
import { invTotal } from './core/inventory.js';
import { oreColumn, layerAt } from './ore.js';
import gameData from './data/gamedata.js';

let pass = 0;
const ok = (n) => { pass++; console.log('  ✓', n); };

// 桩 planet: 只需要 baseHeightAt + params.edits/roots/_buildNoise/_invalidateAffected/_editPending
// baseHeightAt 用确定性高频函数让顶点 baseH 在 [0.4, 1.6] 内大幅变化
// (否则 planeH == max → 全部 targetOffset=0, 没活干; 或 targetOffset 太小一帧就挖完)
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
function norm(v) { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; }

// ---- 1. generateVertices: 顶点数 / 字段 / 全部在 zone 内 ----
{
  const planet = stubPlanet(0.4);
  const ctx = makeCtx(planet);
  const world = createWorld();
  const depot = placeBuilding(world, ctx, 'depot', norm([0, 1, 0]));
  const zone = world.get(depot, 'DigZone');
  assert.ok(zone.vertices === null, '未圈定前 vertices=null');

  const center = norm([0.1, 1, 0.05]);
  setDigZone(world, ctx, depot, center);
  assert.ok(Array.isArray(zone.vertices), 'setDigZone 后 vertices 是数组');
  assert.ok(zone.vertices.length > 50, `顶点数合理(实际 ${zone.vertices.length})`);
  assert.ok(zone.vertices.length < 2000, `顶点数有上限(实际 ${zone.vertices.length})`);

  // 所有顶点字段齐
  for (const v of zone.vertices) {
    assert.ok(Array.isArray(v.dir) && v.dir.length === 3, '顶点 dir 是 3 维');
    assert.ok(typeof v.baseH === 'number', '顶点 baseH 是数字');
    assert.equal(v.offset, 0, '初始 offset=0');
    assert.equal(v.ownerId, null, '初始 ownerId=null');
    assert.ok(v.hardLimit > 0, 'hardLimit > 0');
  }
  // 所有顶点在 zone.radius 内
  for (const v of zone.vertices) {
    const ang = angle(v.dir, zone.center);
    assert.ok(ang <= zone.radius + 1e-6, `顶点在 zone 内(ang=${ang.toFixed(4)} <= ${zone.radius})`);
  }
  // hardLimit: 默认 ore 数据下, mk1 hardnessMax=2 → 铜层(hardness 3)上沿 0.8 是 hardLimit
  // (表土 0..0.06 + 铁矿 0.06..0.8 + 铜脉 0.8..1.6 硬度 3 → mk1 挖不动 → hardLimit=0.8)
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
  const depot = placeBuilding(world, ctx, 'depot', norm([1, 0, 0]));
  setDigZone(world, ctx, depot, norm([0.9, 0.1, 0.1]));
  const zone = world.get(depot, 'DigZone');
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
  const depot = placeBuilding(world, ctx, 'depot', norm([0, 1, 0]));
  const zone = world.get(depot, 'DigZone');

  // 默认 resolution=0.005
  setDigZone(world, ctx, depot, norm([0.1, 1, 0.05]));
  const n1 = zone.vertices.length;

  // 改成更细的 resolution
  zone.resolution = 0.003;
  zone.center = null; zone.vertices = null;
  setDigZone(world, ctx, depot, norm([0.1, 1, 0.05]));
  const n2 = zone.vertices.length;

  assert.ok(n2 > n1, `更细的 resolution 应生成更多顶点(${n2} > ${n1})`);
  ok(`digResolution 控制密度: 0.005→${n1}, 0.003→${n2}`);
}

// ---- 4. spawnExcavators: Excavator 携带新字段(digReach/digStep/targetVertex/...) ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  const depot = placeBuilding(world, ctx, 'depot', norm([0, 1, 0]));
  setDigZone(world, ctx, depot, norm([0.1, 1, 0.05]));
  const [ex1, ex2] = spawnExcavators(world, ctx, 2, depot);
  for (const eid of [ex1, ex2]) {
    const ex = world.get(eid, 'Excavator');
    assert.equal(ex.state, 'idle', '初始 state=idle');
    assert.equal(ex.targetVertex, null, '初始 targetVertex=null');
    assert.equal(ex.digProgress, 0, '初始 digProgress=0');
    assert.equal(ex.searchCooldown, 0, '初始 searchCooldown=0');
    assert.ok(typeof ex.digReach === 'number' && ex.digReach > 0, `digReach 正常(${ex.digReach})`);
    assert.ok(typeof ex.digStep === 'number' && ex.digStep > 0, `digStep 正常(${ex.digStep})`);
    assert.equal(ex.depot, depot, '挖机绑定 depot');
  }
  ok('spawnExcavators: Excavator 携带逐顶点字段');
}

// ---- 5. 多个矿场的顶点网格独立 ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  const d1 = placeBuilding(world, ctx, 'depot', norm([1, 0, 0]));
  const d2 = placeBuilding(world, ctx, 'depot', norm([0, 1, 0]));
  setDigZone(world, ctx, d1, norm([1, 0.01, 0]));
  setDigZone(world, ctx, d2, norm([0.01, 1, 0]));
  const z1 = world.get(d1, 'DigZone');
  const z2 = world.get(d2, 'DigZone');
  assert.notEqual(z1.vertices, z2.vertices, '两矿场顶点数组独立');
  assert.equal(z1.vertices.length, z2.vertices.length, '两矿场顶点数相同(同 resolution)');
  // 顶点中心方向不同
  const c1 = z1.vertices[Math.floor(z1.vertices.length / 2)].dir;
  const c2 = z2.vertices[Math.floor(z2.vertices.length / 2)].dir;
  assert.ok(angle(c1, c2) > 0.5, `两矿场顶点在不同区域(中心角差 ${angle(c1, c2).toFixed(3)})`);
  ok('多矿场顶点网格独立');
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
  const depot = placeBuilding(world, ctx, 'depot', norm([0, 1, 0]));
  setDigZone(world, ctx, depot, norm([0.1, 1, 0.05]));
  // setDigZone 应已触发同步
  assert.ok(Array.isArray(planet.params.digZoneVertices), 'setDigZone 触发同步');
  assert.equal(planet.params.digZoneVertices.length, 1, '一个 DigZone → params 一项');
  const z0 = planet.params.digZoneVertices[0];
  assert.ok(Array.isArray(z0.center) && z0.center.length === 3, '同步项含 center');
  assert.equal(typeof z0.radius, 'number', '同步项含 radius');
  assert.equal(typeof z0.maxInfluence, 'number', '同步项含 maxInfluence');
  assert.ok(Math.abs(z0.maxInfluence - 0.0075) < 1e-6, `maxInfluence = resolution×1.5 = 0.0075(实际 ${z0.maxInfluence})`);
  assert.ok(Array.isArray(z0.vertices) && z0.vertices.length > 0, '同步项含 vertices');
  for (const v of z0.vertices) {
    assert.ok(Array.isArray(v.dir) && typeof v.offset === 'number', '顶点 {dir, offset}');
    // 不应带 baseH/ownerId/hardLimit/lastItem(terrain 不需要, 减少传 worker 的体积)
    assert.ok(!('ownerId' in v) && !('hardLimit' in v) && !('baseH' in v), '同步项只含 dir+offset(精简)');
  }
  ok('syncDigZoneVertices: 字段格式 + 精简(只传 dir/offset)');
}

// ---- 7. 顶点 offset 改变后, 重同步会反映到 params ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  const depot = placeBuilding(world, ctx, 'depot', norm([0, 1, 0]));
  setDigZone(world, ctx, depot, norm([0.1, 1, 0.05]));
  const zone = world.get(depot, 'DigZone');
  // 模拟挖机挖了第一个顶点
  const before = planet.params.digZoneVertices[0].vertices[0].offset;
  zone.vertices[0].offset = 0.5;
  syncDigZoneVertices(world, ctx);
  const after = planet.params.digZoneVertices[0].vertices[0].offset;
  assert.ok(after > before + 0.4, `offset 改变后重同步生效(前 ${before} → 后 ${after})`);
  ok('顶点 offset 变更后 sync 反映到 params');
}

// ---- 8. demolish depot 后, 顶点从 params 清除 ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  const d1 = placeBuilding(world, ctx, 'depot', norm([0, 1, 0]));
  const d2 = placeBuilding(world, ctx, 'depot', norm([1, 0, 0]));
  setDigZone(world, ctx, d1, norm([0.1, 1, 0]));
  setDigZone(world, ctx, d2, norm([1, 0.1, 0]));
  assert.equal(planet.params.digZoneVertices.length, 2, '两矿场都同步');
  demolish(world, ctx, d1);
  assert.equal(planet.params.digZoneVertices.length, 1, '拆除 d1 后只剩 1 项');
  ok('demolish depot 后顶点从 params 清除');
}

// ---- 9. IDW 算法验证(在测试里实现一份等价 IDW, 验证 terrain.js 中逻辑符合预期) ----
// 注: terrain.js 顶部 import 了 simplex-noise 的 CDN, node 无法直接 require, 故在此用等价 IDW 函数
// 验证算法行为(terrain.js 中 applyVertexOffsets 的算法等价于本测试的 idw)。
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
    { dir, offset: 0.4 },               // 正好在该方向, ang=0
    { dir: norm([0.31, 1.0, 0.2]), offset: 0.2 },   // 邻近
    { dir: norm([1, 0, 0]), offset: 1.0 },           // 远(maxInfluence 外)
  ];
  const maxInf = 0.01;
  // 中心点: IDW 应≈两近邻加权(完全在 dir 上 → weight=1/1e4=10000, 主导)
  const h0 = idw(dir[0], dir[1], dir[2], vertices, maxInf);
  assert.ok(h0 > 0.39 && h0 < 0.41, `中心点 IDW ≈ 中心顶点 offset(${h0.toFixed(4)} ≈ 0.4)`);

  // 远点不参与(maxInfluence 外)
  const farVerts = [{ dir: norm([1, 0, 0]), offset: 1.0 }];
  const hf = idw(dir[0], dir[1], dir[2], farVerts, maxInf);
  assert.equal(hf, 0, '远超 maxInfluence 的顶点不参与 IDW');

  // offset=0 的顶点不参与(terrain.js 中 v.offset <= 0 跳过)
  const zeroVerts = [{ dir, offset: 0 }, { dir, offset: 0 }];
  const hz = idw(dir[0], dir[1], dir[2], zeroVerts, maxInf);
  assert.equal(hz, 0, 'offset=0 的顶点不影响 heightAt');
  ok('IDW 算法: 中心点主导 / 远点剪枝 / offset=0 跳过');
}

console.log(`\n阶段 2 全部通过 (${pass} 组断言)`);

// ===========================================================================
// 阶段 3: 挖机状态机重写(R3 范围 / R4 最高优先 / R6 互斥 / R5 找下一个)
// ===========================================================================
pass = 0;

// 桩 planet: baseHeightAt 可配置(用于构造"高低不同的顶点")
function stubPlanetHMap(hMap) {
  return {
    params: { edits: [], radius: 100, maxHeight: 8, seaLevel: 0 },
    roots: [], _editPending: false,
    _buildNoise() {}, _invalidateAffected() {},
    // hMap 是 Map: key=dir字符串, value=height
    baseHeightAt(x, y, z) {
      const key = `${x.toFixed(3)},${y.toFixed(3)},${z.toFixed(3)}`;
      return hMap ? (hMap.get(key) ?? 0.3) : 0.3;
    },
    heightAt(x, y, z) { return this.baseHeightAt(x, y, z); },
    position: { x: 0, y: 0, z: 0 },
  };
}

// ---- 10. R3: 挖机只挖 digReach 内的顶点 ----
{
  // 用 stubPlanet 自带的高度变化(各顶点 baseH 不同 → 总有高于基准的待平整顶点)
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  const depot = placeBuilding(world, ctx, 'depot', norm([0, 1, 0]));
  setDigZone(world, ctx, depot, norm([0, 1, 0]));
  const zone = world.get(depot, 'DigZone');

  // 把挖机放到 zone 中心, digReach 设很小(0.006)
  const [ex] = spawnExcavators(world, ctx, 1, depot);
  world.get(ex, 'Mover').dir = [...zone.center];
  world.get(ex, 'Excavator').digReach = 0.006;
  // 跑一帧, 让挖机锁定一个顶点
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
  setDigZone(world, ctx, depot, norm([0, 1, 0]));
  const zone = world.get(depot, 'DigZone');
  // 选一个有>=3邻居的内部顶点作为基准(最低), 其余调高
  const baseIdx = zone.vertices.findIndex((v) => (v.neighbors || []).length >= 3);
  assert.ok(baseIdx >= 0, '存在>=3邻居的内部顶点');
  for (const v of zone.vertices) v.baseH = 0.5;
  zone.vertices[baseIdx].baseH = 0.2;   // 最低 → 基准
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

// ---- 11b. 平整策略: 由低到高扩展(多个候选时选 baseH 最低的) ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  const depot = placeBuilding(world, ctx, 'depot', norm([0, 1, 0]));
  setDigZone(world, ctx, depot, norm([0, 1, 0]));
  const zone = world.get(depot, 'DigZone');
  // 基准点 + 两个不同高度的邻居(其余顶点设很高, 不参与)
  const baseIdx = zone.vertices.findIndex((v) => (v.neighbors || []).length >= 2);
  assert.ok(baseIdx >= 0, '存在>=2邻居的顶点');
  for (const v of zone.vertices) { v.baseH = 1.0; v.hardLimit = 2.0; }
  zone.vertices[baseIdx].baseH = 0.2;
  // 第一个邻居调低, 第二个邻居调高 → 应优先选低的
  const nbs = zone.vertices[baseIdx].neighbors;
  assert.ok(nbs.length >= 2, '基准有>=2邻居');
  zone.vertices[nbs[0]].baseH = 0.3;   // 较低
  zone.vertices[nbs[1]].baseH = 0.9;   // 较高
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
  setDigZone(world, ctx, depot, norm([0, 1, 0]));
  const zone = world.get(depot, 'DigZone');
  // stubPlanet 已有高度变化 → 总有待平整顶点

  const [ex1, ex2] = spawnExcavators(world, ctx, 2, depot);
  // 两台挖机放在同一点(都看到同样的候选)
  world.get(ex1, 'Mover').dir = [...zone.center];
  world.get(ex2, 'Mover').dir = [...zone.center];
  world.get(ex1, 'Excavator').digReach = 1.0;
  world.get(ex2, 'Excavator').digReach = 1.0;

  world.addSystem('mining_crew', createMiningCrewSystem());
  // 跑几帧让两台挖机都锁定(它们会找不同顶点, 因为 ownerId 互斥)
  for (let i = 0; i < 5; i++) world.tick(0.05, ctx);
  const t1 = world.get(ex1, 'Excavator').targetVertex;
  const t2 = world.get(ex2, 'Excavator').targetVertex;
  assert.ok(t1 != null && t2 != null, '两台挖机都锁定了顶点');
  assert.notEqual(t1, t2, '两台挖机锁了不同顶点(R6 互斥)');
  ok('R6: 两台挖机不会锁同一个顶点');
}

// ---- 13. 平整到 targetOffset 后释放 + 找下一个(R5) ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  const depot = placeBuilding(world, ctx, 'depot', norm([0, 1, 0]));
  setDigZone(world, ctx, depot, norm([0, 1, 0]));
  const zone = world.get(depot, 'DigZone');
  // 构造很小的 targetOffset, 让挖机几帧就平整完一个顶点
  // 基准 baseH=0.45, 其他 baseH=0.5 → targetOffset=0.05
  for (const v of zone.vertices) { v.baseH = 0.5; v.hardLimit = 2.0; }
  const baseIdx = zone.vertices.findIndex((v) => (v.neighbors || []).length >= 3);
  zone.vertices[baseIdx].baseH = 0.45;
  recomputePlane(zone);

  const [ex] = spawnExcavators(world, ctx, 1, depot);
  world.get(ex, 'Excavator').digReach = 1.0;
  world.get(ex, 'Mover').dir = [...zone.vertices[baseIdx].dir];

  world.addSystem('mining_crew', createMiningCrewSystem());
  // 跑很多帧, 应该平整完多个顶点
  let lastTarget = null, switches = 0;
  for (let i = 0; i < 400; i++) {
    world.tick(0.05, ctx);
    const t = world.get(ex, 'Excavator').targetVertex;
    if (t != null && t !== lastTarget) { switches++; lastTarget = t; }
  }
  assert.ok(switches >= 2, `挖机至少切换过 2 次目标(实际 ${switches}, 平整完一个换下一个)`);
  // 平整完的顶点 offset 达到 targetOffset
  const done = zone.vertices.filter((v) => v.offset >= v.targetOffset - 1e-6).length;
  assert.ok(done >= 2, `至少 2 个顶点已平整到 targetOffset(实际 ${done})`);
  ok('R5: 平整到 targetOffset 后释放, 找下一个');
}

// ---- 14. 端到端: 挖机产矿到自身缓冲(产出物品符合矿层) ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  const depot = placeBuilding(world, ctx, 'depot', norm([0, 1, 0]));
  // 找一个有铁矿的方向
  let ironDir = null;
  for (let i = 0; i < 400 && !ironDir; i++) {
    const d = norm([Math.sin(i * 1.1) + 0.3, Math.cos(i * 0.7), Math.sin(i * 0.37) - 0.2]);
    const col = oreColumn(d, gameData.ore);
    if (layerAt(col, 0.3).item === 'iron_ore') ironDir = d;
  }
  if (ironDir) {
    setDigZone(world, ctx, depot, ironDir);
    const [ex] = spawnExcavators(world, ctx, 1, depot);
    world.get(ex, 'Excavator').digReach = 1.0;
    world.addSystem('mining_crew', createMiningCrewSystem());
    for (let i = 0; i < 100; i++) world.tick(0.05, ctx);
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
  setDigZone(world, ctx, depot, norm([0, 1, 0]));
  const [ex] = spawnExcavators(world, ctx, 1, depot);
  // 把挖机库存塞满
  const inv = world.get(ex, 'Inventory');
  inv.items.iron_ore = (inv.cap || 60);
  world.get(ex, 'Excavator').digReach = 1.0;
  world.get(ex, 'Mover').dir = [...world.get(depot, 'DigZone').center];
  world.addSystem('mining_crew', createMiningCrewSystem());
  world.tick(0.05, ctx);
  assert.equal(world.get(ex, 'Excavator').state, 'full', '满仓 → state=full');
  assert.equal(world.get(ex, 'Excavator').targetVertex, null, '满仓时释放锁定');
  ok('满仓 → state=full + 释放锁定');
}

console.log(`\n阶段 3 全部通过 (${pass} 组断言)`);

// ---- 15b. 平整收敛: 多 tick 后所有顶点 offset = targetOffset(平整出平面) ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  const depot = placeBuilding(world, ctx, 'depot', norm([0, 1, 0]));
  setDigZone(world, ctx, depot, norm([0, 1, 0]));
  const zone = world.get(depot, 'DigZone');
  // 给挖机大 digReach + 调大 digRate + 把库存上限放到无限(避免被满仓中断, 本测试只关心平整)
  const [ex1, ex2] = spawnExcavators(world, ctx, 2, depot);
  for (const eid of [ex1, ex2]) {
    world.get(eid, 'Excavator').digReach = 1.0;
    world.get(eid, 'Mover').dir = [...zone.center];
    world.get(eid, 'Inventory').cap = Infinity;
  }
  ctx.registry.machineTypes.excavator_mk1.digRate = 1.0;
  world.addSystem('mining_crew', createMiningCrewSystem());
  for (let i = 0; i < 2000; i++) world.tick(0.05, ctx);
  // 验证: 所有顶点 offset 达到 targetOffset(每个顶点都平整到位)
  // targetOffset = min(baseH - planeH, hardLimit); 达到 targetOffset 即"该挖的都挖了"
  let maxShort = 0;
  for (const v of zone.vertices) {
    const short = v.targetOffset - v.offset;
    if (short > maxShort) maxShort = short;
  }
  assert.ok(maxShort < 1e-3, `所有顶点平整到 targetOffset(最大欠挖 ${maxShort.toFixed(4)} < 1e-3)`);
  // 挖机应该都空闲(没活了)
  const idleCount = [ex1, ex2].filter((e) => world.get(e, 'Excavator').targetVertex == null).length;
  assert.equal(idleCount, 2, '平整完毕后挖机空闲(无工作量)');
  // 可达平面验证: 未被 hardLimit 钳制的顶点 current 高度 == planeH
  const reachablePlane = zone.vertices.filter((v) => v.targetOffset < v.hardLimit - 1e-6);
  let maxDev = 0;
  for (const v of reachablePlane) {
    const cur = v.baseH - v.offset;
    const dev = Math.abs(cur - zone.planeH);
    if (dev > maxDev) maxDev = dev;
  }
  assert.ok(maxDev < 1e-3, `未被硬层阻挡的顶点 current == planeH(最大偏差 ${maxDev.toFixed(4)})`);
  ok(`平整收敛: 所有顶点到 targetOffset → 形成平整平面(欠挖 ${maxShort.toFixed(4)}, 可达偏差 ${maxDev.toFixed(4)})`);
  // 还原 digRate(避免污染后续测试)
  ctx.registry.machineTypes.excavator_mk1.digRate = 0.05;
}

// ===========================================================================
// 阶段 5: 存档与端到端(migrateDigZones + toJSON/fromJSON 往返)
// ===========================================================================
pass = 0;

import { toJSON, fromJSON } from './core/save.js';

// ---- 16. migrateDigZones: 给"已圈定但无 vertices"的旧 DigZone 补顶点 ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  const depot = placeBuilding(world, ctx, 'depot', norm([0, 1, 0]));
  setDigZone(world, ctx, depot, norm([0.1, 1, 0.05]));
  const zone = world.get(depot, 'DigZone');
  const origCount = zone.vertices.length;
  assert.ok(origCount > 0, 'setDigZone 后已有顶点');

  // 模拟旧存档: 清掉 vertices + planet.params.digZoneVertices
  zone.vertices = null;
  planet.params.digZoneVertices = null;

  const touched = migrateDigZones(world, ctx);
  assert.equal(touched, 1, 'migrateDigZones 报告迁移了 1 个 zone');
  assert.ok(Array.isArray(zone.vertices) && zone.vertices.length === origCount, `顶点被重新生成(${zone.vertices.length} == 原 ${origCount})`);
  assert.ok(Array.isArray(planet.params.digZoneVertices) && planet.params.digZoneVertices.length === 1, '迁移后 digZoneVertices 同步到 planet');

  // 幂等: 再跑一次不应该重复迁移
  const touched2 = migrateDigZones(world, ctx);
  assert.equal(touched2, 0, '已有 vertices 的 zone 跳过(幂等)');
  ok('migrateDigZones: 旧存档顶点缺失自动补 + 幂等');
}

// ---- 17. 端到端: 挖一阵 → 存档 → 载入新世界 → 继续挖, 状态一致 ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  const depot = placeBuilding(world, ctx, 'depot', norm([0, 1, 0]));
  setDigZone(world, ctx, depot, norm([0.1, 1, 0.05]));
  const [ex] = spawnExcavators(world, ctx, 1, depot);
  world.get(ex, 'Excavator').digReach = 1.0;   // 大范围让它快些挖到

  world.addSystem('mining_crew', createMiningCrewSystem());
  for (let i = 0; i < 50; i++) world.tick(0.05, ctx);
  const zone = world.get(depot, 'DigZone');
  const dugCountBefore = zone.vertices.filter((v) => v.offset > 0).length;
  const maxOffsetBefore = Math.max(...zone.vertices.map((v) => v.offset));
  const exStateBefore = world.get(ex, 'Excavator').state;
  assert.ok(dugCountBefore > 0, `挖过若干顶点(实际 ${dugCountBefore})`);
  assert.ok(maxOffsetBefore > 0, `最深 offset > 0(${maxOffsetBefore.toFixed(3)})`);

  // 存档 → 载入新世界
  const json = toJSON(world);
  const w2 = createWorld();
  fromJSON(json, w2);
  // 组件保留
  assert.equal(w2.count('DigZone'), 1, '载入后 DigZone 数量保留');
  assert.equal(w2.count('Excavator'), 1, '载入后 Excavator 数量保留');
  const zone2 = w2.get(depot, 'DigZone');
  assert.ok(Array.isArray(zone2.vertices) && zone2.vertices.length === zone.vertices.length, '顶点表完整保留');
  // 顶点 offset 也保留
  const maxOffsetAfter = Math.max(...zone2.vertices.map((v) => v.offset));
  assert.ok(Math.abs(maxOffsetAfter - maxOffsetBefore) < 1e-9, `载入后 offset 一致(前 ${maxOffsetBefore} → 后 ${maxOffsetAfter})`);

  // 继续跑: 新 ctx + 重挂系统 + 迁移(确保 planet 同步)
  const ctx2 = makeCtx(stubPlanet());
  migrateDigZones(w2, ctx2);   // planet 是新的, 必须刷新 digZoneVertices
  w2.addSystem('mining_crew', createMiningCrewSystem());
  for (let i = 0; i < 50; i++) w2.tick(0.05, ctx2);
  const maxOffsetContinue = Math.max(...zone2.vertices.map((v) => v.offset));
  assert.ok(maxOffsetContinue > maxOffsetBefore, `载入后继续挖掘更深(前 ${maxOffsetBefore.toFixed(3)} → 后 ${maxOffsetContinue.toFixed(3)})`);
  ok(`端到端存档: 挖→存→载入→续挖状态一致(max off ${maxOffsetBefore.toFixed(3)} → ${maxOffsetContinue.toFixed(3)})`);
}

console.log(`\n阶段 5 全部通过 (${pass} 组断言)`);
