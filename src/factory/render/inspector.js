// 建筑/agent 属性面板(点击查看) —— 纯 DOM, 与 three.js 解耦。
// 点击建筑/运输车 → show(eid); 每帧 update() 刷新数值(状态/速度/进度/库存)。
// 图标复用 Dyson Sphere Program 素材(src/assets/icons/individual/Vanilla/webp)。
// 注: 开发服务器禁用缓存, 故图片元素常驻复用(不每帧重建 <img>), 避免闪烁。

import { invTotal } from '../core/inventory.js';

const ICON_BASE = '/src/assets/icons/individual/Vanilla/webp/';
const ITEM_ICON = {
  overburden: 'soil-pile', stone: 'stone-ore', iron_ore: 'iron-ore', copper_ore: 'copper-ore',
  iron_ingot: 'iron-plate', copper_ingot: 'copper-plate', iron_plate: 'steel-plate',
};
const MESH_ICON = { miner: 'mining-drill', smelter: 'smelter', assembler: 'assembler-1', warehouse: 'storage-1', truck: 'logistic-drone', depot: 'storage-tank', excavator: 'mining-drill' };

const MINER_STATE = { mining: '开采中', full: '满仓待运', blocked: '受阻(需更高级钻机)', idle: '空闲' };
const PROD_STATE = { working: '生产中', starved: '缺原料', output_full: '产物已满', idle: '空闲' };
const HAUL_STATE = { idle: '待命', to_src: '前往取货', load: '装载中', to_sink: '前往卸货', unload: '卸货中' };
const EXCA_STATE = { digging: '开采中', to_zone: '前往挖点', full: '满仓待运', idle: '空闲(未圈定挖掘区?)' };
const MINETRUCK_STATE = { idle: '待命', to_exca: '前往挖机', load: '装载中', to_depot: '运往矿场', unload: '卸货中' };
const STATE_COLOR = { mining: '#ffc040', working: '#ffc040', digging: '#ff8a2d', load: '#ffc040', full: '#66cc66', to_sink: '#66cc66', unload: '#66cc66', to_depot: '#9c6b3f', to_src: '#5ab0ff', to_exca: '#ffe27a', to_zone: '#ffd24a', starved: '#d0704f', blocked: '#d0413f', output_full: '#5ab0ff', idle: '#8a8f98' };

const itemIconUrl = (id) => (ITEM_ICON[id] ? ICON_BASE + ITEM_ICON[id] + '.webp' : null);
const meshIconUrl = (m) => (MESH_ICON[m] ? ICON_BASE + MESH_ICON[m] + '.webp' : null);

export function createInspector({ getWorld, registry }) {
  const itemName = (id) => (registry.items[id] && registry.items[id].name) || id;

  const el = document.createElement('div');
  el.style.cssText = [
    'position:fixed', 'left:50%', 'top:50%', 'transform:translate(-50%,-50%)', 'z-index:40', 'display:none',
    'min-width:260px', 'max-width:340px', 'padding:14px 16px',
    'background:rgba(18,20,26,0.94)', 'backdrop-filter:blur(8px)',
    'border:1px solid rgba(255,255,255,0.14)', 'border-radius:12px',
    'color:#e8eaed', 'font:12px/1.5 -apple-system,system-ui,sans-serif',
    'box-shadow:0 12px 40px rgba(0,0,0,0.55)', 'user-select:none',
  ].join(';');

  // 头部: 图标 + 名称/类型 + 关闭
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:8px;';
  const icon = document.createElement('img');
  icon.style.cssText = 'width:40px;height:40px;object-fit:contain;image-rendering:auto;flex:0 0 auto;';
  const titleWrap = document.createElement('div');
  titleWrap.style.cssText = 'flex:1 1 auto;min-width:0;';
  const title = document.createElement('div');
  title.style.cssText = 'font-size:14px;font-weight:600;';
  const sub = document.createElement('div');
  sub.style.cssText = 'font-size:11px;color:#9aa0a8;';
  titleWrap.append(title, sub);
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = 'flex:0 0 auto;background:none;border:none;color:#9aa0a8;font-size:15px;cursor:pointer;padding:2px 4px;';
  closeBtn.onclick = () => api.hide();
  head.append(icon, titleWrap, closeBtn);

  const stat = document.createElement('div');   // 纯文本数值区(每帧可安全重建 innerHTML)
  const recipeWrap = document.createElement('div');  // 配方图标行(show 时建一次)
  recipeWrap.style.cssText = 'display:none;align-items:center;gap:4px;flex-wrap:wrap;margin:6px 0;padding:6px;background:rgba(255,255,255,0.04);border-radius:6px;';
  const invTitle = document.createElement('div');
  invTitle.style.cssText = 'font-size:11px;color:#9aa0a8;margin:6px 0 3px;';
  const invWrap = document.createElement('div');   // 库存行(增量复用)
  invWrap.style.cssText = 'display:flex;flex-direction:column;gap:3px;';

  el.append(head, stat, recipeWrap, invTitle, invWrap);
  document.body.appendChild(el);

  let eid = null;
  const invRows = new Map();   // itemId -> { row, amt }

  function smallIcon(url, size = 18) {
    const img = document.createElement('img');
    img.style.cssText = `width:${size}px;height:${size}px;object-fit:contain;vertical-align:middle;flex:0 0 auto;`;
    if (url) img.src = url; else img.style.visibility = 'hidden';
    return img;
  }

  // 配方行(输入 → 输出), show 时构建一次
  function buildRecipeRow(recipe) {
    recipeWrap.innerHTML = '';
    if (!recipe) { recipeWrap.style.display = 'none'; return; }
    const addStack = (stacks) => stacks.forEach((s) => {
      for (const it in s) {
        recipeWrap.appendChild(smallIcon(itemIconUrl(it)));
        const t = document.createElement('span'); t.textContent = `×${s[it]}`; t.style.marginRight = '4px';
        recipeWrap.appendChild(t);
      }
    });
    addStack(recipe.in || []);
    const arrow = document.createElement('span'); arrow.textContent = '→'; arrow.style.cssText = 'margin:0 4px;color:#9aa0a8;';
    recipeWrap.appendChild(arrow);
    addStack(recipe.out || []);
    recipeWrap.style.display = 'flex';
  }

  // 库存行增量更新(避免每帧重建 <img> 造成闪烁)
  function syncInventory(items) {
    const seen = new Set();
    for (const id in items) {
      if (items[id] <= 1e-6) continue;
      seen.add(id);
      let r = invRows.get(id);
      if (!r) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:6px;';
        const ic = smallIcon(itemIconUrl(id));
        const nm = document.createElement('span'); nm.textContent = itemName(id); nm.style.cssText = 'flex:1 1 auto;color:#c8ccd2;';
        const am = document.createElement('span'); am.style.cssText = 'font-variant-numeric:tabular-nums;color:#e8eaed;';
        row.append(ic, nm, am);
        invWrap.appendChild(row);
        r = { row, am };
        invRows.set(id, r);
      }
      r.am.textContent = Math.round(items[id]);
    }
    for (const [id, r] of invRows) if (!seen.has(id)) { r.row.remove(); invRows.delete(id); }
  }

  function clearInventory() { for (const [, r] of invRows) r.row.remove(); invRows.clear(); }

  const api = {
    el,
    show(id) {
      const world = getWorld();
      if (id == null || !world.alive(id)) { api.hide(); return; }
      eid = id;
      clearInventory();
      // 头部图标/名称
      const b = world.get(id, 'Building');
      const ag = world.get(id, 'Agent');
      const meshName = (b && b.mesh) || (ag && ag.mesh) || 'miner';
      const iu = meshIconUrl(meshName);
      if (iu) { icon.src = iu; icon.style.display = ''; } else icon.style.display = 'none';
      let name = '建筑', kind = '';
      if (b) { const def = registry.buildings[b.typeId]; name = (def && def.name) || b.typeId; kind = def ? kindLabel(def.kind) : ''; }
      else if (ag) { name = { excavator: '挖机', minetruck: '采矿卡车', hauler: '物流卡车' }[ag.kind] || '运输车'; kind = '采矿小队'; }
      title.textContent = name;
      sub.textContent = kind;
      // 配方行(生产建筑)
      const prod = world.get(id, 'Producer');
      buildRecipeRow(prod ? registry.recipes[prod.recipeId] : null);
      el.style.display = '';
      api.update();
    },
    hide() { eid = null; el.style.display = 'none'; },
    selected() { return eid; },
    update() {
      if (eid == null) return;
      const world = getWorld();
      if (!world.alive(eid)) { api.hide(); return; }

      const miner = world.get(eid, 'Miner');
      const depot = world.get(eid, 'Depot');
      const zone = world.get(eid, 'DigZone');
      const excavator = world.get(eid, 'Excavator');
      const minetruck = world.get(eid, 'MineTruck');
      const prod = world.get(eid, 'Producer');
      const storage = world.get(eid, 'Storage');
      const hauler = world.get(eid, 'Hauler');
      const inv = world.get(eid, 'Inventory');
      const lines = [];
      const stateLine = (label, s, map) => `<div style="margin:2px 0"><span style="color:#9aa0a8">${label}</span> <b style="color:${STATE_COLOR[s] || '#e8eaed'}">${(map && map[s]) || s}</b></div>`;
      const kv = (k, v) => `<div style="margin:2px 0"><span style="color:#9aa0a8">${k}</span> <span style="font-variant-numeric:tabular-nums">${v}</span></div>`;

      if (depot) {
        // 矿场: 挖掘区状态 + 绑定的挖机/采矿车数
        let exc = 0, mtk = 0;
        for (const e of world.query('Excavator')) if (world.get(e, 'Excavator').depot === eid) exc++;
        for (const e of world.query('MineTruck')) if (world.get(e, 'MineTruck').depot === eid) mtk++;
        const hasZone = zone && zone.center;
        lines.push(kv('挖掘区', hasZone ? `已圈定 (深度 ${zone.depth.toFixed(2)})` : '<b style="color:#d0704f">未圈定</b>'));
        lines.push(kv('挖机 / 采矿车', `${exc} / ${mtk}`));
        if (!hasZone) lines.push('<div style="color:#d0704f;margin:2px 0">圈定挖掘区并生成挖机+采矿车后开始产矿</div>');
        else if (exc === 0 || mtk === 0) lines.push('<div style="color:#d0704f;margin:2px 0">还需生成挖机与采矿车才会进货</div>');
      } else if (excavator) {
        const mt = registry.machineTypes[excavator.typeId] || {};
        const rate = (mt.digRate || 0) * (mt.yield || 0);
        lines.push(stateLine('状态', excavator.state, EXCA_STATE));
        lines.push(kv('开采速度', `${rate.toFixed(1)} /秒`));
        if (excavator.lastItem) lines.push(kv('当前产物', itemName(excavator.lastItem)));
      } else if (minetruck) {
        lines.push(stateLine('状态', minetruck.state, MINETRUCK_STATE));
        const cargo = minetruck.cargoAmt > 0 ? `${itemName(minetruck.cargoItem)} ${Math.round(minetruck.cargoAmt)} / ${minetruck.cap}` : `空 / ${minetruck.cap}`;
        lines.push(kv('载货', cargo));
      } else if (miner) {
        const mt = registry.machineTypes[miner.typeId] || {};
        const rate = (mt.digRate || 0) * (mt.yield || 0);
        lines.push(stateLine('状态', miner.state, MINER_STATE));
        lines.push(kv('开采速度', `${rate.toFixed(1)} /秒`));
        lines.push(kv('已挖深度', miner.dugDepth.toFixed(2)));
        if (miner.lastItem) lines.push(kv('当前产物', itemName(miner.lastItem)));
      } else if (prod) {
        const recipe = registry.recipes[prod.recipeId] || {};
        const pct = recipe.time ? Math.min(100, (prod.progress / recipe.time) * 100) : 0;
        lines.push(stateLine('状态', prod.state, PROD_STATE));
        lines.push(kv('配方', recipe.name || prod.recipeId));
        lines.push(`<div style="margin:4px 0;height:8px;background:rgba(255,255,255,0.1);border-radius:4px;overflow:hidden"><div style="height:100%;width:${pct.toFixed(0)}%;background:#ffc040;transition:width .1s"></div></div>`);
      } else if (hauler) {
        lines.push(stateLine('状态', hauler.state, HAUL_STATE));
        const cargo = hauler.cargoAmt > 0 ? `${itemName(hauler.cargoItem)} ${Math.round(hauler.cargoAmt)} / ${hauler.cap}` : `空 / ${hauler.cap}`;
        lines.push(kv('载货', cargo));
      }
      if (inv) {
        const cap = inv.cap == null || inv.cap === Infinity ? '∞' : inv.cap;
        lines.push(kv(storage ? '容量' : '库存量', `${Math.round(invTotal(inv))} / ${cap}`));
      }
      stat.innerHTML = lines.join('');
      invTitle.textContent = inv ? '库存' : '';
      invTitle.style.display = inv ? '' : 'none';
      if (inv) syncInventory(inv.items); else clearInventory();
    },
    dispose() { el.remove(); },
  };
  return api;
}

function kindLabel(kind) {
  return { depot: '矿场', miner: '采矿', producer: '生产', storage: '存储' }[kind] || kind || '';
}
