// 数据注册表(数据驱动的核心) —— 物品/机种/配方/建筑/科技/矿层 都在这里。
// 加内容 = 往 data/*.json 里加条目并 load(), 不改引擎。纯 JS, 零依赖。

export function createRegistry() { return new Registry(); }

const CATS = ['items', 'machineTypes', 'recipes', 'buildings', 'tech'];

class Registry {
  constructor() {
    for (const c of CATS) this[c] = {};   // id -> def
    this.ore = { layers: [] };            // 分层矿柱规则(见 oreColumn)
    this.unlocked = new Set();            // 已解锁的建筑/配方 id(locked 的须经科技解锁)
  }

  // 合并加载一批数据(可多次调用叠加)
  load(data) {
    if (!data) return this;
    for (const c of CATS) if (data[c]) Object.assign(this[c], data[c]);
    if (data.ore) this.ore = data.ore;
    this._initUnlocked();
    this.validate();
    return this;
  }

  // 非 locked 的建筑/配方默认解锁; locked 的等科技解锁
  _initUnlocked() {
    for (const id in this.buildings) if (!this.buildings[id].locked) this.unlocked.add(id);
    for (const id in this.recipes) if (!this.recipes[id].locked) this.unlocked.add(id);
  }
  isUnlocked(id) { return this.unlocked.has(id); }
  unlock(ids) { for (const id of (ids || [])) this.unlocked.add(id); return this; }
  unlockAll() { for (const id in this.buildings) this.unlocked.add(id); for (const id in this.recipes) this.unlocked.add(id); return this; }

  // 某建筑类型可用的配方对象数组
  recipesFor(buildingTypeId) {
    const b = this.buildings[buildingTypeId];
    const ids = (b && b.recipes) || [];
    return ids.map((id) => this.recipes[id]).filter(Boolean);
  }

  // 轻校验: 引用完整性(缺失只 warn, 不抛 —— 方便边开发边加数据)
  validate() {
    const warn = (m) => { if (typeof console !== 'undefined') console.warn('[registry] ' + m); };
    for (const id in this.recipes) {
      const r = this.recipes[id];
      for (const stack of [...(r.in || []), ...(r.out || [])]) {
        for (const item in stack) if (!this.items[item]) warn(`配方 ${id} 引用未知物品: ${item}`);
      }
      if (r.building && !this.buildings[r.building]) warn(`配方 ${id} 引用未知建筑: ${r.building}`);
    }
    for (const id in this.buildings) {
      for (const rid of (this.buildings[id].recipes || [])) {
        if (!this.recipes[rid]) warn(`建筑 ${id} 引用未知配方: ${rid}`);
      }
    }
    for (const l of (this.ore.layers || [])) {
      if (l.item && !this.items[l.item]) warn(`矿层引用未知物品: ${l.item}`);
    }
    return this;
  }
}
