# Godot 移植指南

把本项目（Three.js 的 Icosphere 行星 + 三角形四叉树 LOD）移植到 **Godot 4** 的分析与方案。

> 目标引擎：**Godot 4**。不建议 Godot 3——它没有 `WorkerThreadPool`，`FastNoiseLite` 也更弱。

---

## 移植总原则

**算法照搬，胶水替换。**

- 项目的真正价值（缝合几何、LOD 四叉树、径向重力角色）全是**引擎无关的纯算法**，直接翻译。
- 那些"胶水"（Web Worker、CDN importmap、DOM 画中画、lil-gui）在 Godot 里都有更好的**原生替代**，不要硬移植。
- 热路径（噪声采样 + 逐顶点几何）用 **C# 或 GDExtension**，低频调度逻辑留 GDScript。

---

## 一、模块对照表

| JS 文件 | 内容 | Godot 对策 | 工作量 |
|---------|------|-----------|--------|
| `patchgeom.js` | dyadic 缝合 + skirt 裙边几何 | **直接移植**为纯函数，输出喂 `ArrayMesh` | 中，1:1 翻译 |
| `planet.js` LOD | 四叉树 selectLOD/split/merge、邻居层级查询、stride | **直接移植**算法 | 大，核心 |
| `terrain.js` | fbm/ridged/worley/域扭曲/气候配色 | 逻辑移植，**底层噪声换 `FastNoiseLite`** | 中 |
| `worker.js` + 池 | Web Worker 池异步生成 | 换成 `WorkerThreadPool` | 中 |
| `character.js` | 径向重力 + 切平面移动 | **直接移植**，纯向量数学 | 中 |
| `effects.js` | 海洋/大气 shader | 用 Godot shading language 重写 | 中 |
| `main.js` 画中画 | 手写 DOM + scissor 视口 | 换 `SubViewport` | 变简单 |
| `main.js` 相机/输入 | Orbit/旁观/PointerLock | 社区插件 + `MOUSE_MODE_CAPTURED` | 变简单 |
| GUI (lil-gui) | 调参面板 | `@export` 变量或 Control 面板 | 变简单 |
| `index.html` importmap | CDN 加载 | 删掉，Godot 自带打包 | — |

---

## 二、直接移植（项目的真正价值，别重写）

这几块是引擎无关的纯算法，照着翻译即可，是移植的重点。

### 1. 缝合几何 `patchgeom.js`

整个项目最值钱的部分：消 T 型接缝的 **dyadic 中点嵌套 + stride 抽稀吸附 + skirt 裙边**。它连 THREE 都没依赖，本来就是纯函数。翻译成 GDScript/C# 后，输出数组直接对接 Godot 的 `ArrayMesh`：

```
positions → ARRAY_VERTEX (PackedVector3Array)
normals   → ARRAY_NORMAL
colors    → ARRAY_COLOR  (PackedColorArray)
indices   → ARRAY_INDEX  (PackedInt32Array)

mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
```

现在的 `buildPatchArrays` 返回结构和 Godot 期望的数组布局天然吻合，几乎逐行对应。

### 2. LOD 四叉树 `planet.js`

`selectLOD` 的分裂/合并/兜底、`targetLevelAt` 邻居层级查询、`computeStrides`、`_gen` 代号失效机制，全是纯逻辑，照搬。

- 视锥测试：用 `Camera3D.get_frustum()` 拿 6 个 `Plane`，手动测包围球，替代 `Frustum.intersectsSphere`。
- 正二十面体根节点构造（黄金比例 `t=(1+√5)/2`）：平凡移植。

### 3. 角色 `character.js`

径向重力、切平面 WASD、胶囊朝向的 `makeBasis`、解析采样 `heightAt` 当碰撞，全是向量数学，直接移植。

> **注意**：它**不需要物理引擎**（高度场解析求地面半径）。在 Godot 里也别用 `CharacterBody3D` + 碰撞体，保持解析法即可，一个 `Node3D` + `MeshInstance3D` 就够。

---

## 三、换成 Godot 原生能力（别硬移植）

### 1. 噪声：`FastNoiseLite` 能吃掉 `terrain.js` 大半

Godot 内置的 `FastNoiseLite` 自带：Simplex、**Cellular（就是 Worley，能返回 F1/F2）**、**Fractal FBm/Ridged**、**Domain Warp**。

也就是说 `terrain.js` 里手写的 `fbm` / `ridged` / `worley` / 域扭曲这四样，理论上都能用它的配置替代。两条路线：

- **想省事**：直接配 `FastNoiseLite`，代码量大减，但地形长相会和现在不一样。
- **想还原现在的星球**：把底层 `noise(x,y,z)` 换成 `FastNoiseLite` 的单次采样，上层的 fbm 叠加 / 大陆掩膜 / 气候配色逻辑照旧移植。

> 掩膜和配色那套是自己的东西，`FastNoiseLite` 替代不了，必须移植。

### 2. 异步生成：`WorkerThreadPool` 替代 Worker 池

现在的架构对移植极其友好——它已经把"算数组"（worker）和"建网格 + 挂场景"（主线程）分开了。Godot 里同样切法：

- 在 `WorkerThreadPool.add_task()` 里跑 `buildPatchArrays`（只算 `Packed*Array`，线程安全）；
- 完成后回主线程 `call_deferred` 建 `ArrayMesh`、`add_child`。
- `_gen` 代号丢弃过期结果、`_builtKey` 去重这些机制原样保留。

### 3. 画中画：`SubViewport` 替代手写 scissor + DOM

`main.js` 里那段手写 DOM 覆盖层 + `setScissor` 分视口，在 Godot 里用一个 `SubViewport`（塞第二个 `Camera3D`）渲到 `TextureRect` 即可，边框标签用 Control 节点。这块比现在**简单很多**。

### 4. Shader：重写不是翻译

`effects.js` 的思路可移植，但语法要换成 Godot shading language：

- **海洋菲涅尔**：`cameraPosition` → `CAMERA_POSITION_WORLD`；透明 `render_mode blend_mix, depth_draw_never`。
- **大气辉光**：`side: BackSide` → `cull_front`；`AdditiveBlending` → `blend_add`；临边靠 `NORMAL·VIEW` 算。

### 5. 输入 / 相机 / GUI

- `PointerLockControls` → `Input.set_mouse_mode(Input.MOUSE_MODE_CAPTURED)`
- `OrbitControls` → 社区轨道相机插件，或自己写几十行
- lil-gui → `@export` 暴露给编辑器，或做个 Control 面板

---

## 四、必须注意的坑

1. **语言选型决定性能**。每个顶点要算 fbm（多八度）+ 27 格 Worley + 3 次 `heightAt`（有限差分法线）。纯 GDScript 跑这个热路径在大量 patch 下会吃力。建议 `terrain.js` + `patchgeom.js` 用 **C#** 或 **GDExtension（Rust/C++）**，LOD 调度那种低频逻辑留 GDScript 没问题。`FastNoiseLite` 本身是 C++ 实现，采样快，瓶颈在外层循环语言。

2. **patch 别做成 Node**。JS 里每个 patch 是加进 Group 的 Mesh；Godot 里 `MeshInstance3D` 每帧大量增删有开销。四叉树节点用轻量的 `RefCounted` / 普通对象，`MeshInstance3D` 只给"当前可见"的 patch 用并做**对象池**复用。

3. **线程里不能碰场景树**。`ArrayMesh` 的数组能在线程算，但建 mesh、`add_child` 要回主线程（`call_deferred`）。所幸现有架构已经是这个分工，映射很顺。

4. **面朝向 / 顶点色**。现在用 `side: DoubleSide` 绕开了绕序问题，Godot 里对应材质设 `cull_disabled`，否则要检查三角形索引绕序。顶点色要在 `StandardMaterial3D` 上开 `vertex_color_use_as_albedo = true` 才显示。

5. **坐标系基本兼容**：两边都是 Y-up 右手系，但 Godot 约定 **-Z 为前方**，角色 `forward` 的初始约定要相应调整。大半径下的 32 位浮点精度问题两边一样，不会更糟。

---

## 五、建议的 Godot 工程结构

```
Main.tscn
 ├─ Planet (Node3D)              # LOD 管理，持有四叉树根
 │   └─ (运行时挂 MeshInstance3D 对象池)
 ├─ Ocean (MeshInstance3D + ocean.gdshader)
 ├─ Atmosphere (MeshInstance3D + atmosphere.gdshader)
 ├─ PlanetWalker (Node3D)        # 角色
 ├─ OrbitCamera / SpectatorCamera (Camera3D)
 └─ InsetViewport (SubViewport)  # 画中画

脚本:
  TerrainField     (建议 C#/GDExtension)  # 噪声高度场 + 配色
  PatchBuilder     (建议 C#/GDExtension)  # 缝合几何
  QuadNode         (RefCounted)           # 四叉树节点
  MeshJobPool      (WorkerThreadPool)     # 异步生成调度
```

---

## 六、移植顺序建议（增量验证）

1. **静态单 patch**：`TerrainField` + `PatchBuilder` → 生成一个 `ArrayMesh`，确认噪声/配色/法线正确。
2. **完整粗糙球**：20 个根 patch 同步生成，确认正二十面体和缝合初值。
3. **LOD 主循环**：`QuadNode.selectLOD` + 分裂/合并，先同步生成，确认 LOD 切换与缝合无裂缝。
4. **异步化**：接入 `WorkerThreadPool` + `_gen`/`_builtKey`，确认加载兜底与重生成。
5. **特效**：海洋/大气 shader、星空。
6. **交互**：轨道相机 → 角色模式 → 画中画 SubViewport。

---

*一句话总结：算法（缝合、LOD、径向角色）直译照搬；胶水（Worker、噪声库、画中画、GUI、CDN）换 Godot 原生；热路径用 C#/GDExtension 保性能。真正要动脑重写的只有 shader 和相机/输入接线。*
