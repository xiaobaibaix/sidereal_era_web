// 行星表面角色控制器(戴森球计划伊卡洛斯式第三人称)。
//
// 碰撞: 地形是沿半径的高度场, 直接解析采样 planet.heightAt 得到脚下地面半径,
//       无需预生成碰撞网格(解析值即"最高细分"的精确值)。
// 朝向: 上方向 = 径向; 重力指向球心; WASD 在切平面移动; 鼠标控制第三人称相机 yaw/pitch。

import * as THREE from 'three';

export class PlanetWalker {
  constructor(planet, domElement) {
    this.planet = planet;
    this.dom = domElement;
    this.enabled = false;

    // 可调参数
    this.speed = 25;
    this.jumpSpeed = 22;
    this.gravity = 32;
    this.sens = 0.0025;
    this.invertY = true;      // 反转上下视角
    this.feetOffset = 2.0;    // 胶囊中心到脚底(= 胶囊半高)
    this.camDist = 14;
    this.camHeight = 6;
    this.camClearance = 5.0;  // 相机离地最小间隙(避免近裁面斜切前方地形)
    this.pitchMin = -0.2;     // 俯仰下限(越负越能仰头看天; 太接近 -π/2 相机会翻转)
    this.pitchMax = 1.35;     // 俯仰上限(越大越俯瞰; 太接近 +π/2 相机会翻转)

    // 状态
    this.position = new THREE.Vector3(0, planet.params.radius + 5, 0);
    this.forward = new THREE.Vector3(0, 0, -1);
    this.pitch = 0.55;
    this.radialVel = 0;
    this.grounded = false;
    this.active = false;      // 仅当角色是主画面时接管输入
    this._dYaw = 0; this._dPitch = 0;
    this.keys = {};

    // 胶囊
    const geo = new THREE.CapsuleGeometry(1, 2, 8, 16);
    const mat = new THREE.MeshStandardMaterial({ color: 0xffb347, roughness: 0.6, metalness: 0.1 });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.visible = false;

    // 相机
    this.camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 200000);

    // 复用向量
    this._n = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._move = new THREE.Vector3();
    this._back = new THREE.Vector3();
    this._x = new THREE.Vector3();
    this._m = new THREE.Matrix4();
    this._arm = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
    this._look = new THREE.Vector3();

    // 绑定事件处理器
    this._onKeyDown = (e) => { this.keys[e.code] = true; if (this.active && this._locked && e.code === 'Space') e.preventDefault(); };
    this._onKeyUp = (e) => { this.keys[e.code] = false; };
    this._onClick = () => { if (this.enabled && this.active && !this._locked) this.dom.requestPointerLock(); };
    this._onMove = (e) => { if (this._locked) { this._dYaw -= e.movementX * this.sens; this._dPitch += e.movementY * this.sens * (this.invertY ? 1 : -1); } };
    this._onLockChange = () => { this._locked = (document.pointerLockElement === this.dom); };
    this._locked = false;
  }

  groundRadius(n) {
    return this.planet.params.radius + this.planet.heightAt(n.x, n.y, n.z) * this.planet.params.maxHeight;
  }

  // dir: 出生方向(单位向量)
  enable(dir) {
    this.enabled = true;
    this.mesh.visible = true;
    const n = dir.clone().normalize();
    // 初始 forward: 世界上方向投影到切平面(极点处退化则用 X 轴)
    const wu = Math.abs(n.y) > 0.99 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    this.forward.copy(wu).addScaledVector(n, -wu.dot(n)).normalize();
    this.radialVel = 0;
    const r = this.groundRadius(n) + this.feetOffset;
    this.position.copy(n).multiplyScalar(r);
    this.pitch = 0.55; this._dYaw = 0; this._dPitch = 0; this.keys = {};

    addEventListener('keydown', this._onKeyDown);
    addEventListener('keyup', this._onKeyUp);
    this.dom.addEventListener('click', this._onClick);
    document.addEventListener('mousemove', this._onMove);
    document.addEventListener('pointerlockchange', this._onLockChange);
  }

  disable() {
    this.enabled = false;
    this.mesh.visible = false;
    if (this._locked) document.exitPointerLock();
    removeEventListener('keydown', this._onKeyDown);
    removeEventListener('keyup', this._onKeyUp);
    this.dom.removeEventListener('click', this._onClick);
    document.removeEventListener('mousemove', this._onMove);
    document.removeEventListener('pointerlockchange', this._onLockChange);
  }

  // 是否接管输入(仅当角色是主画面)。非激活时释放鼠标锁并清空累积。
  setActive(v) {
    this.active = v;
    if (!v) { if (this._locked) document.exitPointerLock(); this._dYaw = 0; this._dPitch = 0; }
  }

  update(dt) {
    if (!this.enabled) return;

    // 当前径向上方向
    this._n.copy(this.position).normalize();

    // 鼠标: yaw 绕 up 旋转 forward, pitch 调相机仰角(仅激活时)
    if (this.active) {
      if (this._dYaw) { this.forward.applyAxisAngle(this._n, this._dYaw); this._dYaw = 0; }
      this.pitch = Math.max(this.pitchMin, Math.min(this.pitchMax, this.pitch + this._dPitch)); this._dPitch = 0;
    } else { this._dYaw = 0; this._dPitch = 0; }

    // forward 重新投影到切平面
    this.forward.addScaledVector(this._n, -this.forward.dot(this._n));
    if (this.forward.lengthSq() < 1e-6) this.forward.set(1, 0, 0);
    this.forward.normalize();
    this._right.crossVectors(this.forward, this._n).normalize();

    // 切平面移动(仅激活时)
    let mz = 0, mx = 0;
    if (this.active) {
      if (this.keys['KeyW']) mz += 1;
      if (this.keys['KeyS']) mz -= 1;
      if (this.keys['KeyD']) mx += 1;
      if (this.keys['KeyA']) mx -= 1;
    }
    this._move.set(0, 0, 0).addScaledVector(this.forward, mz).addScaledVector(this._right, mx);
    if (this._move.lengthSq() > 0) {
      this._move.normalize().multiplyScalar(this.speed * dt);
      this.position.add(this._move);
    }

    // 水平移动后重新求 up, 再处理重力/地面(径向)
    this._n.copy(this.position).normalize();
    this.radialVel -= this.gravity * dt;
    let r = this.position.length() + this.radialVel * dt;
    const groundR = this.groundRadius(this._n) + this.feetOffset;
    if (r <= groundR) { r = groundR; this.radialVel = 0; this.grounded = true; }
    else this.grounded = false;
    if (this.active && this.grounded && this.keys['Space']) this.radialVel = this.jumpSpeed;
    this.position.copy(this._n).multiplyScalar(r);

    // 胶囊朝向: 局部 +Y = up, -Z = forward
    this._back.copy(this.forward).negate();
    this._x.crossVectors(this._n, this._back).normalize();
    this._m.makeBasis(this._x, this._n, this._back);
    this.mesh.quaternion.setFromRotationMatrix(this._m);
    this.mesh.position.copy(this.position);

    // 第三人称相机(斜后上方), 带地形穿透保护
    this._arm.copy(this._back).multiplyScalar(Math.cos(this.pitch)).addScaledVector(this._n, Math.sin(this.pitch));
    this._camPos.copy(this.position).addScaledVector(this._n, this.camHeight).addScaledVector(this._arm, this.camDist);
    const cn = this._camPos.clone().normalize();
    const camGround = this.groundRadius(cn) + this.camClearance;
    if (this._camPos.length() < camGround) this._camPos.copy(cn).multiplyScalar(camGround);
    this.camera.position.copy(this._camPos);
    this.camera.up.copy(this._n);
    this._look.copy(this.position).addScaledVector(this._n, this.camHeight * 0.6);
    this.camera.lookAt(this._look);
  }
}
