// M3 无头单测: 生产配方执行器 + 需求驱动物流全链(矿→冶炼→制造→仓库)。
// 运行:  node src/factory/test_m3.mjs

import assert from 'node:assert';
import { createWorld } from './core/world.js';
import { createRegistry } from './core/registry.js';
import { createSpatial } from './core/spatial.js';
import { createEventBus } from './core/events.js';
import { invTotal, invAdd } from './core/inventory.js';
import { createMiningSystem } from './systems/mining.js';
import { createLogisticsSystem, spawnHaulers } from './systems/logistics.js';
import { createProductionSystem, flattenStacks } from './systems/production.js';
import { placeBuilding } from './systems/placement.js';
import * as S from './core/sphere.js';
import gameData from './data/gamedata.js';

let pass = 0;
const ok = (n) => { pass++; console.log('  ✓', n); };

function stubPlanet() {
  return {
    params: { edits: [], radius: 100, maxHeight: 8, seaLevel: 0 },
    roots: [], _editPending: false,
    _buildNoise() {}, _invalidateAffected() {},
    heightAt() { return 0; },
    position: { x: 0, y: 0, z: 0 },
  };
}
function makeCtx(planet) {
  const registry = createRegistry().load(gameData).unlockAll();   // 测试: 解锁全部建筑(制造台等)
  return { planet, registry, spatial: createSpatial(), bus: createEventBus(), minerEdits: new Map() };
}

// ---- flattenStacks ----
{
  assert.deepEqual(flattenStacks([{ a: 1 }, { b: 2 }, { a: 3 }]), { a: 4, b: 2 });
  ok('flattenStacks 合并栈数组');
}

// ---- 生产: 缺料饿死 → 喂料后开工 → 产出铁锭; 消耗2矿产1锭 ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  const sm = placeBuilding(world, ctx, 'smelter', S.norm([0, 1, 0]));
  assert.ok(world.has(sm, 'Producer') && world.has(sm, 'Provider') && world.has(sm, 'Requester'), '冶炼炉有 Producer/Provider/Requester');
  const p = world.get(sm, 'Producer');
  const inv = world.get(sm, 'Inventory');
  assert.equal(p.recipeId, 'smelt_iron');

  world.addSystem('prod', createProductionSystem());

  // 无料 → starved
  world.tick(0.1, ctx);
  assert.equal(p.state, 'starved', '无输入 → 饿死');

  // 喂 10 铁矿 → 开工 → 应产出铁锭(每次 2 矿 → 1 锭, time 1.5s)
  invAdd(inv, 'iron_ore', 10);
  for (let i = 0; i < 40; i++) world.tick(0.1, ctx);   // 4s ≈ 2 次以上
  assert.ok((inv.items.iron_ingot || 0) >= 2, `产出铁锭(${inv.items.iron_ingot || 0})`);
  // 物料守恒: 每锭耗2矿; 消耗量 = 已产锭×2 (+ 可能有一次在制品占用的 2 矿)
  const ingots = inv.items.iron_ingot || 0;
  const oreLeft = inv.items.iron_ore || 0;
  const consumed = 10 - oreLeft;
  const inflight = consumed / 2 - ingots;   // 0 = 无在制; 1 = 有一次在制品
  assert.ok(consumed % 2 === 0 && (inflight === 0 || inflight === 1), `2矿→1锭 守恒(耗${consumed} 锭${ingots} 在制${inflight})`);
  ok('生产: 饿死→喂料→按配方产出(物料守恒)');
}

// ---- 需求驱动: 卡车把矿送进冶炼炉(Requester), 而非全丢仓库 ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();
  const minerDir = S.norm([0, 1, 0]);
  const miner = placeBuilding(world, ctx, 'miner', minerDir);
  const sm = placeBuilding(world, ctx, 'smelter', S.norm([0.25, 1, 0]));
  world.get(miner, 'Inventory').cap = 40;

  world.addSystem('mining', createMiningSystem());
  world.addSystem('logistics', createLogisticsSystem());
  spawnHaulers(world, ctx, 2, 'hauler_mk1', minerDir);

  const smInv = world.get(sm, 'Inventory');
  let fed = false;
  for (let i = 0; i < 1500 && !fed; i++) { world.tick(0.05, ctx); if ((smInv.items.iron_ore || 0) > 0 || (smInv.items.overburden || 0) > 0 || (smInv.items.stone || 0) > 0) fed = true; }
  assert.ok(fed, '卡车把矿料送进了冶炼炉(Requester 优先)');
  ok('需求驱动: 卡车优先喂生产建筑');
}

// ---- 全链: 矿 → 冶炼(铁锭) → 制造(铁板) → 仓库 ----
{
  const planet = stubPlanet();
  const ctx = makeCtx(planet);
  const world = createWorld();

  // 找一个含铁方向, 让矿机能挖到 iron_ore
  let ironDir = null;
  const { oreColumn, layerAt } = await import('./ore.js');
  for (let i = 0; i < 800 && !ironDir; i++) {
    const d = S.norm([Math.sin(i * 1.1) + 0.3, Math.cos(i * 0.7) + 1.5, Math.sin(i * 0.37) - 0.2]);
    if (layerAt(oreColumn(d, gameData.ore), 0.3).item === 'iron_ore') ironDir = d;
  }
  assert.ok(ironDir, '找到含铁方向');

  const miner = placeBuilding(world, ctx, 'miner', ironDir);
  const smelter = placeBuilding(world, ctx, 'smelter', S.randInCap(ironDir, 0.12));
  const assembler = placeBuilding(world, ctx, 'assembler', S.randInCap(ironDir, 0.18));
  const store = placeBuilding(world, ctx, 'warehouse', S.randInCap(ironDir, 0.24));
  world.get(miner, 'Inventory').cap = 60;

  world.addSystem('mining', createMiningSystem());
  world.addSystem('prod', createProductionSystem());
  world.addSystem('logistics', createLogisticsSystem());
  spawnHaulers(world, ctx, 5, 'hauler_mk1', ironDir);

  const storeInv = world.get(store, 'Inventory');
  const smInv = world.get(smelter, 'Inventory');
  const asInv = world.get(assembler, 'Inventory');

  let sawIngot = false, sawPlate = false;
  for (let i = 0; i < 6000; i++) {
    world.tick(0.05, ctx);   // 300s 模拟
    if ((smInv.items.iron_ingot || 0) > 0 || (asInv.items.iron_ingot || 0) > 0 || (storeInv.items.iron_ingot || 0) > 0) sawIngot = true;
    if ((asInv.items.iron_plate || 0) > 0 || (storeInv.items.iron_plate || 0) > 0) sawPlate = true;
    if ((storeInv.items.iron_plate || 0) > 0) break;
  }
  assert.ok(sawIngot, '链条产出了铁锭');
  assert.ok(sawPlate, '链条产出了铁板');
  assert.ok((storeInv.items.iron_plate || 0) > 0, `铁板送达仓库(${(storeInv.items.iron_plate || 0).toFixed(1)})`);
  ok('全链: 矿→冶炼(铁锭)→制造(铁板)→仓库');
}

console.log(`\nM3 全部通过 (${pass} 组断言)`);
