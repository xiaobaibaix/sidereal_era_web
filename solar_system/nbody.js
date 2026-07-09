// N-body 引力内核(纯物理, 不依赖渲染)。
//
// 位置/速度用 THREE.Vector3 —— 其分量是 JS number(float64), 所以 CPU 端物理天然是双精度,
// 能表示很大的坐标而不丢精度; 渲染时再转成相机相对的小坐标(float32)。
//
// 积分器: velocity-Verlet(辛积分, 长期能量稳定; 普通欧拉会让轨道漂移/飞散)。
// 引力: 两两 F = G·m1·m2/r², 带软化 eps 避免近距奇点。

import * as THREE from 'three';

export class Body {
  constructor({ name, mass, pos, vel, radius = 1, color = 0xffffff, type = 'planet' }) {
    this.name = name;
    this.mass = mass;
    this.pos = pos ? pos.clone() : new THREE.Vector3();
    this.vel = vel ? vel.clone() : new THREE.Vector3();
    this.acc = new THREE.Vector3();
    this._accOld = new THREE.Vector3();
    this.radius = radius;
    this.color = color;
    this.type = type;              // 'star' | 'planet' | 'moon' | 'asteroid'
  }
}

export class NBodySystem {
  constructor({ G = 1, softening = 1 } = {}) {
    this.bodies = [];
    this.G = G;
    this.softening = softening;    // 软化长度(避免 r→0 时力爆炸)
    this.time = 0;
  }

  add(body) { this.bodies.push(body); return body; }
  clear() { this.bodies.length = 0; this.time = 0; }

  // 计算所有天体的加速度(两两引力), 写入 body.acc
  computeAccelerations() {
    const b = this.bodies, n = b.length, G = this.G;
    const eps2 = this.softening * this.softening;
    for (let i = 0; i < n; i++) b[i].acc.set(0, 0, 0);
    for (let i = 0; i < n; i++) {
      const bi = b[i];
      for (let j = i + 1; j < n; j++) {
        const bj = b[j];
        const dx = bj.pos.x - bi.pos.x;
        const dy = bj.pos.y - bi.pos.y;
        const dz = bj.pos.z - bi.pos.z;
        const r2 = dx * dx + dy * dy + dz * dz + eps2;
        const invR = 1.0 / Math.sqrt(r2);
        const invR3 = invR / r2;                 // 1/r³
        const s = G * invR3;
        // a_i += G·m_j/r³ · d ;  a_j -= G·m_i/r³ · d
        const si = s * bj.mass, sj = s * bi.mass;
        bi.acc.x += si * dx; bi.acc.y += si * dy; bi.acc.z += si * dz;
        bj.acc.x -= sj * dx; bj.acc.y -= sj * dy; bj.acc.z -= sj * dz;
      }
    }
  }

  // 一步 velocity-Verlet:
  //   x(t+dt) = x + v·dt + ½·a·dt²
  //   v(t+dt) = v + ½·(a + a_new)·dt
  step(dt) {
    const b = this.bodies, n = b.length;
    if (n === 0) return;
    this.computeAccelerations();                 // a(t)
    const half = 0.5 * dt * dt;
    for (let i = 0; i < n; i++) {
      const p = b[i];
      p.pos.x += p.vel.x * dt + p.acc.x * half;
      p.pos.y += p.vel.y * dt + p.acc.y * half;
      p.pos.z += p.vel.z * dt + p.acc.z * half;
      p._accOld.copy(p.acc);
    }
    this.computeAccelerations();                 // a(t+dt)
    const hdt = 0.5 * dt;
    for (let i = 0; i < n; i++) {
      const p = b[i];
      p.vel.x += (p._accOld.x + p.acc.x) * hdt;
      p.vel.y += (p._accOld.y + p.acc.y) * hdt;
      p.vel.z += (p._accOld.z + p.acc.z) * hdt;
    }
    this.time += dt;
  }

  // 在 primary 周围加一个圆轨道天体(v = √(G·M_primary / r), 垂直于连线)。
  // 速度叠加 primary 自身速度 → 天然支持嵌套(卫星绕行星绕恒星)。
  addOrbiting(primary, opts) {
    const { mass, radius = 1, dist, phase = 0, inclination = 0, retro = false,
            color = 0xffffff, name = '', type = 'planet' } = opts;
    // 轨道平面内的位置偏移(默认 xz 平面, 再绕 x 轴倾斜 inclination)
    const off = new THREE.Vector3(Math.cos(phase) * dist, 0, Math.sin(phase) * dist);
    // 前向切向(逆行时反向)
    const tang = new THREE.Vector3(-Math.sin(phase), 0, Math.cos(phase));
    if (retro) tang.negate();
    if (inclination !== 0) {
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), inclination);
      off.applyQuaternion(q);
      tang.applyQuaternion(q);
    }
    const speed = Math.sqrt(this.G * primary.mass / dist);
    const pos = primary.pos.clone().add(off);
    const vel = primary.vel.clone().addScaledVector(tang, speed);
    const body = new Body({ name, mass, pos, vel, radius, color, type });
    body.primary = primary;         // 记录主星(画轨道椭圆用)
    return this.add(body);
  }

  // 归零总动量 → 质心不漂移(整个系统留在原地)
  zeroMomentum() {
    const p = new THREE.Vector3();
    let M = 0;
    for (const bd of this.bodies) { p.addScaledVector(bd.vel, bd.mass); M += bd.mass; }
    if (M <= 0) return;
    const vcm = p.multiplyScalar(1 / M);
    for (const bd of this.bodies) bd.vel.sub(vcm);
  }

  // 质心(浮动原点/聚焦可用)
  barycenter(out = new THREE.Vector3()) {
    out.set(0, 0, 0);
    let M = 0;
    for (const bd of this.bodies) { out.addScaledVector(bd.pos, bd.mass); M += bd.mass; }
    if (M > 0) out.multiplyScalar(1 / M);
    return out;
  }

  // 总能量(动能 + 势能), 用于验证积分稳定性(应基本守恒)
  energy() {
    const b = this.bodies, n = b.length, G = this.G;
    let ke = 0, pe = 0;
    for (let i = 0; i < n; i++) ke += 0.5 * b[i].mass * b[i].vel.lengthSq();
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const r = b[i].pos.distanceTo(b[j].pos) + 1e-9;
        pe -= G * b[i].mass * b[j].mass / r;
      }
    }
    return { ke, pe, total: ke + pe };
  }
}
