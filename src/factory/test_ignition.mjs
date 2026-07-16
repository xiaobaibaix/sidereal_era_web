// M7 无头单测: 行星发动机点火与推力(纯逻辑; 反应质量→F=ṁ·ve→反作用推行星)。
// 运行:  node src/factory/test_ignition.mjs

import assert from 'node:assert';
import { createWorld } from './core/world.js';
import { createRegistry } from './core/registry.js';
import { createSpatial } from './core/spatial.js';
import { createEventBus } from './core/events.js';
import { invAdd, invTotal } from './core/inventory.js';
import { createEngineSystem, burnFuel } from './systems/engine.js';
import { placeBuilding } from './systems/placement.js';
import * as S from './core/sphere.js';
import gameData from './data/gamedata.js';

let pass = 0;
const ok = (n) => { pass++; console.log('  ✓', n); };

function stubPlanet() {
  return { params: { edits: [], radius: 100, maxHeight: 8, seaLevel: 0 }, roots: [], _editPending: false, _buildNoise() {}, _invalidateAffected() {}, heightAt() { return 0; }, baseHeightAt() { return 0; }, position: { x: 0, y: 0, z: 0 } };
}
function makeCtx(planet) {
  const registry = createRegistry().load(gameData).unlock(['engine_site']);
  return { planet, registry, spatial: createSpatial(), bus: createEventBus(), planetMass: 1e6 };
}
// 放一台"已建成"的发动机(跳过建造流程)
function builtEngine(world, ctx, dir) {
  const e = placeBuilding(world, ctx, 'engine_site', dir);
  const con = world.get(e, 'Construction');
  con.done = true; con.built = true;
  return e;
}

// ---- burnFuel: 优先 fuelItems, 也烧任意剩余; 返回实际烧量 ----
{
  const inv = { items: { overburden: 5, iron_ore: 3 }, cap: 100 };
  const burned = burnFuel(inv, 6, ['overburden']);
  assert.ok(Math.abs(burned - 6) < 1e-9, '烧掉 6');
  assert.ok(Math.abs((inv.items.overburden || 0) - 0) < 1e-9, '废土先烧光(5)');
  assert.ok(Math.abs((inv.items.iron_ore || 0) - 2) < 1e-9, '再从铁矿补 1 → 剩 2');
  ok('burnFuel 优先废料 + 烧任意剩余');
}

// ---- 未点火 → 无推力 ----
{
  const ctx = makeCtx(stubPlanet());
  const world = createWorld();
  const e = builtEngine(world, ctx, S.norm([0, 1, 0]));
  invAdd(world.get(e, 'Inventory'), 'overburden', 1000);
  world.addSystem('engine', createEngineSystem());
  world.tick(0.05, ctx);
  assert.equal(world.get(e, 'Construction').burn, 'off', '未点火 → off');
  assert.equal(ctx.engine.totalThrust, 0, '未点火无推力');
  ok('未点火不产生推力');
}

// ---- 点火 + 有料 → 推力>0 且沿 -发动机方向; 燃料被消耗 ----
{
  const ctx = makeCtx(stubPlanet());
  const world = createWorld();
  const e = builtEngine(world, ctx, S.norm([0, 1, 0]));
  const inv = world.get(e, 'Inventory');
  invAdd(inv, 'overburden', 1000);
  world.get(e, 'Construction').ignited = true;
  world.addSystem('engine', createEngineSystem());
  const before = invTotal(inv);
  world.tick(0.05, ctx);
  const con = world.get(e, 'Construction');
  assert.equal(con.burn, 'burning', '点火有料 → burning');
  // F = ṁ·ve = (burnRate)·ve = 40·60 = 2400
  assert.ok(Math.abs(con.thrust - 2400) < 1, `推力 F=ṁ·ve≈2400 (=${con.thrust.toFixed(0)})`);
  assert.ok(ctx.engine.net[1] < 0, '发动机朝 +y → 行星受 -y 反作用');
  assert.ok(Math.abs(ctx.engineAcc[1] - (-2400 / 1e6)) < 1e-9, '加速度 = 净力/行星质量');
  assert.ok(before - invTotal(inv) > 0, '燃料被消耗');
  // 建成点火后应向物流索取燃料
  assert.ok((world.get(e, 'Requester').needs.overburden || 0) > 0, '索取废土作燃料');
  ok('点火产生推力(F=ṁ·ve, 反作用 -dir) + 烧料 + 索燃料');
}

// ---- 无料 → flameout, 推力0 ----
{
  const ctx = makeCtx(stubPlanet());
  const world = createWorld();
  const e = builtEngine(world, ctx, S.norm([0, 1, 0]));
  world.get(e, 'Construction').ignited = true;   // 点火但库存空
  world.addSystem('engine', createEngineSystem());
  world.tick(0.05, ctx);
  assert.equal(world.get(e, 'Construction').burn, 'flameout', '无料 → flameout');
  assert.equal(ctx.engine.totalThrust, 0, 'flameout 无推力');
  ok('无燃料 → 熄火(flameout)无推力');
}

// ---- 两台同向 → 合推更强(约 2×) ----
{
  const ctx = makeCtx(stubPlanet());
  const world = createWorld();
  const d = S.norm([0, 1, 0]);
  for (let i = 0; i < 2; i++) { const e = builtEngine(world, ctx, S.randInCap(d, 0.02)); invAdd(world.get(e, 'Inventory'), 'overburden', 1000); world.get(e, 'Construction').ignited = true; }
  world.addSystem('engine', createEngineSystem());
  world.tick(0.05, ctx);
  assert.equal(ctx.engine.burning, 2, '两台都在烧');
  assert.ok(Math.abs(ctx.engine.totalThrust - 4800) < 2, `合推≈2×2400=4800 (=${ctx.engine.totalThrust.toFixed(0)})`);
  ok('多台同向合推更强');
}

console.log(`\nM7 点火 全部通过 (${pass} 组断言)`);
