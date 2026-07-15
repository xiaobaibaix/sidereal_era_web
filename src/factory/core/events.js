// 事件总线(Observer) —— 跨系统解耦。
// 用途: 科技解锁、建造完成、发动机点火等广播, 让系统之间不用互相直接引用。
// 纯 JS, 零依赖。

export function createEventBus() { return new EventBus(); }

class EventBus {
  constructor() { this._map = new Map(); }   // type -> Set(fn)

  // 订阅; 返回取消订阅函数
  on(type, fn) {
    let set = this._map.get(type);
    if (!set) { set = new Set(); this._map.set(type, set); }
    set.add(fn);
    return () => set.delete(fn);
  }
  // 只触发一次
  once(type, fn) {
    const off = this.on(type, (p) => { off(); fn(p); });
    return off;
  }
  emit(type, payload) {
    const set = this._map.get(type);
    if (!set) return;
    for (const fn of [...set]) fn(payload);   // 拷贝一份, 允许回调里增删订阅
  }
  clear() { this._map.clear(); }
}
