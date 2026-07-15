// 球面锚点 —— 把"单位方向 dir + 朝向 yaw"变成落在地表的世界矩阵; 以及屏幕点击 → 地表方向。
// 与挖掘机放置同一套(heightAt 求落地半径 + 切平面基 makeBasis)。
// 依赖 three.js 的向量/矩阵数学(不含 WebGL) —— 由渲染/App 层用, 不进 node 无头测试。

import * as THREE from 'three';

const _n = new THREE.Vector3();
const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3();

// dir: 单位方向(行星本地系); yaw: 绕径向的朝向弧度; planet: Planet 实例; outMatrix: THREE.Matrix4
export function worldMatrix(dir, yaw, planet, outMatrix, scale = 1) {
  _n.set(dir[0] !== undefined ? dir[0] : dir.x, dir[1] !== undefined ? dir[1] : dir.y, dir[2] !== undefined ? dir[2] : dir.z).normalize();
  // 切平面基向量 t1 ⟂ n
  if (Math.abs(_n.y) < 0.99) _t1.set(0, 1, 0); else _t1.set(1, 0, 0);
  _t1.crossVectors(_t1, _n).normalize();
  // forward = t1 绕 n 转 yaw; right = n × forward
  _f.copy(_t1).applyAxisAngle(_n, yaw || 0).normalize();
  _r.crossVectors(_n, _f).normalize();
  outMatrix.makeBasis(_r, _n, _f);           // x=right, y=up(径向), z=forward
  if (scale !== 1) outMatrix.scale(_scale.set(scale, scale, scale));
  const p = planet.params;
  const rr = p.radius + planet.heightAt(_n.x, _n.y, _n.z) * p.maxHeight;
  _pos.copy(_n).multiplyScalar(rr).add(planet.position);
  outMatrix.setPosition(_pos);
  return outMatrix;
}

// 移动 agent 的世界矩阵: up=径向 dir, forward=fwd 投影到切平面(行进朝向), right=up×forward。
// fwd 可为任意方向(会去掉径向分量并归一); 若 fwd 与 dir 共线则退回任意切向。
export function worldMatrixHeading(dir, fwd, planet, outMatrix, scale = 1) {
  _n.set(dir[0] !== undefined ? dir[0] : dir.x, dir[1] !== undefined ? dir[1] : dir.y, dir[2] !== undefined ? dir[2] : dir.z).normalize();
  _f.set(fwd[0] !== undefined ? fwd[0] : fwd.x, fwd[1] !== undefined ? fwd[1] : fwd.y, fwd[2] !== undefined ? fwd[2] : fwd.z);
  _f.addScaledVector(_n, -_f.dot(_n));       // 去掉径向分量 → 落到切平面
  if (_f.lengthSq() < 1e-12) {               // fwd 与 dir 共线 → 取任意切向
    if (Math.abs(_n.y) < 0.99) _t1.set(0, 1, 0); else _t1.set(1, 0, 0);
    _f.crossVectors(_t1, _n);
  }
  _f.normalize();
  _r.crossVectors(_n, _f).normalize();
  outMatrix.makeBasis(_r, _n, _f);           // x=right, y=up(径向), z=forward
  if (scale !== 1) outMatrix.scale(_scale.set(scale, scale, scale));
  const p = planet.params;
  const rr = p.radius + planet.heightAt(_n.x, _n.y, _n.z) * p.maxHeight;
  _pos.copy(_n).multiplyScalar(rr).add(planet.position);
  outMatrix.setPosition(_pos);
  return outMatrix;
}

// 地表落地半径(供放置/碰撞用)
export function groundRadius(dir, planet) {
  const p = planet.params;
  return p.radius + planet.heightAt(dir[0], dir[1], dir[2]) * p.maxHeight;
}

const _ray = new THREE.Raycaster();
const _ndc = new THREE.Vector2();
// 屏幕坐标 → 行星表面单位方向(本地系); 未命中返回 null
export function pick(clientX, clientY, cam, planet, w, h) {
  const W = w || (typeof innerWidth !== 'undefined' ? innerWidth : 1);
  const H = h || (typeof innerHeight !== 'undefined' ? innerHeight : 1);
  _ndc.set((clientX / W) * 2 - 1, -(clientY / H) * 2 + 1);
  _ray.setFromCamera(_ndc, cam);
  const hits = _ray.intersectObject(planet, true);
  if (!hits.length) return null;
  return hits[0].point.clone().sub(planet.position).normalize();
}
