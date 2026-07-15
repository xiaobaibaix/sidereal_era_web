// ECS World —— 行星工厂系统的模拟核心。
// 纯数据 + 逻辑, 零 three.js 依赖 → 可 node 无头单测 / 可进 Web Worker。
//
// 设计:
//   - 实体(entity) = 一个正整数 id。
//   - 组件(component) = 挂在 id 上的纯数据对象; 存储用 "Map<组件名, Map<eid, data>>"(简单、可序列化)。
//   - 系统(system) = 每 tick 按加入顺序执行的函数 fn(world, dt, ctx)。
//   - 一切可序列化 → 存档 = 序列化组件快照, 系统在 load 后由代码重新 addSystem。
// 性能不够时再换 SoA / typed array, 但对外 API 不变。

export function createWorld() { return new World(); }

class World {
  constructor() {
    this._next = 1;                 // 下一个实体 id
    this._alive = new Set();        // 活跃实体
    this._comps = new Map();        // 组件名 -> Map(eid -> data)
    this._systems = [];             // { name, fn }
    this.time = 0;                  // 累计模拟时间(秒)
    this.tickCount = 0;
  }

  // ---- 实体 ----
  create() { const e = this._next++; this._alive.add(e); return e; }
  destroy(e) {
    if (!this._alive.has(e)) return;
    for (const store of this._comps.values()) store.delete(e);
    this._alive.delete(e);
  }
  alive(e) { return this._alive.has(e); }
  get entityCount() { return this._alive.size; }

  // ---- 组件 ----
  _store(comp) {
    let s = this._comps.get(comp);
    if (!s) { s = new Map(); this._comps.set(comp, s); }
    return s;
  }
  add(e, comp, data = {}) { this._store(comp).set(e, data); return data; }
  remove(e, comp) { const s = this._comps.get(comp); if (s) s.delete(e); }
  get(e, comp) { const s = this._comps.get(comp); return s ? s.get(e) : undefined; }
  has(e, comp) { const s = this._comps.get(comp); return !!s && s.has(e); }
  count(comp) { const s = this._comps.get(comp); return s ? s.size : 0; }

  // ---- 查询 ----
  // 遍历"同时拥有全部 comps"的实体。以最小的组件仓为驱动 → 高效。
  *query(...comps) {
    if (comps.length === 0) { yield* this._alive; return; }
    let base = null, baseComp = null;
    for (const c of comps) {
      const s = this._comps.get(c);
      if (!s || s.size === 0) return;                 // 有组件无实体 → 结果空
      if (!base || s.size < base.size) { base = s; baseComp = c; }
    }
    outer: for (const e of base.keys()) {
      for (const c of comps) {
        if (c === baseComp) continue;
        const s = this._comps.get(c);
        if (!s || !s.has(e)) continue outer;
      }
      yield e;
    }
  }
  // 便捷遍历: 回调收到 (eid, dataOfComp0, dataOfComp1, ...)
  each(comps, fn) {
    for (const e of this.query(...comps)) {
      const args = [e];
      for (const c of comps) args.push(this._comps.get(c).get(e));
      fn(...args);
    }
  }

  // ---- 系统 / tick ----
  addSystem(name, fn) { this._systems.push({ name, fn }); return this; }
  removeSystem(name) { this._systems = this._systems.filter((s) => s.name !== name); return this; }
  tick(dt, ctx) {
    for (const sys of this._systems) sys.fn(this, dt, ctx);
    this.time += dt;
    this.tickCount++;
  }

  // ---- 序列化(纯数据; 系统不入档, load 后由代码重新注册) ----
  serialize() {
    const comps = {};
    for (const [comp, store] of this._comps) {
      const obj = {};
      for (const [e, data] of store) obj[e] = data;
      comps[comp] = obj;
    }
    return { next: this._next, alive: [...this._alive], time: this.time, tickCount: this.tickCount, comps };
  }
  load(snap) {
    if (!snap) return this;
    this._next = snap.next || 1;
    this._alive = new Set(snap.alive || []);
    this.time = snap.time || 0;
    this.tickCount = snap.tickCount || 0;
    this._comps = new Map();
    const comps = snap.comps || {};
    for (const comp in comps) {
      const store = new Map();
      const obj = comps[comp];
      for (const e in obj) store.set(Number(e), obj[e]);
      this._comps.set(comp, store);
    }
    return this;
  }
}
