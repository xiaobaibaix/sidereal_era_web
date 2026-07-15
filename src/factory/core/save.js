// 存档 —— world.serialize() 的持久化封装(localStorage / JSON 文件)。纯数据 + 版本号 + 迁移点。

const VERSION = 1;

// world(+可选 extra 数据, 如 spatial 快照) → 一个可存的快照对象
export function snapshot(world, extra = {}) {
  return { version: VERSION, savedAt: Date.now(), world: world.serialize(), ...extra };
}

// 把快照写进目标 world(+可选处理 extra)。返回 snap.version 之类的元信息。
export function restore(snap, world) {
  if (!snap || !snap.world) return null;
  // 迁移点: if (snap.version < VERSION) migrate(snap);
  world.load(snap.world);
  return { version: snap.version, savedAt: snap.savedAt };
}

export function saveToLocal(key, world, extra = {}) {
  try { localStorage.setItem(key, JSON.stringify(snapshot(world, extra))); return true; }
  catch (e) { return false; }   // 隐私模式 / 无 localStorage(如 node)
}
export function loadFromLocal(key, world) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return restore(JSON.parse(raw), world);
  } catch (e) { return null; }
}

export function toJSON(world, extra = {}) { return JSON.stringify(snapshot(world, extra)); }
export function fromJSON(json, world) { return restore(JSON.parse(json), world); }
