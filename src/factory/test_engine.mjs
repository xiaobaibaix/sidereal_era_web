// M6 无头单测: 行星发动机分阶段建造(选址平整→骨架→核心→调试→建成)。
// 运行:  node src/factory/test_engine.mjs

import assert from 'node:assert';
import { createWorld } from './core/world.js';
import { createRegistry } from './core/registry.js';
import { createSpatial } from './core/spatial.js';
import { createEventBus } from './core/events.js';
import { invAdd } from './core/inventory.js';
import { createConstructionSystem } from './systems/construction.js';
import { placeBuilding } from './systems/placement.js';
import * as S from './core/sphere.js';
import gameData from './data/gamedata.js';

let pass = 0;
const ok = (n) => { pass++; console.log('  ✓', n); };

function stubPlanet() {
  return { params: { edits: [], radius: 100, maxHeight: 8, seaLevel: 0 }, roots: [], _editPending: false, _buildNoise() {}, _invalidateAffected() {}, heightAt() { return 0; }, baseHeightAt() { return 0; }, position: { x: 0, y: 0, z: 0 } };
}
function makeCtx(planet) {
  const registry = createRegistry().load(gameData);
  return { planet, registry, spatial: createSpatial(), bus: createEventBus() };
}

// ---- 科技锁: 未研究 planet_engine 不能放发动机 ----
{
  const ctx = makeCtx(stubPlanet());
  const world = createWorld();
  assert.equal(ctx.registry.isUnlocked('engine_site'), false, '发动机初始锁定');
  const e = placeBuilding(world, ctx, 'engine_site', S.norm([0, 1, 0]));
  assert.equal(e, null, '未解锁 → 放置返回 null');
  ok('发动机受科技锁(planet_engine)');
}

// ---- 分阶段建造全流程: 计时 → 投料 → 计时 → 建成 ----
{
  const ctx = makeCtx(stubPlanet());
  ctx.registry.unlock(['engine_site']);   // 模拟已研究行星发动机科技
  const world = createWorld();
  const eng = placeBuilding(world, ctx, 'engine_site', S.norm([0, 1, 0]));
  assert.ok(eng && world.has(eng, 'Construction') && world.has(eng, 'Requester'), '发动机有 Construction/Requester');
  let builtEvt = null;
  ctx.bus.on('engine_built', (p) => { builtEvt = p; });

  world.addSystem('construction', createConstructionSystem());
  const proj = world.get(eng, 'Construction');
  const inv = world.get(eng, 'Inventory');
  const req = world.get(eng, 'Requester');

  // 阶段0 site(计时 8s): 投料阶段前 needs 空
  world.tick(0.05, ctx);
  assert.equal(proj.stage, 0, '始于选址平整');
  assert.deepEqual(req.needs, {}, '平整阶段不需建材');
  for (let i = 0; i < 200; i++) world.tick(0.05, ctx);   // 10s > 8s
  assert.equal(proj.stage, 1, '平整完成 → 进入骨架');

  // 阶段1 frame(投料 iron_plate:120): needs 反映剩余; 送料后进阶
  world.tick(0.05, ctx);
  assert.ok(req.needs.iron_plate > 0, '骨架阶段请求铁板');
  invAdd(inv, 'iron_plate', 50);
  world.tick(0.05, ctx);
  assert.ok(Math.abs(req.needs.iron_plate - 70) < 1e-6, `送 50 → 还需 70 (=${req.needs.iron_plate})`);
  assert.equal(proj.stage, 1, '未齐不进阶');
  invAdd(inv, 'iron_plate', 70);   // 补齐 120
  world.tick(0.05, ctx);
  assert.equal(proj.stage, 2, '骨架建材齐 → 进入核心组装');

  // 阶段2 core(投料 iron_plate:200)
  invAdd(inv, 'iron_plate', 200);
  world.tick(0.05, ctx);
  assert.equal(proj.stage, 3, '核心建材齐 → 进入调试');

  // 阶段3 commission(计时 10s) → 建成
  assert.equal(proj.built, false, '调试前未建成');
  for (let i = 0; i < 240; i++) world.tick(0.05, ctx);   // 12s > 10s
  assert.equal(proj.done, true, '全部阶段完成');
  assert.equal(proj.built, true, '发动机建成(未点火)');
  assert.ok(builtEvt && builtEvt.eid === eng, '广播 engine_built 事件');
  ok('分阶段建造: 平整→骨架→核心→调试→建成');
}

console.log(`\nM6 行星发动机 全部通过 (${pass} 组断言)`);
