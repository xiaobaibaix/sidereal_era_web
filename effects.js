// 海洋层 + 大气辉光(都是单个 shader 球体, 与 LOD 行星分开)。

import * as THREE from 'three';

// 半透明海洋: 菲涅尔边缘 + 太阳漫反射 + 高光。放在海平面半径处, 陆地从中穿出。
export function createOcean() {
  const uniforms = {
    uSunDir: { value: new THREE.Vector3(1, 0.6, 0.8).normalize() },
    uDeep: { value: new THREE.Color(0x0a1e3f) },
    uShallow: { value: new THREE.Color(0x2e78a8) },
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
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;
      void main() {
        vec3 N = normalize(vWorldNormal);
        vec3 V = normalize(cameraPosition - vWorldPos);
        vec3 L = normalize(uSunDir);
        float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
        float diff = max(dot(N, L), 0.0);
        vec3 H = normalize(L + V);
        float spec = pow(max(dot(N, H), 0.0), 120.0);
        vec3 col = mix(uDeep, uShallow, fres);
        col = col * (0.2 + 0.8 * diff) + vec3(1.0, 0.96, 0.85) * spec * 0.9;
        float alpha = clamp(mix(0.72, 0.96, fres), 0.0, 1.0);
        gl_FragColor = vec4(col, alpha);
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 160, 80), material);
  mesh.renderOrder = 1;
  return mesh;
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
    uSteps: { value: 16 },            // 视线积分步数
    uLightSteps: { value: 8 },        // 太阳方向外散射步数
    uShadowSoftness: { value: 0.6 },  // 晨昏过渡带宽度
    uTwilight: { value: 0.3 },        // 暮光弧强度(0=贴地表, 1=完整几何地平下沉)
    uTonemap: { value: 1 },           // 0=Reinhard, 1=ACES filmic
    uOzone: { value: new THREE.Vector3(0.007, 0.02, 0.0009) }, // 臭氧吸收(绿>红>蓝)
    uDither: { value: 1.0 },          // raymarch 抖动强度(去 banding)
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
      uniform int   uSteps;
      uniform int   uLightSteps;
      uniform float uShadowSoftness;   // 晨昏过渡带宽度
      uniform float uTwilight;         // 暮光弧强度(0=贴地表, 1=完整几何地平下沉)
      uniform int   uTonemap;          // 0=Reinhard, 1=ACES filmic
      uniform vec3  uOzone;            // 臭氧吸收系数(只消光, 不散射)
      uniform float uDither;           // raymarch 起点抖动强度(去 banding)

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

      void main() {
        vec3 sceneColor = texture2D(tDiffuse, vUv).rgb;   // 线性 HDR
        if (uEnabled < 0.5) { gl_FragColor = vec4(tonemap(sceneColor), 1.0); return; }

        // 从深度重建视线方向与场景距离
        vec2 ndc = vUv * 2.0 - 1.0;
        vec4 farP = uInvViewProj * vec4(ndc, 1.0, 1.0);
        vec3 rd = normalize(farP.xyz / farP.w - uCamPos);
        vec3 ro = uCamPos;

        float depth = texture2D(tDepth, vUv).x;
        float sceneDist = 1e20;
        if (depth < 1.0) {
          vec4 hp = uInvViewProj * vec4(ndc, depth * 2.0 - 1.0, 1.0);
          sceneDist = distance(hp.xyz / hp.w, uCamPos);
        }

        // 视线在大气壳内的区间
        vec2 atmo = raySphere(ro, rd, uPlanetCenter, uRatmo);
        float tNear = max(atmo.x, 0.0);
        float tFar  = atmo.y;
        if (tFar <= tNear) { gl_FragColor = vec4(tonemap(sceneColor), 1.0); return; }

        // 止于真实地表(深度)或海平面球(海洋不写深度, 用解析球兜底)
        tFar = min(tFar, sceneDist);
        vec2 gnd = raySphere(ro, rd, uPlanetCenter, uRground);
        if (gnd.x > 0.0 && gnd.y > gnd.x) tFar = min(tFar, gnd.x);
        if (tFar <= tNear) { gl_FragColor = vec4(tonemap(sceneColor), 1.0); return; }

        int N = uSteps;
        float step = (tFar - tNear) / float(N);
        vec3 odView = vec3(0.0);
        vec3 sumR = vec3(0.0);
        vec3 sumM = vec3(0.0);

        // 起点抖动: 打散低步数产生的同心圆条带
        float jitter = mix(0.5, hash12(gl_FragCoord.xy), uDither);
        vec3 p = ro + rd * (tNear + step * jitter);
        for (int i = 0; i < 64; i++) {
          if (i >= N) break;
          vec3 dens = densityAt(p) * step;
          odView += dens;

          float shadow = planetShadow(p, uSunDir);
          if (shadow > 0.0) {
            vec3 odSun = opticalDepthToSun(p, uSunDir);
            // 消光 = 瑞利 + 米氏(散射×1.1) + 臭氧(纯吸收)
            vec3 tau = uScatterR * (odView.x + odSun.x)
                     + uScatterM * 1.1 * (odView.y + odSun.y)
                     + uOzone * (odView.z + odSun.z);
            vec3 T = exp(-tau) * shadow;   // 软遮挡: 晨昏线平滑过渡
            sumR += dens.x * T;
            sumM += dens.y * T;
          }
          p += rd * step;
        }

        // 相位函数
        float mu = dot(rd, uSunDir);
        float phaseR = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
        float g = uMieG, g2 = g * g;
        float phaseM = 3.0 / (8.0 * PI)
                     * ((1.0 - g2) * (1.0 + mu * mu))
                     / ((2.0 + g2) * pow(1.0 + g2 - 2.0 * g * mu, 1.5));

        // 线性 HDR 内散射(不在这里 tonemap, 留到末端统一处理)
        vec3 inscatter = uSunIntensity *
            (sumR * uScatterR * phaseR + sumM * uScatterM * phaseM);

        // aerial perspective: 地表颜色被视线透射率衰减(含臭氧), 再叠加内散射(全在线性 HDR 空间)
        vec3 Tview = exp(-(uScatterR * odView.x + uScatterM * 1.1 * odView.y + uOzone * odView.z));
        vec3 color = sceneColor * Tview + inscatter;

        gl_FragColor = vec4(tonemap(color), 1.0);   // 曝光 + ACES/Reinhard + sRGB
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
        float h = (r - uBottom) / max(uTop - uBottom, 1e-4);   // 0..1
        if (h < 0.0 || h > 1.0) return 0.0;
        // 高度权重: 中间浓、上下柔和渐隐(范围放宽, 过渡更软)
        float heightGrad = smoothstep(0.0, 0.3, h) * (1.0 - smoothstep(0.45, 1.0, h));

        vec3 sp = pos * uFreq + uWind * (uTime * uWindSpeed);
        float base;
        if (hi) {
          vec3 w = vec3(fbm(sp * 0.5 + 11.5, 2), fbm(sp * 0.5 + 47.2, 2), fbm(sp * 0.5 + 83.1, 2)) - 0.5;
          base = fbm(sp + uWarp * w, 4);
        } else {
          base = fbm(sp, 3);
        }
        // 关键: 先把噪声乘上高度权重再阈值化 → 云顶/云底被噪声啃成参差形状, 不再是平切的球面
        float thr = 1.0 - uCoverage;
        return smoothstep(thr, thr + 0.18, base * heightGrad);
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
        // 命中区间(取外壳内、内壳外的两段中靠前那段)
        float t0 = max(outer.x, 0.0);
        float t1 = outer.y;
        if (t1 <= t0) { gl_FragColor = vec4(sceneColor, 1.0); return; }
        // 若内壳被命中, 视线穿过空心区: 只积到内壳近交点(近段云)
        if (inner.x > t0 && inner.x < t1) t1 = inner.x;
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
            float day = dayFactor(p);
            // powder(糖粉暗边): 朝光的薄处偏暗, 增强体积感
            float powder = mix(1.0, 1.0 - exp(-dloc * uDensity * 2.0), uPowder);
            vec3 lit = uSunColor * (sun * day * phase * powder) + uAmbient;
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
