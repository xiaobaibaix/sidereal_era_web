// 海洋层 + 大气辉光(都是单个 shader 球体, 与 LOD 行星分开)。

import * as THREE from 'three';

// 半透明海洋: 菲涅尔边缘 + 太阳漫反射 + 高光。放在海平面半径处, 陆地从中穿出。
export const OCEAN_DRY_MAX = 8;   // 海洋"干区"遮罩最多支持的挖掘区数量(shader 数组长度)

export function createOcean() {
  const uniforms = {
    uSunDir: { value: new THREE.Vector3(1, 0.6, 0.8).normalize() },
    uDeep: { value: new THREE.Color(0x0a1e3f) },
    uShallow: { value: new THREE.Color(0x2e78a8) },
    uAmbient: { value: 0.2 },   // 夜面(背向太阳)海洋的基础亮度: 0=夜面全黑(无环境光), 默认0.2保持主项目原样
    // 干区遮罩: 陆地上的挖掘坑(xyz=单位方向, w=cos(角半径)); 该方向的海面 discard, 使陆地坑保持干燥
    uDryZones: { value: Array.from({ length: OCEAN_DRY_MAX }, () => new THREE.Vector4(0, 0, 0, 2)) },
    uDryCount: { value: 0 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */`
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uSunDir;
      uniform vec3 uDeep;
      uniform vec3 uShallow;
      uniform float uAmbient;
      uniform int uDryCount;
      uniform vec4 uDryZones[${OCEAN_DRY_MAX}];
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;
      void main() {
        vec3 N = normalize(vWorldNormal);   // 球面法线 = 从行星中心指向该片元的径向方向
        // 陆地开挖坑: 该径向落在任一干区内 → 不画海水(避免坑里露出海平面球壳)
        for (int i = 0; i < ${OCEAN_DRY_MAX}; i++) {
          if (i >= uDryCount) break;
          if (dot(N, uDryZones[i].xyz) > uDryZones[i].w) discard;
        }
        vec3 V = normalize(cameraPosition - vWorldPos);
        vec3 L = normalize(uSunDir);
        float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
        float diff = max(dot(N, L), 0.0);
        vec3 H = normalize(L + V);
        float spec = pow(max(dot(N, H), 0.0), 120.0) * step(0.0001, diff);   // 高光只在朝阳面
        vec3 col = mix(uDeep, uShallow, fres);
        // 环境项 uAmbient..1: 白天(diff=1)峰值不变; 夜面降到 uAmbient(=0 时全黑, 不再被"环境光"提亮)
        col = col * (uAmbient + (1.0 - uAmbient) * diff) + vec3(1.0, 0.96, 0.85) * spec * 0.9;
        float alpha = clamp(mix(0.72, 0.96, fres), 0.0, 1.0);
        gl_FragColor = vec4(col, alpha);
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 160, 80), material);
  mesh.renderOrder = 1;
  return mesh;
}

// 用行星的 edits 刷新某片海洋的"干区"遮罩: 取所有陆地上的整平挖掘区(type==='level' && dry),
// 写进海洋 shader 的 uDryZones/uDryCount → 这些坑里不再画海水。edits 为空/无海洋时安全跳过。
export function setOceanDryZones(ocean, edits) {
  if (!ocean || !ocean.material || !ocean.material.uniforms.uDryZones) return;
  const u = ocean.material.uniforms;
  let n = 0;
  if (Array.isArray(edits)) {
    for (let i = 0; i < edits.length && n < OCEAN_DRY_MAX; i++) {
      const e = edits[i];
      if (e && e.type === 'level') {
        u.uDryZones.value[n].set(e.pos[0], e.pos[1], e.pos[2], Math.cos(e.radius));
        n++;
      }
    }
  }
  u.uDryCount.value = n;
}

// 大气(瑞利 + 米氏单次散射, 实时 raymarch) —— 深度感知的全屏后处理 pass。
//
// 做法(见 docs/星球大气散射设计方案.md M3):
//   先把场景(行星+海洋)渲染到一张带深度纹理的 RenderTarget, 再用全屏 quad 跑这个 shader:
//   - 用逆 view-proj 从每像素重建世界视线方向 rd;
//   - 从深度纹理重建"该像素被实体(地形)挡住的距离 sceneDist" → 视线积分止于真实地表,
//     不再穿过山体, 且远处地表按视线透射率被"大气洗淡"(aerial perspective);
//   - 每个采样点向太阳再 march 一段外散射; 行星本体挡住太阳 → 晨昏线/夜侧变暗;
//   - 合成: finalColor = sceneColor * T_view + inscatter。
//   对主/旁观/角色三相机通用(每个视口各跑一次, 传各自的相机矩阵)。
//
// 返回 { uniforms, material, render(renderer) }。半径/散射强度由 main.js 注入。
export function createAtmospherePass() {
  const uniforms = {
    tDiffuse: { value: null },        // 场景颜色
    tDepth: { value: null },          // 场景深度
    uInvViewProj: { value: new THREE.Matrix4() },
    uCamPos: { value: new THREE.Vector3() },
    uEnabled: { value: 1.0 },         // 0=直通场景(大气关)

    uSunDir: { value: new THREE.Vector3(1, 0.6, 0.8).normalize() },
    uPlanetCenter: { value: new THREE.Vector3(0, 0, 0) },
    uRground: { value: 100.0 },       // 地面球半径(海平面)
    uRatmo: { value: 120.0 },         // 大气顶半径
    uDensityFalloff: { value: 6.0 },  // 瑞利密度衰减(越大大气越贴地)
    uMieFalloff: { value: 16.0 },     // 米氏密度衰减
    uScatterR: { value: new THREE.Vector3(0.0085, 0.026, 0.055) }, // 瑞利系数(蓝>绿>红)
    uScatterM: { value: 0.03 },       // 米氏散射系数(灰)
    uMieG: { value: 0.76 },           // 米氏前向峰
    uSunIntensity: { value: 22.0 },
    uExposure: { value: 1.0 },
    uToneOut: { value: 1.0 },         // 1=末端 tonemap+sRGB(单次/最后一次 pass); 0=输出线性HDR(多行星 ping-pong 中间 pass)
    uSteps: { value: 16 },            // 视线积分步数
    uLightSteps: { value: 8 },        // 太阳方向外散射步数
    uShadowSoftness: { value: 0.6 },  // 晨昏过渡带宽度
    uTwilight: { value: 0.3 },        // 暮光弧强度(0=贴地表, 1=完整几何地平下沉)
    uTonemap: { value: 1 },           // 0=Reinhard, 1=ACES filmic
    uTransLUT: { value: null },       // 透射率 LUT(太阳方向光学深度)
    uUseLUT: { value: 1.0 },          // 1=查表加速, 0=实时 raymarch(回退)
    uOzone: { value: new THREE.Vector3(0.007, 0.02, 0.0009) }, // 臭氧吸收(绿>红>蓝)
    uDither: { value: 1.0 },          // raymarch 抖动强度(去 banding)
    uOutputLT: { value: 0.0 },        // 1=输出 vec4(L, T.gray) 供 composite pass 半分辨率合成(不 tonemap); 0=原行为(输出最终颜色)

    // —— 体积云(与大气在同一 raymarch 内统一积分, 避免两层硬切产生的分界线)——
    uCloudsOn: { value: 0.0 },        // 1=在同一积分里叠加云(统一介质); 0=纯大气(与旧版逐字节一致)
    uCloudSteps: { value: 24 },       // 云壳内细步数(壳外用粗步, 既保云细节又不浪费步数在空大气上)
    uBottom: { value: 101.0 },        // 云层底半径
    uTop: { value: 106.0 },           // 云层顶半径
    uCoverage: { value: 0.5 },        // 覆盖率(越大云越多)
    uCloudDensity: { value: 1.2 },    // 云密度(消光强度)
    uFreq: { value: 0.06 },           // 噪声频率(越大云越碎)
    uWarp: { value: 0.5 },            // 域扭曲强度(飘逸感)
    uWind: { value: new THREE.Vector3(1, 0, 0.3) }, // 风向
    uWindSpeed: { value: 0.6 },       // 飘动速度
    uCloudLightSteps: { value: 6 },   // 云向太阳自阴影步数
    uAbsorb: { value: 1.0 },          // 云光照吸收(自阴影强度)
    uSunColor: { value: new THREE.Vector3(1.7, 1.6, 1.5) }, // 云受阳光颜色(HDR)
    uAmbient: { value: new THREE.Vector3(0.28, 0.34, 0.45) }, // 天空环境光
    uSilver: { value: 1.0 },          // 银边(前向散射相位)强度
    uPowder: { value: 0.6 },          // powder 暗边强度(0=关)
    uCloudShadow: { value: 0.7 },     // 云影投到地表强度(0=关)
    uTime: { value: 0 },              // 云飘动时间
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    depthTest: false,
    depthWrite: false,
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec2 vUv;

      uniform sampler2D tDiffuse;
      uniform sampler2D tDepth;
      uniform mat4  uInvViewProj;
      uniform vec3  uCamPos;
      uniform float uEnabled;

      uniform vec3  uSunDir;
      uniform vec3  uPlanetCenter;
      uniform float uRground;
      uniform float uRatmo;
      uniform float uDensityFalloff;
      uniform float uMieFalloff;
      uniform vec3  uScatterR;
      uniform float uScatterM;
      uniform float uMieG;
      uniform float uSunIntensity;
      uniform float uExposure;
      uniform float uToneOut;
      uniform int   uSteps;
      uniform int   uLightSteps;
      uniform float uShadowSoftness;   // 晨昏过渡带宽度
      uniform float uTwilight;         // 暮光弧强度(0=贴地表, 1=完整几何地平下沉)
      uniform int   uTonemap;          // 0=Reinhard, 1=ACES filmic
      uniform vec3  uOzone;            // 臭氧吸收系数(只消光, 不散射)
      uniform float uDither;           // raymarch 起点抖动强度(去 banding)
      uniform sampler2D uTransLUT;     // 透射率 LUT
      uniform float uUseLUT;           // 1=查表, 0=实时 raymarch
      uniform float uOutputLT;         // 1=输出 (L, T.gray) 给 composite pass; 0=输出最终颜色

      // 云(与大气统一积分)
      uniform float uCloudsOn;
      uniform int   uCloudSteps;
      uniform float uBottom;
      uniform float uTop;
      uniform float uCoverage;
      uniform float uCloudDensity;
      uniform float uFreq;
      uniform float uWarp;
      uniform vec3  uWind;
      uniform float uWindSpeed;
      uniform int   uCloudLightSteps;
      uniform float uAbsorb;
      uniform vec3  uSunColor;
      uniform vec3  uAmbient;
      uniform float uSilver;
      uniform float uPowder;
      uniform float uCloudShadow;
      uniform float uTime;

      const float PI = 3.14159265359;

      // 每像素伪随机(去 banding 的抖动用)
      float hash12(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }

      // ACES filmic 近似(Narkowicz): 线性 HDR → 显示线性, 高光自然滚降
      vec3 acesFilm(vec3 x) {
        return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
      }
      // 线性 → sRGB 编码(手动, 因为 ShaderMaterial 输出不自动转)
      vec3 linearToSRGB(vec3 c) {
        c = clamp(c, 0.0, 1.0);
        return mix(12.92 * c, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
      }
      // 统一末端处理: 曝光 → tonemap → sRGB。整条管线在线性 HDR 空间, 这里落地到屏幕。
      vec3 tonemap(vec3 c) {
        c *= uExposure;
        vec3 m = (uTonemap == 1) ? acesFilm(c) : (c / (1.0 + c));  // ACES 或 Reinhard
        return linearToSRGB(m);
      }
      // 输出: uToneOut=1 落地到屏幕(tonemap+sRGB); =0 输出线性 HDR(多行星 ping-pong 中间 pass, 留到最后一次再 tonemap)
      vec3 outColor(vec3 c) { return (uToneOut > 0.5) ? tonemap(c) : c; }

      // 射线与球求交, 返回 (near, far); 未命中返回 near>far。rd 需归一化(a=1)。
      vec2 raySphere(vec3 ro, vec3 rd, vec3 ce, float r) {
        vec3 oc = ro - ce;
        float b = dot(oc, rd);
        float c = dot(oc, oc) - r * r;
        float d = b * b - c;
        if (d < 0.0) return vec2(1e20, -1e20);
        float s = sqrt(d);
        return vec2(-b - s, -b + s);
      }

      // 归一化高度 [0,1] (0=地面, 1=大气顶)
      float heightFrac(vec3 p) {
        float h = length(p - uPlanetCenter) - uRground;
        return clamp(h / max(uRatmo - uRground, 1e-4), 0.0, 1.0);
      }

      // 某点的相对密度 (x=瑞利, y=米氏, z=臭氧)。瑞利/米氏指数衰减且边缘归零;
      // 臭氧用 tent 分布(集中在中高空), 只用于消光。
      vec3 densityAt(vec3 p) {
        float t = heightFrac(p);
        float edge = 1.0 - t;
        float dR = exp(-t * uDensityFalloff) * edge;
        float dM = exp(-t * uMieFalloff)     * edge;
        float dO = max(0.0, 1.0 - abs(t - 0.35) / 0.35);   // 臭氧 tent (峰在 h01≈0.35)
        return vec3(dR, dM, dO);
      }

      // 从点 p 沿 dir 的大气光学深度 (瑞利, 米氏)。撞地面则只积到地表(有限值),
      // 遮挡由 planetShadow() 平滑处理, 不再硬性丢弃 → 避免晨昏线硬边。
      vec3 opticalDepthToSun(vec3 p, vec3 dir) {
        vec2 a = raySphere(p, dir, uPlanetCenter, uRatmo);
        float far = max(a.y, 0.0);
        vec2 g = raySphere(p, dir, uPlanetCenter, uRground);
        if (g.x > 0.0 && g.y > g.x) far = min(far, g.x);
        int N = uLightSteps;
        float step = far / float(N);
        vec3 od = vec3(0.0);
        vec3 q = p + dir * (step * 0.5);
        for (int i = 0; i < 64; i++) {
          if (i >= N) break;
          od += densityAt(q) * step;
          q += dir * step;
        }
        return od;
      }

      // 行星本体对太阳的软遮挡: 1=全亮, 0=在阴影里。基于太阳相对"当地地平"的仰角,
      // 连续无硬跳变(白天全亮不被压暗); 高度越高地平越下沉 → 晨昏线之上仍受光(暮光)。
      float planetShadow(vec3 p, vec3 sunDir) {
        vec3 q = p - uPlanetCenter;
        float r = max(length(q), 1e-4);
        float sinElev = dot(q / r, sunDir);                        // 太阳相对当地地平的 sin
        float dip = sqrt(max(1.0 - (uRground * uRground) / (r * r), 0.0)) * uTwilight; // 地平下沉(可调)
        float soft = max(uShadowSoftness * 0.25, 1e-3);            // 过渡带宽度(sin 角度单位)
        return smoothstep(-soft, soft, sinElev + dip);
      }

      // ===== 体积云辅助(与大气在同一 raymarch 内积分)=====
      // Henyey-Greenstein 相位; 双叶(前向峰=银边 + 一点后向)近似米氏
      float hg(float mu, float g) {
        float g2 = g * g;
        return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));
      }
      float cloudPhase(float mu) {
        return mix(hg(mu, 0.8), hg(mu, -0.5), 0.5);
      }

      float hash3(vec3 p) {
        p = fract(p * 0.3183099 + 0.1);
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
      }
      float vnoise(vec3 x) {
        vec3 i = floor(x); vec3 f = fract(x);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(hash3(i + vec3(0,0,0)), hash3(i + vec3(1,0,0)), f.x),
                       mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), f.x), f.y),
                   mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), f.x),
                       mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), f.x), f.y), f.z);
      }
      float fbm(vec3 p, int oct) {
        float s = 0.0, a = 0.5;
        for (int i = 0; i < 5; i++) { if (i >= oct) break; s += a * vnoise(p); p *= 2.02; a *= 0.5; }
        return s;
      }

      // 云密度: 高度梯度(上下边缘渐隐) × 覆盖阈值化的 fbm。
      // hi=true 为视线采样(带域扭曲 + 4 octave, 高细节); false 为光照采样(便宜: 无扭曲 + 3 octave)。
      float cloudDensity(vec3 pos, bool hi) {
        float r = length(pos - uPlanetCenter);
        float thick = max(uTop - uBottom, 1e-4);
        float h = (r - uBottom) / thick;                       // 0=云底, 1=云顶
        if (h < -1.3 || h > 1.2) return 0.0;                   // 云底以下留长尾巴渐隐(陡段藏在地面下)
        // 底面渐隐【陡段挪到地面以下】: smoothstep(-1.2,0.6,h) 的最陡点在 h≈-0.3(即地表以下, 被行星遮住),
        // 可见范围(h≥-0.2)内密度变化很平 → 云底切线处不再有集中亮度跳变。
        // 让云在暖色大气辉光里慢慢浮现/消散, 而不是在云底球面处整齐冒出来 → 边界被混合掉。
        float heightGrad = smoothstep(-1.2, 0.6, h) * (1.0 - smoothstep(0.6, 1.2, h));
        vec3 sp = (pos - uPlanetCenter) * uFreq + uWind * (uTime * uWindSpeed);
        float base;
        if (hi) {
          vec3 w = vec3(fbm(sp * 0.5 + 11.5, 2), fbm(sp * 0.5 + 47.2, 2), fbm(sp * 0.5 + 83.1, 2)) - 0.5;
          base = fbm(sp + uWarp * w, 4);
        } else {
          base = fbm(sp, 3);
        }
        float thr = 1.0 - uCoverage;
        return smoothstep(thr, thr + 0.4, base * heightGrad);  // 阈值过渡加宽(0.18→0.4): 云边缘更软
      }

      // 云向太阳的自阴影(Beer): 沿 sunDir 累积密度(用便宜密度)
      float lightMarch(vec3 pos) {
        float st = (uTop - uBottom) / float(uCloudLightSteps);
        float sum = 0.0;
        vec3 q = pos;
        for (int i = 0; i < 12; i++) {
          if (i >= uCloudLightSteps) break;
          q += uSunDir * st;
          sum += cloudDensity(q, false) * st;
        }
        return exp(-sum * uCloudDensity * uAbsorb);
      }

      // 昼夜: 采样点当地地平上太阳仰角(软过渡)
      float dayFactor(vec3 pos) {
        vec3 up = normalize(pos - uPlanetCenter);
        return smoothstep(-0.12, 0.12, dot(up, uSunDir));
      }

      // 地表点的云影: 从地面点沿太阳方向穿过云层累积密度 → 透射率(1=无遮, 0=全影)
      float cloudShadow(vec3 gp) {
        vec2 o = raySphere(gp, uSunDir, uPlanetCenter, uTop);
        vec2 inr = raySphere(gp, uSunDir, uPlanetCenter, uBottom);
        float s0 = max(inr.y, 0.0);   // 穿出云底球 = 进入云层
        float s1 = o.y;               // 穿出云顶球
        if (s1 <= s0) return 1.0;
        int N = uCloudLightSteps;
        float st = (s1 - s0) / float(N);
        float sum = 0.0;
        vec3 q = gp + uSunDir * (s0 + st * 0.5);
        for (int i = 0; i < 12; i++) {
          if (i >= N) break;
          sum += cloudDensity(q, false) * st;
          q += uSunDir * st;
        }
        return exp(-sum * uCloudDensity * uAbsorb);
      }

      void main() {
        vec3 sceneColor = texture2D(tDiffuse, vUv).rgb;   // 线性 HDR
        if (uEnabled < 0.5) {
          // 大气关: LT 模式下输出 (0, 1) (无内散射, 全透射); 否则原 passthrough
          if (uOutputLT > 0.5) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
          gl_FragColor = vec4(outColor(sceneColor), 1.0); return;
        }

        // 从深度重建视线方向与场景距离
        vec2 ndc = vUv * 2.0 - 1.0;
        vec4 farP = uInvViewProj * vec4(ndc, 1.0, 1.0);
        vec3 rd = normalize(farP.xyz / farP.w - uCamPos);
        vec3 ro = uCamPos;

        float depth = texture2D(tDepth, vUv).x;
        float sceneDist = 1e20;
        vec3 hitPos = ro;
        bool hitGround = false;
        if (depth < 1.0) {
          vec4 hp = uInvViewProj * vec4(ndc, depth * 2.0 - 1.0, 1.0);
          hitPos = hp.xyz / hp.w;
          sceneDist = distance(hitPos, uCamPos);
          hitGround = true;
        }

        // 视线在大气壳内的区间
        vec2 atmo = raySphere(ro, rd, uPlanetCenter, uRatmo);
        float tNear = max(atmo.x, 0.0);
        float tFar  = atmo.y;
        if (tFar <= tNear) {
          // 视线未穿过大气: 无内散射(L=0), 全透射(T=1)。
          // LT 模式必须输出 (0, 1), 否则 composite 会把 tonemap 后的场景误当成线性 L 叠上去 → 黑边。
          if (uOutputLT > 0.5) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
          gl_FragColor = vec4(outColor(sceneColor), 1.0); return;
        }

        // 止于真实地表(深度)或海平面球(海洋不写深度, 用解析球兜底)
        tFar = min(tFar, sceneDist);
        vec2 gnd = raySphere(ro, rd, uPlanetCenter, uRground);
        if (gnd.x > 0.0 && gnd.y > gnd.x) tFar = min(tFar, gnd.x);
        if (tFar <= tNear) {
          if (uOutputLT > 0.5) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
          gl_FragColor = vec4(outColor(sceneColor), 1.0); return;
        }

        // 背景 = 场景色(行星/海洋)。命中地表时把云影投上去(仅白天侧)。
        vec3 background = sceneColor;
        if (uCloudsOn > 0.5 && uCloudShadow > 0.0 && hitGround &&
            length(hitPos - uPlanetCenter) < uTop) {
          float day = dayFactor(hitPos);
          if (day > 0.01) {
            float sh = cloudShadow(hitPos);
            background *= mix(1.0, sh, uCloudShadow * day);
          }
        }

        // 统一步长(非自适应): 自适应会在球壳边界(uBottom/uTop)切换粗/细步, 那条球面切线上
        // 大气被不同密度地采样 → 颜色跳变(就是边界线)。云开时整段用足够细的【统一】步长,
        // 任何半径上都没有采样跳变 → 不会有球面切线产生的线; 配合 cloudDensity 的长尾渐隐
        // (云底以下也有渐变密度, 填满原空心), 云底被自然混合掉。
        float span = tFar - tNear;
        int Nmarch = (uCloudsOn > 0.5) ? max(uSteps, uCloudSteps * 2) : uSteps;
        float stepU = span / float(Nmarch);

        // 起点抖动: 打散低步数产生的同心圆条带
        float jitter = mix(0.5, hash12(gl_FragCoord.xy), uDither);
        float t = tNear + stepU * jitter;

        // 相位(每像素常量)
        float mu = dot(rd, uSunDir);
        float phaseR = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
        float g = uMieG, g2 = g * g;
        float phaseM = 3.0 / (8.0 * PI)
                     * ((1.0 - g2) * (1.0 + mu * mu))
                     / ((2.0 + g2) * pow(1.0 + g2 - 2.0 * g * mu, 1.5));
        bool clouds = uCloudsOn > 0.5;
        // 云相位: 0.4 基底保证背光侧也有照明, 再叠前向银边
        float cphase = clouds ? (0.4 + uSilver * cloudPhase(mu)) : 0.0;
        bool useLUT = uUseLUT > 0.5;

        // 统一 front-to-back 合成: T=剩余透射(分通道), L=累计内散射(已含前向透射)。
        // 大气与云在【同一条视线积分】里一起采样 → 云只是连续大气里更密的一团,
        // 不再有分层分界线; 深度顺序(云前/云内/云后的大气)也天然正确。
        vec3 T = vec3(1.0);
        vec3 L = vec3(0.0);
        for (int i = 0; i < 512; i++) {
          if (t >= tFar) break;
          // 每步微抖动打散同心环(低幅, 不破坏能量守恒)
          float jit = (hash12(gl_FragCoord.xy + vec2(float(i) * 7.31, float(i) * 3.17)) - 0.5) * stepU * 0.25 * uDither;
          vec3 p = ro + rd * (t + jit);
          float r = length(p - uPlanetCenter);
          float ds = min(stepU, tFar - t);                          // 统一步长, 不越过终点(地表)

          // —— 大气: 密度(R,M,O)×ds → 本步消光 sigA + 内散射源 srcA ——
          vec3 dens = densityAt(p) * ds;                             // 本步光学深度贡献
          vec3 sigA = uScatterR * dens.x + uOzone * dens.z
                    + vec3(uScatterM * 1.1 * dens.y);                // 本步大气消光(分通道)

          // —— 云: 壳外早退(便宜); 壳内才算自阴影 + 受光 ——
          float sigC = 0.0;                                          // 本步云消光
          vec3 srcC = vec3(0.0);                                     // 本步云源
          if (clouds) {
            float dcl = cloudDensity(p, true);
            if (dcl > 0.0) {
              float sun = lightMarch(p);                            // 向太阳透射率(Beer 自阴影)
              float sunUp = dot(normalize(p - uPlanetCenter), uSunDir);
              float day = smoothstep(-0.12, 0.12, sunUp);           // 直射昼夜(窄)
              float amb = smoothstep(-0.4, 0.15, sunUp);            // 环境光昼夜(宽, 含暮光)
              float powder = mix(1.0, 1.0 - exp(-dcl * uCloudDensity * 2.0), uPowder);
              vec3 lit = uSunColor * (sun * day * cphase * powder) + uAmbient * amb;
              sigC = dcl * uCloudDensity * ds;
              srcC = sigC * lit;
            }
          }

          // —— 大气内散射源: 太阳→p 透射(LUT/回退) × 行星软遮挡 × 散射×相位×密度 ——
          vec3 srcA = vec3(0.0);
          float shadow = planetShadow(p, uSunDir);
          if (shadow > 0.0) {
            vec3 odSun;
            if (useLUT) {
              float rr = length(p - uPlanetCenter);
              float mus = dot(normalize(p - uPlanetCenter), uSunDir);
              vec2 luv = vec2(mus * 0.5 + 0.5,
                              clamp((rr - uRground) / max(uRatmo - uRground, 1e-4), 0.0, 1.0));
              odSun = texture2D(uTransLUT, luv).rgb;
            } else {
              odSun = opticalDepthToSun(p, uSunDir);
            }
            vec3 Tsun = exp(-(uScatterR * odSun.x + vec3(uScatterM * 1.1) * odSun.y
                              + uOzone * odSun.z)) * shadow;
            srcA = uSunIntensity * Tsun
                 * (uScatterR * phaseR * dens.x + vec3(uScatterM * phaseM) * dens.y);
          }

          // —— 合成本步: 大气与云共用同一消光/源, front-to-back ——
          vec3 sigT = sigA + vec3(sigC);
          vec3 src  = srcA + srcC;
          if (dot(sigT, sigT) > 1e-12) {
            vec3 dT = exp(-sigT);                                   // 本步透射
            vec3 integ = src * (1.0 - dT) / max(sigT, vec3(1e-7));  // ∫src·exp(-sigT·t)dt(本步)
            L += T * integ;
            T *= dT;
            // 不在此早退: 否则近侧云一旦较厚就跳过远侧云壳, 又变成"看不到后半球的云"。
            // 统一步长已用 t>=tFar 限定总步数, 这里让它走完整段, 远侧云得以积分出来。
          }
          t += ds;
        }

        // 背景(地表)被整段介质衰减 + 累计内散射(全在线性 HDR 空间)
        // LT 模式: 输出 (L, T.gray) 给半分辨率合成 — 把昂贵的 background*T 留给全分辨率 composite,
        // 地形细节由 composite 在全分辨率上保留, 只有大气/云(L, T)承受半分辨率的双线性插值。
        if (uOutputLT > 0.5) {
          float Tgray = clamp((T.r + T.g + T.b) / 3.0, 0.0, 1.0);
          gl_FragColor = vec4(L, Tgray);
          return;
        }

        vec3 color = background * T + L;
        gl_FragColor = vec4(outColor(color), 1.0);   // 末端 tonemap(或多行星中间 pass 输出线性HDR)
      }
    `,
  });

  const quadScene = new THREE.Scene();
  const quadCam = new THREE.Camera();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  quadScene.add(quad);

  return {
    uniforms,
    material,
    render(renderer) { renderer.render(quadScene, quadCam); },
  };
}

// 全分辨率合成 pass: 把全分辨率场景颜色(线性 HDR) 与半分辨率 (L, T) 合在一起。
// 关键点: 昂贵的 background * T 运算在【全分辨率】上做 → 地形细节(高频边缘)不被半分辨率
// 双线性插值糊掉; 只有软效果(L, T)承受半分辨率 → 锐利 + 快。
// 输入: tScene = rtMain.texture (线性 HDR 场景颜色), tAtmo = rtLit.texture (RGBA: RGB=L, A=T.gray)。
export function createCompositePass() {
  const uniforms = {
    tScene: { value: null },
    tAtmo: { value: null },
    uExposure: { value: 1.0 },
    uTonemap: { value: 1 },          // 0=Reinhard, 1=ACES filmic (与 atmoPass 保持一致)
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    depthTest: false,
    depthWrite: false,
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tScene;
      uniform sampler2D tAtmo;
      uniform float uExposure;
      uniform int   uTonemap;

      vec3 acesFilm(vec3 x) {
        return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
      }
      vec3 linearToSRGB(vec3 c) {
        c = clamp(c, 0.0, 1.0);
        return mix(12.92 * c, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
      }
      vec3 tonemap(vec3 c) {
        c *= uExposure;
        vec3 m = (uTonemap == 1) ? acesFilm(c) : (c / (1.0 + c));
        return linearToSRGB(m);
      }

      void main() {
        vec3 scene = texture2D(tScene, vUv).rgb;     // 全分辨率线性 HDR
        vec4 atmo = texture2D(tAtmo, vUv);           // 半分辨率(双线性): RGB=L (线性 HDR), A=T.gray
        vec3 L = atmo.rgb;
        float T = atmo.a;
        vec3 color = scene * T + L;                  // 合成: 场景被介质衰减 + 介质内散射
        gl_FragColor = vec4(tonemap(color), 1.0);    // 末端 tonemap(曝光+ACES+sRGB)
      }
    `,
  });
  const quadScene = new THREE.Scene();
  const quadCam = new THREE.Camera();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  quadScene.add(quad);
  return {
    uniforms,
    material,
    render(renderer) { renderer.render(quadScene, quadCam); },
  };
}

// 体积云(全屏 raymarch pass) —— 插在 场景 → 云 → 大气 之间。
//
// 在行星上方一层球壳 [R_bottom, R_top] 内步进采样 3D 噪声密度: 每个采样点再向太阳做
// 一小段 light march 算自阴影(Beer 定律), front-to-back 累积颜色与透射率; 被场景深度
// 裁剪(云在地形之后的部分不画)。输出线性 HDR(sceneColor*T + 云光), 由后续大气 pass 统一
// tonemap。对主/旁观/角色三相机通用(每视口传各自矩阵)。
export function createCloudPass() {
  const uniforms = {
    tDiffuse: { value: null },
    tDepth: { value: null },
    uInvViewProj: { value: new THREE.Matrix4() },
    uCamPos: { value: new THREE.Vector3() },
    uTime: { value: 0 },

    uSunDir: { value: new THREE.Vector3(1, 0.6, 0.8).normalize() },
    uPlanetCenter: { value: new THREE.Vector3(0, 0, 0) },
    uBottom: { value: 101.0 },        // 云层底半径
    uTop: { value: 106.0 },           // 云层顶半径
    uCoverage: { value: 0.5 },        // 覆盖率(越大云越多)
    uDensity: { value: 1.2 },         // 云密度(消光强度)
    uFreq: { value: 0.06 },           // 噪声频率(越大云越碎)
    uWarp: { value: 0.5 },            // 域扭曲强度(飘逸感)
    uWind: { value: new THREE.Vector3(1, 0, 0.3) }, // 风向
    uWindSpeed: { value: 0.6 },       // 飘动速度
    uSteps: { value: 24 },            // 视线步数
    uLightSteps: { value: 6 },        // 太阳方向步数
    uAbsorb: { value: 1.0 },          // 光照吸收(自阴影强度)
    uSunColor: { value: new THREE.Vector3(1.7, 1.6, 1.5) }, // 云受阳光颜色(HDR)
    uAmbient: { value: new THREE.Vector3(0.28, 0.34, 0.45) }, // 天空环境光
    uSilver: { value: 1.0 },          // 银边(前向散射相位)强度
    uPowder: { value: 0.6 },          // powder 暗边强度(0=关)
    uCloudShadow: { value: 0.7 },     // 云影投到地表强度(0=关)
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    depthTest: false,
    depthWrite: false,
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec2 vUv;

      uniform sampler2D tDiffuse;
      uniform sampler2D tDepth;
      uniform mat4  uInvViewProj;
      uniform vec3  uCamPos;
      uniform float uTime;
      uniform vec3  uSunDir;
      uniform vec3  uPlanetCenter;
      uniform float uBottom;
      uniform float uTop;
      uniform float uCoverage;
      uniform float uDensity;
      uniform float uFreq;
      uniform float uWarp;
      uniform vec3  uWind;
      uniform float uWindSpeed;
      uniform int   uSteps;
      uniform int   uLightSteps;
      uniform float uAbsorb;
      uniform vec3  uSunColor;
      uniform vec3  uAmbient;
      uniform float uSilver;
      uniform float uPowder;
      uniform float uCloudShadow;

      const float PI = 3.14159265359;

      // Henyey-Greenstein 相位; 双叶(前向峰=银边 + 一点后向)近似米氏
      float hg(float mu, float g) {
        float g2 = g * g;
        return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));
      }
      float cloudPhase(float mu) {
        return mix(hg(mu, 0.8), hg(mu, -0.5), 0.5);
      }

      vec2 raySphere(vec3 ro, vec3 rd, vec3 ce, float r) {
        vec3 oc = ro - ce;
        float b = dot(oc, rd);
        float c = dot(oc, oc) - r * r;
        float d = b * b - c;
        if (d < 0.0) return vec2(1e20, -1e20);
        float s = sqrt(d);
        return vec2(-b - s, -b + s);
      }

      // 3D value noise + fbm
      float hash(vec3 p) {
        p = fract(p * 0.3183099 + 0.1);
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
      }
      float vnoise(vec3 x) {
        vec3 i = floor(x); vec3 f = fract(x);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), f.x),
                       mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
                   mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                       mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
      }
      float fbm(vec3 p, int oct) {
        float s = 0.0, a = 0.5;
        for (int i = 0; i < 5; i++) { if (i >= oct) break; s += a * vnoise(p); p *= 2.02; a *= 0.5; }
        return s;
      }

      // 云密度: 高度梯度(上下边缘渐隐) × 覆盖阈值化的 fbm。
      // hi=true 为视线采样(带域扭曲 + 4 octave, 高细节); false 为光照采样(便宜: 无扭曲 + 3 octave)。
      float cloudDensity(vec3 pos, bool hi) {
        float r = length(pos - uPlanetCenter);
        float thick = max(uTop - uBottom, 1e-4);
        float h = (r - uBottom) / thick;                       // 0=云底, 1=云顶
        if (h < -1.3 || h > 1.2) return 0.0;                   // 与大气 pass 一致: 云底留长尾巴渐隐
        // 高度权重: 与大气 pass 统一, 上下大范围软渐隐
        float heightGrad = smoothstep(-1.2, 0.6, h) * (1.0 - smoothstep(0.6, 1.2, h));

        // 噪声锚定到行星中心(而非世界原点): 行星在渲染空间移动(如聚焦卫星时浮动原点随卫星公转
        // 漂移)也不会让云"滑动/沸腾"。主项目行星在原点 → pos-uPlanetCenter==pos, 行为不变。
        vec3 sp = (pos - uPlanetCenter) * uFreq + uWind * (uTime * uWindSpeed);
        float base;
        if (hi) {
          vec3 w = vec3(fbm(sp * 0.5 + 11.5, 2), fbm(sp * 0.5 + 47.2, 2), fbm(sp * 0.5 + 83.1, 2)) - 0.5;
          base = fbm(sp + uWarp * w, 4);
        } else {
          base = fbm(sp, 3);
        }
        // 关键: 先把噪声乘上高度权重再阈值化 → 云顶/云底被噪声啃成参差形状, 不再是平切的球面
        float thr = 1.0 - uCoverage;
        return smoothstep(thr, thr + 0.4, base * heightGrad);  // 与大气 pass 一致: 阈值过渡加宽
      }

      // 向太阳的自阴影(Beer): 沿 sunDir 累积密度(用便宜密度)
      float lightMarch(vec3 pos) {
        float st = (uTop - uBottom) / float(uLightSteps);
        float sum = 0.0;
        vec3 q = pos;
        for (int i = 0; i < 12; i++) {
          if (i >= uLightSteps) break;
          q += uSunDir * st;
          sum += cloudDensity(q, false) * st;
        }
        return exp(-sum * uDensity * uAbsorb);
      }

      // 昼夜: 采样点当地地平上太阳仰角(软过渡)
      float dayFactor(vec3 pos) {
        vec3 up = normalize(pos - uPlanetCenter);
        return smoothstep(-0.12, 0.12, dot(up, uSunDir));
      }

      // 地表点的云影: 从地面点沿太阳方向穿过云层累积密度 → 透射率(1=无遮, 0=全影)
      float cloudShadow(vec3 gp) {
        vec2 o = raySphere(gp, uSunDir, uPlanetCenter, uTop);
        vec2 inr = raySphere(gp, uSunDir, uPlanetCenter, uBottom);
        float s0 = max(inr.y, 0.0);      // 穿出云底球 = 进入云层
        float s1 = o.y;                  // 穿出云顶球
        if (s1 <= s0) return 1.0;
        int N = uLightSteps;
        float st = (s1 - s0) / float(N);
        float sum = 0.0;
        vec3 q = gp + uSunDir * (s0 + st * 0.5);
        for (int i = 0; i < 12; i++) {
          if (i >= N) break;
          sum += cloudDensity(q, false) * st;
          q += uSunDir * st;
        }
        return exp(-sum * uDensity * uAbsorb);
      }

      void main() {
        vec3 sceneColor = texture2D(tDiffuse, vUv).rgb;

        vec2 ndc = vUv * 2.0 - 1.0;
        vec4 farP = uInvViewProj * vec4(ndc, 1.0, 1.0);
        vec3 rd = normalize(farP.xyz / farP.w - uCamPos);
        vec3 ro = uCamPos;

        float depth = texture2D(tDepth, vUv).x;
        float sceneDist = 1e20;
        if (depth < 1.0) {
          vec4 hp = uInvViewProj * vec4(ndc, depth * 2.0 - 1.0, 1.0);
          vec3 hitPos = hp.xyz / hp.w;
          sceneDist = distance(hitPos, uCamPos);
          // 云影投到地表(仅行星表面、白天侧)
          if (uCloudShadow > 0.0 && length(hitPos - uPlanetCenter) < uTop) {
            float day = dayFactor(hitPos);
            if (day > 0.01) {
              float sh = cloudShadow(hitPos);
              sceneColor *= mix(1.0, sh, uCloudShadow * day);
            }
          }
        }

        // 视线与云壳区间 = 外壳内部 - 内壳内部
        vec2 outer = raySphere(ro, rd, uPlanetCenter, uTop);
        vec2 inner = raySphere(ro, rd, uPlanetCenter, uBottom);
        // 命中区间: 取外壳内整段(含近侧云壳 + 空心 + 远侧云壳)。
        // 不再在近侧内壳硬停 —— 否则远侧云壳永远不积分, 云层就像个不透明的空壳,
        // 后半球的云看不到(就是用户观察到的那条切线)。空心区 cloudDensity≈0, 走过去很便宜。
        float t0 = max(outer.x, 0.0);
        float t1 = outer.y;
        if (t1 <= t0) { gl_FragColor = vec4(sceneColor, 1.0); return; }
        // 相机在内壳里(地表附近)向上看: 从内壳远交点开始
        if (inner.x < 0.0 && inner.y > 0.0) t0 = max(t0, inner.y);
        t1 = min(t1, sceneDist);
        if (t1 <= t0) { gl_FragColor = vec4(sceneColor, 1.0); return; }

        int N = uSteps;
        float step = (t1 - t0) / float(N);
        // 起点抖动去 banding
        float jitter = hash(vec3(gl_FragCoord.xy, uTime));
        vec3 p = ro + rd * (t0 + step * jitter);

        // 相位: 前向峰在视线朝太阳时最强 → 背光云的边缘银边
        float mu = dot(rd, uSunDir);
        float phase = 0.4 + uSilver * cloudPhase(mu);   // 0.4 基底保证背光侧也有照明

        float T = 1.0;
        vec3 L = vec3(0.0);
        for (int i = 0; i < 96; i++) {
          if (i >= N || T < 0.02) break;
          float dloc = cloudDensity(p, true);
          float dens = dloc * step * uDensity;
          if (dens > 0.001) {
            float sun = lightMarch(p);                       // 向太阳透射率(Beer)
            float sunUp = dot(normalize(p - uPlanetCenter), uSunDir);
            float day = smoothstep(-0.12, 0.12, sunUp);      // 直射昼夜(窄)
            float amb = smoothstep(-0.4, 0.15, sunUp);       // 环境光昼夜(宽, 含暮光) → 夜面云变暗
            // powder(糖粉暗边): 朝光的薄处偏暗, 增强体积感
            float powder = mix(1.0, 1.0 - exp(-dloc * uDensity * 2.0), uPowder);
            vec3 lit = uSunColor * (sun * day * phase * powder) + uAmbient * amb;
            float a = 1.0 - exp(-dens);
            L += T * a * lit;
            T *= exp(-dens);
          }
          p += rd * step;
        }

        vec3 color = sceneColor * T + L;   // front-to-back 合成; 线性 HDR
        gl_FragColor = vec4(color, 1.0);
      }
    `,
  });

  const quadScene = new THREE.Scene();
  const quadCam = new THREE.Camera();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  quadScene.add(quad);

  return {
    uniforms,
    material,
    render(renderer) { renderer.render(quadScene, quadCam); },
  };
}

// God rays(体积光/曙暮光)—— 屏幕空间径向光束。
//
// 在大气 pass 之后运行: 以太阳的屏幕位置为中心, 沿"每像素→太阳"方向对已合成图像做径向
// 采样, 只取较亮的部分(天空/太阳)作为光源, 逐步衰减累加 → 云/山缝隙间透出的光束。
// 太阳在屏幕后方/侧向时按视线夹角淡出。输入/输出都是 tonemap 后的显示色(sRGB, 直通)。
export function createGodrayPass() {
  const uniforms = {
    tLit: { value: null },
    uSunUV: { value: new THREE.Vector2(0.5, 0.5) },
    uSunVis: { value: 0.0 },        // 太阳可见度(视线夹角 → 0..1)
    uStrength: { value: 0.6 },      // 光束强度
    uDensity: { value: 0.7 },       // 光束扩散(采样跨度)
    uDecay: { value: 0.96 },        // 沿程衰减
    uWeight: { value: 0.6 },        // 每样本权重
    uSamples: { value: 48 },        // 采样数
    uThreshold: { value: 0.45 },    // 亮度阈值(只有更亮处才发出光束)
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    depthTest: false,
    depthWrite: false,
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tLit;
      uniform vec2  uSunUV;
      uniform float uSunVis;
      uniform float uStrength;
      uniform float uDensity;
      uniform float uDecay;
      uniform float uWeight;
      uniform int   uSamples;
      uniform float uThreshold;

      void main() {
        vec3 base = texture2D(tLit, vUv).rgb;
        if (uSunVis <= 0.001) { gl_FragColor = vec4(base, 1.0); return; }

        vec2 delta = (vUv - uSunUV) * (uDensity / float(uSamples));
        vec2 coord = vUv;
        float illum = 1.0;
        vec3 accum = vec3(0.0);
        for (int i = 0; i < 128; i++) {
          if (i >= uSamples) break;
          coord -= delta;
          vec3 s = texture2D(tLit, coord).rgb;
          float lum = dot(s, vec3(0.299, 0.587, 0.114));
          s *= smoothstep(uThreshold, uThreshold + 0.35, lum);   // 只取较亮处作光源
          accum += s * illum * uWeight;
          illum *= uDecay;
        }
        accum /= float(uSamples);
        gl_FragColor = vec4(base + accum * uStrength * uSunVis, 1.0);
      }
    `,
  });
  const quadScene = new THREE.Scene();
  const quadCam = new THREE.Camera();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  quadScene.add(quad);
  return {
    uniforms,
    material,
    render(renderer) { renderer.render(quadScene, quadCam); },
  };
}

// 透射率 LUT 预计算(M6 的务实子集)。
//
// 大气球对称 → 太阳方向光学深度只取决于(采样点半径 r, 太阳天顶余弦 mu)。把它预烘成一张
// 2D 表(x=mu, y=高度), rgb = (瑞利, 米氏, 臭氧)光学深度。运行时大气 pass 直接查表, 省掉
// 每个视线采样点里那层 M 步的"向太阳 march"内循环。表随大气参数变化时重烘一次即可。
export function createTransmittanceLUT() {
  const uniforms = {
    uRground: { value: 100.0 },
    uRatmo: { value: 120.0 },
    uDensityFalloff: { value: 6.0 },
    uMieFalloff: { value: 16.0 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    depthTest: false,
    depthWrite: false,
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec2 vUv;
      uniform float uRground;
      uniform float uRatmo;
      uniform float uDensityFalloff;
      uniform float uMieFalloff;

      vec2 raySphere(vec3 ro, vec3 rd, float r) {
        float b = dot(ro, rd);
        float c = dot(ro, ro) - r * r;
        float d = b * b - c;
        if (d < 0.0) return vec2(1e20, -1e20);
        float s = sqrt(d);
        return vec2(-b - s, -b + s);
      }
      vec3 densityAt(vec3 p) {
        float t = clamp((length(p) - uRground) / max(uRatmo - uRground, 1e-4), 0.0, 1.0);
        float edge = 1.0 - t;
        float dR = exp(-t * uDensityFalloff) * edge;
        float dM = exp(-t * uMieFalloff) * edge;
        float dO = max(0.0, 1.0 - abs(t - 0.35) / 0.35);
        return vec3(dR, dM, dO);
      }

      void main() {
        float mu = vUv.x * 2.0 - 1.0;                 // 天顶余弦 [-1,1]
        float r = mix(uRground, uRatmo, vUv.y);       // 半径
        vec3 origin = vec3(0.0, r, 0.0);
        vec3 dir = vec3(sqrt(max(1.0 - mu * mu, 0.0)), mu, 0.0);

        vec2 top = raySphere(origin, dir, uRatmo);
        float far = max(top.y, 0.0);
        vec2 gnd = raySphere(origin, dir, uRground);
        if (gnd.x > 0.0 && gnd.y > gnd.x) far = min(far, gnd.x);

        const int N = 40;
        float st = far / float(N);
        vec3 od = vec3(0.0);
        vec3 p = origin + dir * (st * 0.5);
        for (int i = 0; i < N; i++) { od += densityAt(p) * st; p += dir * st; }
        gl_FragColor = vec4(od, 1.0);
      }
    `,
  });
  const quadScene = new THREE.Scene();
  const quadCam = new THREE.Camera();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  quadScene.add(quad);
  return {
    uniforms,
    material,
    render(renderer, target) {
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(target);
      renderer.render(quadScene, quadCam);
      renderer.setRenderTarget(prev);
    },
  };
}

// 气态行星: 纬向气带 + 域扭曲湍流 + 缓慢流动 + 太阳方向明暗(夜面暗) + 边缘变暗(球体感)。
// 单个 shader 球(无地形/海洋)。渲染进场景 RT(线性 HDR), 由末端大气 pass 统一 tonemap。
// 每帧由 main.js 设 uTime / uSunDir; 颜色/气带数等由 applyGasUniforms 注入。
export function createGasGiant() {
  const uniforms = {
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(1, 0, 0) },
    uColA: { value: new THREE.Color(0.72, 0.62, 0.45) },   // 气带色 A
    uColB: { value: new THREE.Color(0.90, 0.83, 0.68) },   // 气带色 B(亮带/区)
    uColC: { value: new THREE.Color(0.55, 0.44, 0.34) },   // 气带色 C(暗带)
    uBands: { value: 14.0 },   // 气带数(纬向条纹密度)
    uWarp: { value: 0.5 },     // 湍流扭曲(条纹卷曲/漩涡)
    uFlow: { value: 0.03 },    // 流动速度
    uSeed: { value: 0.0 },     // 噪声域偏移(不同气态星长得不一样)
    uBright: { value: 1.35 },  // 整体亮度补偿(抵消末端 tonemap 压暗)
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */`
      varying vec3 vObjN;
      varying vec3 vWorldN;
      varying vec3 vWorldPos;
      void main() {
        vObjN = normalize(position);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vWorldN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      uniform float uTime, uBands, uWarp, uFlow, uSeed, uBright;
      uniform vec3  uSunDir, uColA, uColB, uColC;
      varying vec3 vObjN;
      varying vec3 vWorldN;
      varying vec3 vWorldPos;

      float hash(vec3 p) {
        p = fract(p * 0.3183099 + 0.1);
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
      }
      float vnoise(vec3 x) {
        vec3 i = floor(x); vec3 f = fract(x);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), f.x),
                       mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
                   mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                       mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
      }
      float fbm(vec3 p) {
        float s = 0.0, a = 0.5;
        for (int i = 0; i < 5; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; }
        return s;
      }

      void main() {
        vec3 n = normalize(vObjN);
        vec3 seed = vec3(uSeed);
        // 湍流域(缓慢在经度方向平移 → 气带流动/卷曲)
        vec3 sp = n * 2.2 + seed;
        float turb  = fbm(sp * 1.6 + vec3(uTime * uFlow, 0.0, uTime * uFlow * 0.4));
        float swirl = fbm(sp * 3.6 + vec3(0.0, uTime * uFlow * 0.7, 0.0));
        // 被湍流扭曲的纬度 → 纬向气带
        float lat = n.y + (turb - 0.5) * uWarp;
        float band = lat * uBands;
        float m = fract(band * 0.5);         // 半频循环, A-B-C 过渡更平滑
        vec3 col = (m < 0.5)
          ? mix(uColA, uColB, smoothstep(0.0, 1.0, m * 2.0))
          : mix(uColB, uColC, smoothstep(0.0, 1.0, (m - 0.5) * 2.0));
        col *= 0.82 + 0.36 * swirl;          // 漩涡细节明暗

        // 太阳明暗(夜面暗, 软晨昏) + 边缘变暗(球体立体感)
        vec3 N = normalize(vWorldN);
        vec3 V = normalize(cameraPosition - vWorldPos);
        float day  = smoothstep(-0.12, 0.18, dot(N, normalize(uSunDir)));
        float limb = mix(0.55, 1.0, clamp(dot(N, V), 0.0, 1.0));
        gl_FragColor = vec4(col * uBright * day * limb, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), material);
  return mesh;
}
