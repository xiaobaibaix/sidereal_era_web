#!/usr/bin/env python3
"""three_planet 开发服务器(零依赖)。

在静态文件服务之外, 额外提供两个接口, 让页面能把参数"直接保存进项目":
  GET  /api/presets           -> {"presets": ["default", ...]}  列出 presets/ 下的 *.json
  POST /api/presets/save      -> body: {"name": "xxx", "params": {...}}  写入 presets/xxx.json

用法:  python3 serve.py            # 默认 8123
       python3 serve.py 8080       # 指定端口

安全: 仅绑定 127.0.0.1(本机), name 做白名单校验 + 目录穿越防护, 只允许写 presets/ 下的 .json。
"""
import http.server
import socketserver
import json
import os
import re
import sys
import urllib.parse

ROOT = os.path.dirname(os.path.abspath(__file__))
PRESETS = os.path.join(ROOT, "presets")
SAFE_NAME = re.compile(r"^[A-Za-z0-9_\-. ]{1,64}$")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8123


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    # 开发服务器: 禁用一切缓存, 保证每次改完模块浏览器都拿到最新版(否则 Safari/Chrome
    # 会把 ES 模块缓存住, 出现"新 main.js 调新 uniform 但 effects.js 还是旧的"这类诡异错误)。
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def _send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?", 1)[0] == "/api/presets":
            try:
                names = sorted(f[:-5] for f in os.listdir(PRESETS) if f.endswith(".json"))
            except FileNotFoundError:
                names = []
            return self._send_json(200, {"presets": names})
        return super().do_GET()

    def do_POST(self):
        if urllib.parse.urlparse(self.path).path != "/api/presets/save":
            return self._send_json(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(length) or b"{}")
            name = str(data.get("name", "")).strip()
            params = data.get("params")
            if not SAFE_NAME.match(name):
                return self._send_json(400, {"error": "非法预设名(只允许字母数字 _-. 空格)"})
            if not isinstance(params, dict):
                return self._send_json(400, {"error": "params 必须是对象"})
            os.makedirs(PRESETS, exist_ok=True)
            path = os.path.abspath(os.path.join(PRESETS, name + ".json"))
            if os.path.commonpath([path, PRESETS]) != PRESETS:
                return self._send_json(400, {"error": "路径越界"})
            with open(path, "w", encoding="utf-8") as fp:
                json.dump(params, fp, ensure_ascii=False, indent=2)
                fp.write("\n")
            return self._send_json(200, {"ok": True, "name": name})
        except Exception as exc:  # noqa: BLE001
            return self._send_json(400, {"error": str(exc)})


if __name__ == "__main__":
    socketserver.TCPServer.allow_reuse_address = True
    os.makedirs(PRESETS, exist_ok=True)
    with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
        print(f"three_planet 开发服务器: http://localhost:{PORT}/  (presets 可写)")
        print(f"  行星 App : http://localhost:{PORT}/webs/planet_system/")
        print(f"  太阳系 App: http://localhost:{PORT}/webs/solar_system/")
        httpd.serve_forever()
