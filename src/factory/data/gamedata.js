// 游戏数据(数据驱动的内容层) —— 物品 / 分层矿柱 / 机种 / 建筑。
// 用 JS 模块而非 .json: 允许注释、免 import assertion、浏览器/node 都能直接 import。
// 加内容基本只改这里。

export const items = {
  overburden: { name: '废土', stack: 200, tags: ['waste'], color: 0x6b5a45 },
  stone: { name: '石头', stack: 200, color: 0x808088 },
  iron_ore: { name: '铁矿', stack: 100, tags: ['ore'], color: 0xb0663c },
  copper_ore: { name: '铜矿', stack: 100, tags: ['ore'], color: 0x2e8f6f },
  // 冶炼/制造产物(M3 生产链)
  iron_ingot: { name: '铁锭', stack: 100, tags: ['ingot'], color: 0xd8d2cc },
  copper_ingot: { name: '铜锭', stack: 100, tags: ['ingot'], color: 0xd98b52 },
  iron_plate: { name: '铁板', stack: 100, tags: ['part'], color: 0xa9b4c2 },
};

// 配方(数据驱动生产) —— in/out 是 { 物品: 数量 } 栈的数组; time=每次产出耗时(秒); building=可执行的建筑类型。
export const recipes = {
  smelt_iron: { name: '冶炼铁锭', in: [{ iron_ore: 2 }], out: [{ iron_ingot: 1 }], time: 1.5, building: 'smelter', power: 90 },
  smelt_copper: { name: '冶炼铜锭', in: [{ copper_ore: 2 }], out: [{ copper_ingot: 1 }], time: 1.5, building: 'smelter', power: 90 },
  make_plate: { name: '压制铁板', in: [{ iron_ingot: 2 }], out: [{ iron_plate: 1 }], time: 2.0, building: 'assembler', power: 120 },
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
  // kind=producer: 按配方把输入变输出(M3)
  smelter_mk1: { kind: 'producer', mesh: 'smelter', tier: 1, power: 90 },
  assembler_mk1: { kind: 'producer', mesh: 'assembler', tier: 1, power: 120 },
};

export const buildings = {
  miner: { name: '采矿机 Mk1', kind: 'miner', machine: 'miner_mk1', mesh: 'miner', digRadius: 0.03, cap: 500 },
  warehouse: { name: '仓库', kind: 'storage', mesh: 'warehouse', cap: 5000 },
  // 生产建筑: recipe=默认配方; recipes=可选配方列表; cap=库存(输入缓冲+输出); bufferMult=输入缓冲维持的配方份数
  smelter: { name: '冶炼炉', kind: 'producer', machine: 'smelter_mk1', mesh: 'smelter', recipe: 'smelt_iron', recipes: ['smelt_iron', 'smelt_copper'], cap: 300, bufferMult: 6 },
  assembler: { name: '制造台', kind: 'producer', machine: 'assembler_mk1', mesh: 'assembler', recipe: 'make_plate', recipes: ['make_plate'], cap: 300, bufferMult: 6 },
};

export const gameData = { items, ore, recipes, machineTypes, buildings };
export default gameData;
