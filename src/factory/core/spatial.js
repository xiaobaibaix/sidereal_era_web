// 球面空间索引 —— 按"单位方向"存实体, 支持球冠(角半径)范围查询与最近查询。
// 用途: 建造重叠检测、输电塔覆盖、物流就近、点击拾取后找附近实体等。
// 方向用普通数组 [x,y,z](单位向量), 零 three.js 依赖 → 可 node 单测。
//
// M0 先用线性扫描(正确、简单); 实体量大时把内部换成经纬分桶即可, 对外 API 不变。

export function createSpatial() { return new Spatial(); }

class Spatial {
  constructor() { this.dirs = new Map(); }   // eid -> [x,y,z]

  insert(eid, dir) { this.dirs.set(eid, [dir[0], dir[1], dir[2]]); }
  move(eid, dir) { this.insert(eid, dir); }
  remove(eid) { this.dirs.delete(eid); }
  get size() { return this.dirs.size; }

  // 角半径 angRadius(弧度)内的实体 → 追加进 out 并返回
  queryCap(dir, angRadius, out = []) {
    const cosR = Math.cos(angRadius);
    const x = dir[0], y = dir[1], z = dir[2];
    for (const [eid, d] of this.dirs) {
      if (x * d[0] + y * d[1] + z * d[2] >= cosR) out.push(eid);
    }
    return out;   // TODO(perf): 经纬分桶, 只扫相邻桶
  }

  // 最近实体(可选 filter(eid)->bool)
  nearest(dir, filter) {
    let best = null, bestDot = -2;
    const x = dir[0], y = dir[1], z = dir[2];
    for (const [eid, d] of this.dirs) {
      if (filter && !filter(eid)) continue;
      const dot = x * d[0] + y * d[1] + z * d[2];
      if (dot > bestDot) { bestDot = dot; best = eid; }
    }
    return best;
  }

  // 序列化(可并入存档; 也可 load 后由放置数据重建)
  serialize() { const o = {}; for (const [e, d] of this.dirs) o[e] = d; return o; }
  load(obj) { this.dirs = new Map(); for (const e in (obj || {})) this.dirs.set(Number(e), obj[e]); return this; }
}
