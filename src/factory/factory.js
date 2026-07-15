// 门面(Facade) —— 把 ECS world + 注册表 + 事件总线 + 空间索引 组装成一个给 App 用的对象。
// M0 只有核心(纯逻辑, 无 three.js); 系统(M1+)通过 world.addSystem 注册, 渲染(M1+)另接。
//
// 用法(App 侧):
//   import { createFactory } from '../../src/factory/factory.js';
//   const factory = createFactory({ planet, data });
//   // animate 里固定步长:
//   //   acc += dt; while (acc >= FIXED) { factory.tick(FIXED); acc -= FIXED; }

import { createWorld } from './core/world.js';
import { createRegistry } from './core/registry.js';
import { createEventBus } from './core/events.js';
import { createSpatial } from './core/spatial.js';

export function createFactory({ planet = null, data = null } = {}) {
  const world = createWorld();
  const registry = createRegistry();
  if (data) registry.load(data);
  const bus = createEventBus();
  const spatial = createSpatial();

  // 系统在 tick 时能拿到的运行期依赖
  const ctx = { planet, registry, bus, spatial };

  return {
    world, registry, bus, spatial, ctx,
    setPlanet(p) { ctx.planet = p; },
    loadData(d) { registry.load(d); },
    addSystem(name, fn) { world.addSystem(name, fn); return this; },
    tick(dt) { world.tick(dt, ctx); },
    serialize() { return world.serialize(); },
    load(snap) { world.load(snap); },
  };
}
