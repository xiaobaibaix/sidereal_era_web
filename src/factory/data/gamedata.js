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
  fallback: 'iron_ore',   // 缺省到处都有铁 → 任意点位挖开表土后都能持续供矿(冶炼不断供)
  layers: [
    { item: 'overburden', d: [0.0, 0.06], hardness: 1 },                                              // 薄表土(快速剥离)
    { item: 'iron_ore', d: [0.06, 0.8], hardness: 1 },                                                 // 浅层铁矿(遍布); mk1 挖到 0.8 后在此持续产铁
    { item: 'copper_ore', d: [0.8, 1.6], hardness: 3, noise: { freq: 1.1, seed: 23, threshold: 0.5 }, fallback: 'iron_ore' },  // 铜脉(成片), 需 mk2(hardnessMax≥3)
    { item: 'stone', d: [1.6, 3.0], hardness: 3 },                                                     // 深层基岩(需 mk2)
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
  // kind=excavator: 在矿场挖掘区里啃地形产矿, 存入自身缓冲(cap); mine truck 再运到矿场
  // 逐顶点挖掘(B升级): digReach=挖掘臂角半径(挖机能挖多远); digStep=单次目标降低量(视觉上"一点点")
  excavator_mk1: { kind: 'excavator', mesh: 'excavator', tier: 1, digRate: 0.05, hardnessMax: 2, yield: 100, speed: 16, cap: 60, power: 30, digReach: 0.025, digStep: 0.02 },
  // kind=minetruck: 采矿卡车, 把挖机缓冲运进矿场
  mine_truck_mk1: { kind: 'minetruck', mesh: 'truck', tier: 1, speed: 22, cap: 80, power: 10 },
  // ---- 物流升级(B系列): 传送带 / 分拣器 / 分流器 ----
  // kind=belt: 一段测地线弧上的单向 FIFO 物品流。speed=物品前进速度(角/秒); spacing=物品最小间距(角)。
  belt_mk1: { kind: 'belt', mesh: 'belt', tier: 1, speed: 0.15, spacing: 0.006 },
  // kind=inserter: 分拣臂, 在相邻两端点间按 rate 搬运单个物品。filterable=可过滤(sorter 版)。
  inserter_mk1: { kind: 'inserter', mesh: 'inserter', tier: 1, rate: 4 },
  sorter_mk1: { kind: 'inserter', mesh: 'sorter', tier: 1, rate: 4, filterable: true },
  // kind=splitter: 分流器, 带的合流/分流/按物品路由节点。
  splitter_mk1: { kind: 'splitter', mesh: 'splitter', tier: 1, rate: 8 },
};

export const buildings = {
  // 矿场: 被动容器。覆盖范围内的挖掘区被自动绑定; 生成挖机(挖) + 采矿卡车(运)后才会存入矿石; 下游物流卡车再从这里取货。
  // coverageRadius=矿场对**独立放置的挖掘区**的覆盖角半径; 覆盖内的区都可被该矿场的挖机开采。
  // digResolution=挖掘区顶点网格间距(角弧度); 越小越细越贵。zoneRadius=挖掘区角半径。footprint=网格建造占地。
  depot: { name: '矿场', kind: 'depot', mesh: 'depot', cap: 2000, coverageRadius: 0.16, zoneRadius: 0.05, digResolution: 0.005, footprint: [3, 3] },
  // 挖掘区(独立放置): 在矿场 coverageRadius 内即可被该矿场覆盖。多对多 — 一个区可被多个矿场覆盖, 一个矿场可覆盖多个区。
  dig_zone: { name: '挖掘区', kind: 'digzone', mesh: 'digZone', zoneRadius: 0.05, digResolution: 0.005 },
  miner: { name: '采矿机 Mk1', kind: 'miner', machine: 'miner_mk1', mesh: 'miner', digRadius: 0.03, cap: 500 },   // 旧直挖矿机(遗留, UI 已改用矿场)
  warehouse: { name: '仓库', kind: 'storage', mesh: 'warehouse', cap: 5000, footprint: [2, 2] },
  // 建造平台(网格建造): 平整一块圆区(terrain level 编辑)并生成网格球, 在其中吸附放置建筑。cell=格边长(世界单位), radius=角半径。
  build_pad: { name: '建造平台', kind: 'buildpad', mesh: 'build_pad', cell: 3.0, radius: 0.06 },
  // 生产建筑: recipe=默认配方; recipes=可选配方列表; cap=库存(输入缓冲+输出); bufferMult=输入缓冲维持的配方份数
  // footprint=[w,h] 网格占位(格), 缺省 1x1
  smelter: { name: '冶炼炉', kind: 'producer', machine: 'smelter_mk1', mesh: 'smelter', recipe: 'smelt_iron', recipes: ['smelt_iron', 'smelt_copper'], cap: 300, bufferMult: 6, power: 90, footprint: [2, 2] },
  // 制造台: 科技锁(需"装配技术")。
  assembler: { name: '制造台', kind: 'producer', machine: 'assembler_mk1', mesh: 'assembler', recipe: 'make_plate', recipes: ['make_plate'], cap: 300, bufferMult: 6, power: 120, locked: true, footprint: [2, 2] },
  // 电力(M4): 输电塔覆盖一片区域(range=角半径), 覆盖内建筑自动接入; 塔与塔覆盖相交则并入同一电网。
  power_tower: { name: '输电塔', kind: 'tower', mesh: 'tower', range: 0.14 },
  generator: { name: '风力发电机', kind: 'generator', mesh: 'generator', output: 200 },
  // 研究站(M5): 消耗铁锭 → 提升殖民地发展度(简化"科技水平"占位)。发展度到阈值解锁科技。
  lab: { name: '研究站', kind: 'lab', mesh: 'lab', input: 'iron_ingot', inRate: 2, devPerUnit: 1, cap: 100, bufferMult: 10, footprint: [2, 2] },
  // 行星发动机(M6): 科技锁(planet_engine)。分阶段建造 —— 选址平整→骨架投料→核心投料→调试 → 建成(未点火, M7 点火)。
  //   type: 'level'/'commission' = 计时阶段; 'build'/'assemble' = 投料阶段(in 由物流送达并被吸收)。
  engine_site: {
    name: '行星发动机', kind: 'engine', mesh: 'engine', locked: true, cap: 1000,
    stages: [
      { id: 'site', name: '选址平整', type: 'level', time: 8, radius: 0.05 },
      { id: 'frame', name: '骨架搭建', type: 'build', in: { iron_plate: 120 } },
      { id: 'core', name: '核心组装', type: 'assemble', in: { iron_plate: 200 } },
      { id: 'commission', name: '调试', type: 'commission', time: 10 },
    ],
    // 点火(M7): 燃烧任意反应质量(优先废土/石头), F = ṁ·ve。反作用推行星沿 -发动机方向。
    // 燃烧任意原始物质(废料优先, 但废料稀少 → 也烧常见矿石)。不烧铁锭/铁板(留给科研/建造)。
    burnRate: 40, exhaust: 60, fuelBuffer: 300, fuelItems: ['overburden', 'stone', 'iron_ore', 'copper_ore'],
  },
  // ---- 物流升级(B系列): 传送带 / 分拣器 / 分流器 / 运输站 ----
  // 传送带: 两点放置(from/to), 弧长 length 决定 cap; 近距离贴地流动。科技锁(logistics_belts)。
  belt: { name: '传送带', kind: 'belt', machine: 'belt_mk1', mesh: 'belt', locked: true },
  // 分拣器: 吸附到"最近带段 + 最近建筑口", 在带↔机器/仓库/站之间搬运。科技锁(logistics_belts)。
  inserter: { name: '分拣器', kind: 'inserter', machine: 'inserter_mk1', mesh: 'inserter', locked: true },
  // 分拣器(过滤版): 只搬指定物品(filter)。科技锁(freight_stations)。
  sorter: { name: '过滤分拣器', kind: 'inserter', machine: 'sorter_mk1', mesh: 'sorter', filterable: true, locked: true },
  // 分流器: 带的合流/分流/按物品路由节点。科技锁(logistics_belts)。
  splitter: { name: '分流器', kind: 'splitter', machine: 'splitter_mk1', mesh: 'splitter', locked: true },
  // 装货站: 缓冲仓 + 对卡车表现为 Provider(远距离运输起点)。带/分拣器填它, 卡车从它取货。科技锁(freight_stations)。
  load_station: { name: '装货站', kind: 'loadstation', mesh: 'station_load', cap: 1000, locked: true, footprint: [3, 3] },
  // 卸货站: 缓冲仓 + 对卡车表现为 Requester(远距离运输终点)。卡车卸进它, 带/分拣器取走送下游。科技锁(freight_stations)。
  unload_station: { name: '卸货站', kind: 'unloadstation', mesh: 'station_unload', cap: 1000, locked: true, footprint: [3, 3] },
};

// 科技(M5): 发展度(dev)到阈值(+可选 builtAny)自动解锁; unlock 列出解锁的建筑/配方 id。
export const tech = {
  assembly: { name: '装配技术', require: { dev: 40 }, unlock: { buildings: ['assembler'], recipes: ['make_plate'] } },
  planet_engine: { name: '行星发动机', require: { dev: 150, builtAny: ['assembler'] }, unlock: { buildings: ['engine_site'] } },   // engine_site 于 M6 加入
  // 物流升级(B系列): 近距离传送带 → 远距离运输站。
  logistics_belts: { name: '传送带物流', require: { dev: 20 }, unlock: { buildings: ['belt', 'inserter', 'splitter'] } },
  freight_stations: { name: '货运站', require: { dev: 60 }, unlock: { buildings: ['load_station', 'unload_station', 'sorter'] } },
};

export const gameData = { items, ore, recipes, machineTypes, buildings, tech };
export default gameData;
