// M4 无头单测: 电力(输电塔覆盖 + 发电机 + 并查集组网 + 缺电降速)。
// 运行:  node src/factory/test_power.mjs

import assert from 'node:assert';
import { createWorld } from './core/world.js';
import { createRegistry } from './core/registry.js';
import { createSpatial } from './core/spatial.js';
import { createEventBus } from './core/events.js';
import { invAdd } from './core/inventory.js';
import { createPowerSystem } from './systems/power.js';
import { createProductionSystem } from './systems/production.js';
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
const seedOre = (world, sm, amt = 100) => invAdd(world.get(sm, 'Inventory'), 'iron_ore', amt);

// ---- 无供电: 冶炼炉 no_power, 不产出 ----
{
  const ctx = makeCtx(stubPlanet());
  const world = createWorld();
  const sm = placeBuilding(world, ctx, 'smelter', S.norm([0, 1, 0]));
  assert.ok(world.has(sm, 'PowerNeed'), '冶炼炉有 PowerNeed');
  seedOre(world, sm);
  world.addSystem('power', createPowerSystem());
  world.addSystem('prod', createProductionSystem());
  for (let i = 0; i < 100; i++) world.tick(0.05, ctx);
  assert.equal(world.get(sm, 'PowerNeed').sat, 0, '未覆盖 → sat 0');
  assert.equal(world.get(sm, 'Producer').state, 'no_power', '无电 → no_power');
  assert.ok(!world.get(sm, 'Inventory').items.iron_ingot, '无电不产出铁锭');
  ok('无供电: 冶炼炉停机(no_power)');
}

// ---- 输电塔 + 发电机覆盖 → 满电产出 ----
{
  const ctx = makeCtx(stubPlanet());
  const world = createWorld();
  const sm = placeBuilding(world, ctx, 'smelter', S.norm([0, 1, 0]));
  placeBuilding(world, ctx, 'power_tower', S.norm([0.05, 1, 0]));   // 覆盖冶炼炉(demand 90)
  placeBuilding(world, ctx, 'generator', S.norm([0.09, 1, 0]));     // output 200, 被塔覆盖
  seedOre(world, sm);
  world.addSystem('power', createPowerSystem());
  world.addSystem('prod', createProductionSystem());
  for (let i = 0; i < 100; i++) world.tick(0.05, ctx);
  assert.equal(world.get(sm, 'PowerNeed').sat, 1, '供>需 → sat 1');
  assert.ok((world.get(sm, 'Inventory').items.iron_ingot || 0) > 0, '满电 → 产出铁锭');
  ok('输电塔+发电机 → 满电产出');
}

// ---- 供电不足 → sat≈供/需, 降速(比满电产得少) ----
{
  const mk = (genOut) => {
    const ctx = makeCtx(stubPlanet());
    const world = createWorld();
    const sm = placeBuilding(world, ctx, 'smelter', S.norm([0, 1, 0]));   // demand 90
    placeBuilding(world, ctx, 'power_tower', S.norm([0.05, 1, 0]));
    const g = placeBuilding(world, ctx, 'generator', S.norm([0.09, 1, 0]));
    world.get(g, 'PowerGen').output = genOut;
    seedOre(world, sm, 120);
    world.addSystem('power', createPowerSystem());
    world.addSystem('prod', createProductionSystem());
    for (let i = 0; i < 400; i++) world.tick(0.05, ctx);
    return { sat: world.get(sm, 'PowerNeed').sat, ingots: world.get(sm, 'Inventory').items.iron_ingot || 0 };
  };
  const half = mk(45);   // 45/90 = 0.5
  const full = mk(200);
  assert.ok(Math.abs(half.sat - 0.5) < 1e-6, `半供电 sat≈0.5 (=${half.sat})`);
  assert.ok(half.ingots > 0 && half.ingots < full.ingots, `缺电降速: 半电 ${half.ingots} < 满电 ${full.ingots}`);
  ok('供电不足 → 缺电降速');
}

// ---- 两塔覆盖相交并网: 发电在 A 塔侧, 用电在 B 塔侧, 仍供电 ----
{
  const ctx = makeCtx(stubPlanet());
  const world = createWorld();
  // range 0.14, 两塔角距 ~0.22 < 0.28(0.14+0.14) → 并网
  const tA = S.norm([0, 1, 0]);
  const tB = S.norm([0.224, 1, 0]);
  placeBuilding(world, ctx, 'power_tower', tA);
  placeBuilding(world, ctx, 'power_tower', tB);
  placeBuilding(world, ctx, 'generator', S.norm([0.03, 1, 0.02]));   // 覆盖于 A
  const sm = placeBuilding(world, ctx, 'smelter', S.norm([0.224, 1, 0.03]));   // 覆盖于 B
  seedOre(world, sm);
  world.addSystem('power', createPowerSystem());
  world.addSystem('prod', createProductionSystem());
  for (let i = 0; i < 100; i++) world.tick(0.05, ctx);
  assert.equal(world.get(sm, 'PowerNeed').sat, 1, '跨塔并网供电 → sat 1');
  assert.ok((world.get(sm, 'Inventory').items.iron_ingot || 0) > 0, '并网后 B 侧冶炼炉产出');
  ok('两塔并网: A 发电供 B 用电');
}

console.log(`\nM4 电力 全部通过 (${pass} 组断言)`);
