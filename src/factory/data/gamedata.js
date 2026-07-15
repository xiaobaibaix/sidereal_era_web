// 游戏数据(数据驱动的内容层) —— 物品 / 分层矿柱 / 机种 / 建筑。
// 用 JS 模块而非 .json: 允许注释、免 import assertion、浏览器/node 都能直接 import。
// 加内容基本只改这里。

export const items = {
  overburden: { name: '废土', stack: 200, tags: ['waste'], color: 0x6b5a45 },
  stone: { name: '石头', stack: 200, color: 0x808088 },
  iron_ore: { name: '铁矿', stack: 100, tags: ['ore'], color: 0xb0663c },
  copper_ore: { name: '铜矿', stack: 100, tags: ['ore'], color: 0x2e8f6f },
};

// 分层矿柱: 从地表往下按"挖掘深度(与 applyEdit 的 depth 同单位, 0..~2)"分层。
// 带 noise 的层: 该方向噪声 < threshold 时退回 fallback(即那里没这种矿, 挖到的是石头)。
// hardness: 需要 machineType.hardnessMax >= 此值才挖得动(科技/机种进阶 gate)。
export const ore = {
  fallback: 'stone',
  layers: [
    { item: 'overburden', d: [0.0, 0.12], hardness: 1 },                                              // 表土
    { item: 'iron_ore', d: [0.12, 0.5], hardness: 2, noise: { freq: 1.0, seed: 11, threshold: 0.45 }, fallback: 'stone' },
    { item: 'copper_ore', d: [0.5, 0.9], hardness: 3, noise: { freq: 1.3, seed: 23, threshold: 0.50 }, fallback: 'stone' },
    { item: 'stone', d: [0.9, 3.0], hardness: 3 },                                                     // 深层基岩(硬)
  ],
};

export const machineTypes = {
  // kind=miner: 驻扎啃地形; digRate=每秒挖深(depth 单位); hardnessMax=可挖硬度; yield=每 depth 单位产出数量
  miner_mk1: { kind: 'miner', mesh: 'miner', tier: 1, digRate: 0.05, hardnessMax: 2, yield: 100, power: 30 },
  // kind=hauler: 卡车 agent, 在矿机↔仓库间搬运; speed=表面速度; cap=运力
  hauler_mk1: { kind: 'hauler', mesh: 'truck', tier: 1, speed: 22, cap: 100, power: 10 },
};

export const buildings = {
  miner: { name: '采矿机 Mk1', kind: 'miner', machine: 'miner_mk1', mesh: 'miner', digRadius: 0.03, cap: 500 },
  warehouse: { name: '仓库', kind: 'storage', mesh: 'warehouse', cap: 5000 },
};

export const gameData = { items, ore, machineTypes, buildings };
export default gameData;
