// 行星发动机点火/推力系统(M7) —— 已建成的发动机点火后燃烧物质产生推力, 反作用推动行星。
//   燃料 = 任意反应质量(优先废土/石头, 也可烧矿石/锭); 由物流送进发动机库存(建成后转索取燃料)。
//   推力 F = ṁ·ve(质量流量 × 排气速度)。每台发动机把废料沿 +自身方向喷出 → 反作用推行星沿 -方向。
//   净推力 = Σ Fᵢ·(-dirᵢ); 行星加速度 = 净推力 / 行星质量, 写入 ctx.engineAcc, 并经 ctx.applyThrust
//   钩子交给 nbody(solar_system 里把它加到聚焦行星 body.externalAcc → 轨道被推动)。
// 纯逻辑(数组数学), 可 node 单测。

export function createEngineSystem() {
  return function engineSystem(world, dt, ctx) {
    const reg = ctx.registry;
    const net = [0, 0, 0];        // 净推力(力), 世界坐标
    let burning = 0, totalThrust = 0;

    for (const e of world.query('Construction', 'Anchor')) {
      const con = world.get(e, 'Construction');
      if (!con.built) continue;
      const b = reg.buildings[world.get(e, 'Building').typeId] || {};
      const req = world.get(e, 'Requester');

      // 建成后: 请求燃料(废料等) → 物流把废土送进来
      if (req) {
        if (con.ignited) { req.needs = fuelNeeds(b); }
        else req.needs = {};
      }

      con.thrust = 0;
      if (!con.ignited) { con.burn = 'off'; continue; }

      const inv = world.get(e, 'Inventory');
      const rate = b.burnRate || 30;
      const ve = b.exhaust || 50;
      // 无限燃料(调试): 恒定燃烧, 不消耗库存; 否则从库存烧反应质量
      const burned = ctx.infiniteFuel ? rate * dt : burnFuel(inv, rate * dt, b.fuelItems);
      if (burned <= 1e-9) { con.burn = 'flameout'; continue; }   // 点了火但没料

      con.burn = 'burning';
      const mdot = burned / dt;          // 实际质量流量
      const F = mdot * ve;               // 推力大小
      con.thrust = F;
      totalThrust += F; burning++;
      const d = world.get(e, 'Anchor').dir;   // 发动机方向(废料朝 +d 喷) → 行星受 -d 反作用
      net[0] -= F * d[0]; net[1] -= F * d[1]; net[2] -= F * d[2];
    }

    const M = ctx.planetMass || 1e6;
    const acc = [net[0] / M, net[1] / M, net[2] / M];
    ctx.engine = { net, acc, burning, totalThrust };
    ctx.engineAcc = acc;
    if (ctx.applyThrust) ctx.applyThrust(acc);   // 接 nbody(solar); planet_system 为占位/显示
  };
}

// 每台发动机的燃料请求(建成点火后向物流索取的反应质量缓冲)
// 索取"全部可燃反应质量"(废土/石头稀少, 必须也拉常见的矿石作燃料, 否则永远缺料熄火)。
// burnFuel 会按 fuelItems 顺序优先烧废料, 所以废料仍会被优先消耗。
function fuelNeeds(b) {
  const buf = b.fuelBuffer || 400;
  const items = (b.fuelItems && b.fuelItems.length) ? b.fuelItems : ['overburden'];
  const needs = {};
  for (const it of items) needs[it] = buf;
  return needs;
}

// 从库存烧掉至多 amount 质量的反应物(优先 fuelItems 顺序, 其余任意物质也烧)。返回实际烧掉量。
export function burnFuel(inv, amount, fuelItems) {
  let remaining = amount, burned = 0;
  const take = (it) => {
    if (remaining <= 1e-9) return;
    const have = inv.items[it] || 0;
    if (have <= 0) return;
    const t = Math.min(have, remaining);
    const left = have - t;
    if (left <= 1e-9) delete inv.items[it]; else inv.items[it] = left;
    burned += t; remaining -= t;
  };
  for (const it of (fuelItems || [])) take(it);
  if (remaining > 1e-9) for (const it of Object.keys(inv.items)) take(it);   // 烧任意剩余物质
  return burned;
}
