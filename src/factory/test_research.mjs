// M5 无头单测: 科技/发展度(研究站 → dev → 解锁科技 → 建筑放置受锁 gate)。
// 运行:  node src/factory/test_research.mjs

import assert from 'node:assert';
import { createWorld } from './core/world.js';
import { createRegistry } from './core/registry.js';
import { createSpatial } from './core/spatial.js';
import { createEventBus } from './core/events.js';
import { invAdd } from './core/inventory.js';
import { createResearchSystem } from './systems/research.js';
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

// ---- 初始解锁状态: 制造台锁, 冶炼炉/矿场开放 ----
{
  const ctx = makeCtx(stubPlanet());
  assert.equal(ctx.registry.isUnlocked('smelter'), true, '冶炼炉初始解锁');
  assert.equal(ctx.registry.isUnlocked('depot'), true, '矿场初始解锁');
  assert.equal(ctx.registry.isUnlocked('assembler'), false, '制造台初始锁定');
  ok('初始解锁状态正确');
}

// ---- 锁定 gate: 未解锁不能放制造台 ----
{
  const ctx = makeCtx(stubPlanet());
  const world = createWorld();
  const a = placeBuilding(world, ctx, 'assembler', S.norm([0, 1, 0]));
  assert.equal(a, null, '未解锁 → placeBuilding 返回 null');
  ok('锁定建筑放置被拒');
}

// ---- 研究站消耗铁锭 → dev 上升 → 装配技术解锁 → 可放制造台 ----
{
  const ctx = makeCtx(stubPlanet());
  const world = createWorld();
  const lab = placeBuilding(world, ctx, 'lab', S.norm([0, 1, 0]));
  assert.ok(lab && world.has(lab, 'Lab') && world.has(lab, 'Requester'), '研究站有 Lab/Requester');
  invAdd(world.get(lab, 'Inventory'), 'iron_ingot', 100);   // 直接喂料(跳过物流)
  world.addSystem('research', createResearchSystem());

  // 未到阈值前: dev 上升但 assembly 未解锁
  world.tick(0.05, ctx);
  assert.ok(ctx.colony.dev > 0, 'dev 开始上升');
  assert.equal(ctx.registry.isUnlocked('assembler'), false, '刚开始未解锁装配');

  // 持续研究直到 dev≥40 (inRate2 devPerUnit1 → 2/s; 100 锭够 20s → dev 上限 100)
  for (let i = 0; i < 600; i++) world.tick(0.05, ctx);
  assert.ok(ctx.colony.dev >= 40, `dev 达到阈值(${ctx.colony.dev.toFixed(0)})`);
  assert.ok(ctx.colony.researched.has('assembly'), 'assembly 科技已研究');
  assert.equal(ctx.registry.isUnlocked('assembler'), true, '装配技术解锁 → 制造台可用');

  // 现在能放制造台了
  const a = placeBuilding(world, ctx, 'assembler', S.norm([0.2, 1, 0]));
  assert.ok(a != null, '解锁后可放置制造台');
  ok('研究站→发展度→解锁装配技术→可放制造台');
}

// ---- dev 有上限于投入(料耗尽 dev 不再涨) + 守恒 ----
{
  const ctx = makeCtx(stubPlanet());
  const world = createWorld();
  const lab = placeBuilding(world, ctx, 'lab', S.norm([0, 1, 0]));
  invAdd(world.get(lab, 'Inventory'), 'iron_ingot', 30);
  world.addSystem('research', createResearchSystem());
  for (let i = 0; i < 400; i++) world.tick(0.05, ctx);
  assert.ok(Math.abs(ctx.colony.dev - 30) < 1e-6, `30 锭 → dev 30 (devPerUnit1, =${ctx.colony.dev.toFixed(2)})`);
  assert.equal(world.get(lab, 'Lab').state, 'starved', '料耗尽 → 研究站缺料');
  ok('发展度受投入约束(料耗尽即停)');
}

console.log(`\nM5 科技 全部通过 (${pass} 组断言)`);
