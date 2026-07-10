# 太阳系 · 真实大尺度渲染方案(方案 A)

> 目标:让太阳系里的行星能到 **1e6 米级(~1000 km 半径)**、轨道半径用公式算出来的**超大距离**也能正常渲染,而**不改任何 shader**、不破坏已完成的近距三件套(大气 / 云 / 海洋)。
>
> 相关文件:`three_planet/solar_system/main.js`(全部改动都在这里)。物理内核 `nbody.js`、渲染 pass `effects.js` **无需改动**。

---

## 1. 问题本质

- 物理已经是 **float64**(`nbody.js` 用 `THREE.Vector3`,分量是 JS number = double)→ 大绝对坐标本身不丢精度。
- **浮动原点**:每帧把所有天体减去"聚焦天体"的位置,聚焦天体落在渲染原点,相机绕它转 → 聚焦点附近的渲染坐标很小。
- 真正卡住大尺度的只有渲染的两件事:
  1. **相机 far 太小**:原来 `near=0.5 / far=20000`,半径 1e6 的行星、1e7~1e8 的轨道根本进不了这个范围。
  2. **深度精度(z-fighting)**:要同时看清近处行星表面 + 远处别的天体,near/far 跨度可能到 1e7:1,标准 24 位深度会在中远处打架。
- **float32 顶点精度不是主要问题**:聚焦行星表面顶点离渲染原点约 = 半径,1e6 处 float32 精度 ~0.12 m,对 1000 km 的星球肉眼无感(见 §6 注意事项)。

---

## 2. 为什么选方案 A(对比)

| 方案 | 做法 | 风险 |
|---|---|---|
| **A 动态 near/far**(选中) | 每帧按"相机到聚焦天体距离 + 场景最远天体"重算 near/far | 最低。**零 shader 改动**,大气/云/海洋 pass 用 `camera.projectionMatrix` 自动跟随 |
| B 对数深度 | `logarithmicDepthBuffer:true` | 高。大气/云 pass 的深度重建假设标准 NDC 深度,会失效 → 要改共享 shader;自定义 ShaderMaterial 要加 logdepth chunk;可能掉性能 |
| C 渲染坐标归一化 | 所有渲染坐标 ÷ 聚焦半径 | 高。要同时缩放 位置/LOD几何/大气半径/云壳/海洋/相机/轨道线/粒子,且 LOD 内部距离阈值会和缩放打架 |

**关键洞察**:透视投影的深度精度天然集中在**近平面**。浮动原点让聚焦行星永远在原点、相机绕它 → 聚焦行星总在近处 → 精度极好;其它天体在远处(屏幕上的小圆点)精度差但**看不出来**。所以 A 足够。

---

## 3. 方案 A 设计

### 3.1 每帧动态 near/far(`updateCameraRange()`)
聚焦天体在渲染原点,`camDist = camera.position.length()`,`fR = 聚焦半径`,`maxD = 场景里离聚焦中心最远的天体距离`:

```
far  = camDist + maxD * 1.5 + fR * 10
near = max( (camDist - fR) * 0.3 ,  fR * 1e-4 ,  far * 1e-7 )   // 比值上限 ~1e7
```

- `near` 卡在聚焦行星前面(相机离星表 ≈ camDist − fR)→ 聚焦星表精度好。
- `far * 1e-7` 兜底,限制 near/far 比 ≤ 1e7,防远处 z-fighting 过头。
- 同时按尺度设 `controls.minDistance = fR*1.02`(贴星表)、`controls.maxDistance = maxD*6 + fR*50`(能拉远看全景)。

### 3.2 星空跟随(任意尺度都像无限远天幕)
星空点云建成**单位球**,每帧:`starField.position = 相机位置`、`starField.scale = far*0.9`。`sizeAttenuation:false`(屏幕固定像素)+ `frustumCulled=false`。这样不管场景多大/多小,星空都恰好在 far 内、包住相机。

### 3.3 全局尺度旋钮 `params.worldScale = S`
把整个宇宙"放大" S 倍,用来验证大尺度渲染:
- 距离 / 半径 **× S**
- 质量 **× S³**
- 软化长度 **× S**

**为什么质量 ×S³**:圆轨道 `v=√(GM/r)`。若 `r×S` 且 `m×S³`(G 不变)→ `v×S`,角速度 `ω=v/r=1` 不变 → **轨道周期与视觉完全不变**,纯粹是坐标数值变大。于是 worldScale 成为一个"缩放整个宇宙"的旋钮:**画面一模一样,只是数值到了 1e6+**,正好用来确认渲染管线在大尺度下成立。
- `S=1e5` 时:半径 13→1.3e6、恒星 60→6e6、轨道 600→6e7,命中 1e6 米级。
- 大气/云/海洋的散射系数、云壳、海洋半径**都已 ∝1/R 或 ∝R 归一**,大尺度下比例自动正确。

---

## 4. 已完成(截至本文;**未提交**)

全部在 `three_planet/solar_system/main.js`:

1. **相机注释更新**:说明改用动态 near/far。
2. **星空**:`(function stars())` 改为单位球,导出模块级变量 `let starField`,`frustumCulled=false`。
3. **`updateCameraRange()`**:已实现(定义在 `manageDetail` 之后),并已在 `animate()` 里 `updateRender()` 之后、场景渲染之前调用。
4. **`params.worldScale = 1`**:已加入 params。
5. **`buildSystem()`**:已按 `S=params.worldScale, S3=S³` 缩放:恒星/行星/卫星的 质量×S³、半径×S、距离×S;希尔半径用 `p.dist*S`;软化 `params.softening*S`。
6. **`buildParticles()`**:小行星带 / 行星环的 inner/outer/thickness 已 ×S(速度用已缩放的 `system.G·mass/r` 自动匹配)。

---

## 5. 待完成(继续这么做)

1. **`frameFocus()` 辅助函数**:尺度或聚焦变化后把相机拉到合适距离,避免相机卡在放大后的星体内部。建议:
   ```js
   function frameFocus() {
     const d = focusBody().radius * 8;
     if (camera.position.lengthSq() > 1e-12) camera.position.setLength(d);
     else camera.position.set(0, d * 0.4, d);
     controls.target.set(0, 0, 0);
     controls.update();
   }
   ```
2. **GUI '全局尺度' 下拉**(放在顶层 params 区,`gui.add(params,'timeScale'...)` 附近):
   ```js
   gui.add(params, 'worldScale',
     { '×1 (演示)': 1, '×1e2': 100, '×1e3': 1000, '×1e4': 1e4, '×1e5 (~1e6m)': 1e5 })
     .name('全局尺度').onChange(() => { rebuild(); frameFocus(); });
   ```
   (下拉而非滑块 —— 1..1e5 的线性滑块没法用。)
3. **softening 的 GUI onChange 也要 ×worldScale**:当前是 `system.softening = params.softening`,改为 `system.softening = params.softening * params.worldScale`,与 `buildSystem` 一致。
4. **初始构图**:模块底部 `rebuild(); animate();` 之前/之后调用一次 `frameFocus()`(可选,S=1 时当前相机位置也 OK;主要是切到大 S 后靠 onChange 里的 frameFocus)。
5. **验证**:
   - `node --check three_planet/solar_system/main.js`
   - Node 桩 harness(module eval + rebuild + 1 帧,会构造 Planet)确认无 JS throw(见 §7)。
   - `curl -s -o /dev/null -w '%{http_code}' http://localhost:8123/solar_system/` = 200。
   - 浏览器(Safari 硬刷新 Cmd+Shift+R):
     - S=1 行为与之前一致;
     - 切 S=1e3 / 1e5,聚焦行星飞近应正常显示地形/大气/云/海洋,**深度不打架**,星空正常;
     - 切焦点到卫星,行星/恒星都在,轨道线正常;
     - 大气/云/海洋比例应与 S=1 视觉一致(因已归一)。

---

## 6. 注意事项 / 已知取舍

- **float32 极近距抖动**:S 很大时(如 1e5,行星 6e6),聚焦行星表面顶点离原点 ~6e6,float32 绝对精度 ~0.7 m;贴着星表看可能有亚米级抖动。LOD `maxLevel` 封顶了细分,基本无感;真要"走在星表看沙粒"级别需要另一套局部坐标系(超出本方案)。用户目标是"0–1e6 米行星",在 1e6 处精度 ~0.12 m,可接受。
- **极端跨度 z-fighting**:同屏既聚焦小卫星又要看很远的恒星时,远处仍可能轻微打架 —— 是远景小目标,基本无感。真不行再对**远景**局部上方案 B。
- **半径滑块 `聚焦天体半径`(2..300)**:大尺度下聚焦半径可能是 6e6,滑块范围放不下会显示为夹紧值,手动拖会异常。建议大尺度下**只用"全局尺度"旋钮**调尺寸,半径滑块留给 S=1 的微调。(后续可把该滑块范围做成随 worldScale 动态,暂未做。)
- **物理步长**:worldScale 用了 m×S³ 保持周期不变,所以 `FIXED_DT` / `timeScale` 无需改。若以后改成"只放大距离不放大质量",周期会变很长,需要靠 timeScale 提速。

---

## 7. 验证用的 Node 桩 harness(可复用)

因为 GLSL / WebGL 只能浏览器运行时验证,但**纯 JS 逻辑**(rebuild、cfg、管线结构、甚至构造 Planet 的一帧)可以在 Node 里跑,用桩替换 three / lil-gui / OrbitControls / simplex-noise(CDN)+ DOM 全局。做法:

- `hooks.mjs`:ESM loader,把 `three`/`lil-gui`/`three/addons/controls/OrbitControls.js`/simplex-noise 的 CDN URL 重定向到桩模块。
  - three 桩:用 `Proxy`(target 为 function,支持 `new`/调用/任意属性链,`Symbol.toPrimitive`→0),导出所有用到的名字(见 main.js 里 `THREE.X`)+ default。这样 `import * as THREE` 拿到的每个名字都可 `new`、可 `extends`(`prototype` 特判返回稳定对象)。
  - lil-gui 桩:`add/addColor` 校验属性存在(不存在就 throw,能抓到 GUI 绑错属性),`addFolder/controllersRecursive/options/setValue(触发 onChange)/updateDisplay` 都实现。
  - OrbitControls 桩:`target.set()`、`update()` 空实现。
  - simplex-noise 桩:`createNoise3D() → () => 0`。
- `run.mjs`:`module.register('./hooks.mjs', ...)` 后设 DOM 全局(`window/innerWidth/innerHeight/devicePixelRatio/requestAnimationFrame(()=>0 不循环)/addEventListener/navigator(defineProperty)/Worker(空类)/document`),再 `await import(main.js)`;捕获抛错。
- 判定:打印 `RESULT: OK` 表示 module eval + rebuild + 1 帧无 JS throw;`RESULT: THROW` 打印堆栈。
- 局限:桩让 THREE 调用都成功,只能抓**自己代码的 JS 逻辑错**(引用未定义、调用不存在的方法、属性访问 undefined 等),抓不到 GLSL / WebGL 专属错误(那类靠浏览器)。

> 历史教训:曾出现"一直加载中"白屏,根因是 **Safari 缓存了旧 `effects.js`**(缺 `uToneOut`)配着新 `main.js`。已在 `serve.py` 给所有响应加 `Cache-Control: no-store` 解决。改完模块记得 **Cmd+Shift+R 硬刷新**。

---

## 8. 提交建议

方案 A 完成并测试通过后,单独一个 commit,例如:
`太阳系真实大尺度(方案A): 动态 near/far + 星空跟随 + 全局尺度旋钮(距离半径×S/质量×S³ 保持周期), 支持 1e6 米级, 不改 shader`
