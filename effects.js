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

      const float PI = 3.14159265359;

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

      // 某点的相对密度 (x=瑞利, y=米氏), 边缘平滑归零
      vec2 densityAt(vec3 p) {
        float t = heightFrac(p);
        float edge = 1.0 - t;
        return vec2(exp(-t * uDensityFalloff) * edge,
                    exp(-t * uMieFalloff)     * edge);
      }

      // 从点 p 沿 dir 的大气光学深度 (瑞利, 米氏)。撞地面则只积到地表(有限值),
      // 遮挡由 planetShadow() 平滑处理, 不再硬性丢弃 → 避免晨昏线硬边。
      vec2 opticalDepthToSun(vec3 p, vec3 dir) {
        vec2 a = raySphere(p, dir, uPlanetCenter, uRatmo);
        float far = max(a.y, 0.0);
        vec2 g = raySphere(p, dir, uPlanetCenter, uRground);
        if (g.x > 0.0 && g.y > g.x) far = min(far, g.x);
        int N = uLightSteps;
        float step = far / float(N);
        vec2 od = vec2(0.0);
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
        vec2 odView = vec2(0.0);
        vec3 sumR = vec3(0.0);
        vec3 sumM = vec3(0.0);

        vec3 p = ro + rd * (tNear + step * 0.5);
        for (int i = 0; i < 64; i++) {
          if (i >= N) break;
          vec2 dens = densityAt(p) * step;
          odView += dens;

          float shadow = planetShadow(p, uSunDir);
          if (shadow > 0.0) {
            vec2 odSun = opticalDepthToSun(p, uSunDir);
            vec3 tau = uScatterR * (odView.x + odSun.x)
                     + uScatterM * 1.1 * (odView.y + odSun.y);
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

        // aerial perspective: 地表颜色被视线透射率衰减, 再叠加内散射(全在线性 HDR 空间)
        vec3 Tview = exp(-(uScatterR * odView.x + uScatterM * 1.1 * odView.y));
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
