// 电力系统(M4) —— 输电塔覆盖 + 塔塔并查集组网 + 每 tick 供需满足率。
//   输电塔(PowerTower): 覆盖以自身为中心、角半径 range 的一片区域。覆盖内的发电机/用电建筑自动接入。
//   两塔覆盖相交(角距 ≤ range_a + range_b) → 并入同一电网(union-find)。
//   每个电网: 满足率 sat = min(1, 供电总量 / 用电总量)。未被任何塔覆盖的用电建筑 sat = 0。
//   下游: production 读用电建筑的 PowerNeed.sat 降速/停(缺电)。挖矿不耗电(移动柴油机)。
// 纯逻辑(不依赖 three.js) → 可 node 单测。

import { dot } from '../core/sphere.js';

const ang = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b))));

export function createPowerSystem() {
  return function powerSystem(world, dt, ctx) {
    const towers = [];
    for (const e of world.query('PowerTower', 'Anchor')) towers.push({ e, dir: world.get(e, 'Anchor').dir, range: world.get(e, 'PowerTower').range });
    const gens = [];
    for (const e of world.query('PowerGen', 'Anchor')) gens.push({ e, dir: world.get(e, 'Anchor').dir, output: world.get(e, 'PowerGen').output });
    const needs = [];
    for (const e of world.query('PowerNeed', 'Anchor')) { const c = world.get(e, 'PowerNeed'); needs.push({ e, dir: world.get(e, 'Anchor').dir, comp: c }); }

    // 并查集: 覆盖相交的塔并网
    const parent = towers.map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
    for (let i = 0; i < towers.length; i++) {
      for (let j = i + 1; j < towers.length; j++) {
        if (ang(towers[i].dir, towers[j].dir) <= towers[i].range + towers[j].range) union(i, j);
      }
    }
    // 覆盖某方向的塔下标(取最近的一个); 未覆盖返回 -1
    const coveringTower = (d) => {
      let best = -1, bestA = Infinity;
      for (let i = 0; i < towers.length; i++) { const a = ang(d, towers[i].dir); if (a <= towers[i].range && a < bestA) { bestA = a; best = i; } }
      return best;
    };

    const supply = {}, demand = {};
    for (const g of gens) { const ti = coveringTower(g.dir); if (ti >= 0) { const r = find(ti); supply[r] = (supply[r] || 0) + g.output; } }
    const needRoot = [];
    for (const n of needs) { const ti = coveringTower(n.dir); const r = ti >= 0 ? find(ti) : -1; if (r >= 0) demand[r] = (demand[r] || 0) + (n.comp.demand || 0); needRoot.push({ n, r }); }

    const gridSat = (r) => {
      const d = demand[r] || 0, s = supply[r] || 0;
      return d <= 0 ? 1 : Math.min(1, s / d);
    };
    for (const { n, r } of needRoot) n.comp.sat = r < 0 ? 0 : gridSat(r);

    // 渲染用连线 + inspector 用电网信息
    const links = [];
    for (let i = 0; i < towers.length; i++) {
      for (let j = i + 1; j < towers.length; j++) {
        if (ang(towers[i].dir, towers[j].dir) <= towers[i].range + towers[j].range) links.push([towers[i].dir, towers[j].dir]);
      }
    }
    for (const g of gens) { const ti = coveringTower(g.dir); if (ti >= 0) links.push([towers[ti].dir, g.dir]); }
    for (const n of needs) { const ti = coveringTower(n.dir); if (ti >= 0) links.push([towers[ti].dir, n.dir]); }

    const towerGrid = new Map();
    for (let i = 0; i < towers.length; i++) { const r = find(i); towerGrid.set(towers[i].e, { supply: supply[r] || 0, demand: demand[r] || 0, sat: gridSat(r) }); }

    ctx.power = { links, towerGrid, towerCount: towers.length, genCount: gens.length };
  };
}
