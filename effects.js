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

// 大气辉光: 略大的球, 背面 + 加法混合, 边缘(临边)亮 → 环绕行星的光晕。
export function createAtmosphere() {
  const uniforms = {
    uColor: { value: new THREE.Color(0x5a99ff) },
    uPower: { value: 3.2 },
    uIntensity: { value: 1.3 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */`
      varying vec3 vNormalView;
      void main() {
        vNormalView = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      uniform float uPower;
      uniform float uIntensity;
      varying vec3 vNormalView;
      void main() {
        float rim = pow(max(0.0, 0.72 - dot(vNormalView, vec3(0.0, 0.0, 1.0))), uPower);
        gl_FragColor = vec4(uColor * rim * uIntensity, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 64), material);
  mesh.renderOrder = 2;
  return mesh;
}
