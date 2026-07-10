# 恒星纪元

基于 three.js 的程序化行星渲染器。包含两个网页应用:

- **行星 (planet_system)** — 正二十面体 + 四叉树 LOD 地形、海洋、大气散射、体积云、体积光,可登陆行星第三人称漫游。
- **太阳系 (solar_system)** — N-body 引力模拟 + 浮动原点大尺度渲染,复用行星引擎做近距地形表现。

## 目录结构

```
src/                     # 共享渲染引擎(两个应用复用)
  planet.js terrain.js patchgeom.js worker.js effects.js
webs/
  planet_system/         # 行星应用: index.html main.js character.js
  solar_system/          # 太阳系应用: index.html main.js nbody.js
presets/                 # 参数预设(可读写)
docs/                    # 设计文档
serve.py                 # 零依赖开发服务器
```

## 启动

应用用 ES 模块 + Web Worker,**必须通过本地服务器打开**(直接双击 `file://` 会被 CORS 拦截)。

1. 启动开发服务器(需要 Python 3):

   ```bash
   python3 serve.py          # 默认端口 8123
   python3 serve.py 8080     # 指定端口
   ```

2. 在浏览器打开其中一个应用:

   - 行星: <http://localhost:8123/webs/planet_system/>
   - 太阳系: <http://localhost:8123/webs/solar_system/>

   启动后终端也会打印这两个地址。

## 说明

- 右上角 GUI 面板可实时调参。行星应用支持把参数**保存到项目** `presets/`(通过 `serve.py` 提供的接口),普通静态服务器则只能导出/导入 JSON。
- `serve.py` 已对所有响应禁用缓存;若改了模块后浏览器仍显示旧版,硬刷新一次(Cmd/Ctrl+Shift+R)。
