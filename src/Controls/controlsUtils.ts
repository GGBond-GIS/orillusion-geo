import { Camera3D, Matrix4, Quaternion, Vector2, Vector3 } from '@orillusion/core';
import type { Raycaster } from '../ray-pick/Raycaster.js';
import { Ray } from './Ray.js';

let _matrix!: Matrix4;
// Matrix4 依赖 Engine3D.init 之后的全局矩阵池，模块级创建会在 init 前崩溃；
// 所有 scratch 矩阵延迟到首次使用时创建。
function ensureScratchMatrices(): void {
  if (_matrix) return;
  _matrix = new Matrix4();
}


export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function lerp(x: number, y: number, t: number): number {
  return (1 - t) * x + t * y;
}

export function mapLinear(x: number, a1: number, a2: number, b1: number, b2: number): number {
  return b1 + ((x - a1) * (b2 - b1)) / (a2 - a1);
}

/**
 * 构造绕点旋转矩阵：T(point) · R · T(-point)。
 * 1:1 移植自 3d-tiles-renderer `controls/utils.js` 的 makeRotateAroundPoint。
 */
export function makeRotateAroundPoint(point: Vector3, quat: Quaternion, target: Matrix4): Matrix4 {
    ensureScratchMatrices();
  target.identity();
  target.rawData[12] = -point.x;
  target.rawData[13] = -point.y;
  target.rawData[14] = -point.z;

  _matrix.makeRotationFromQuaternion(quat);
  target.premultiply(_matrix);

  _matrix.identity();
  _matrix.rawData[12] = point.x;
  _matrix.rawData[13] = point.y;
  _matrix.rawData[14] = point.z;
  target.premultiply(_matrix);

  return target;
}

/**
 * 把元素相对像素坐标换算为 NDC 坐标（写入 target），与 three.js 原版一致。
 * 注意 y 必须翻转：屏幕原点在左上、y 向下，而 WebGPU/Orillusion 的 NDC
 * y 向上（拾取管线 Picker_cs 按 (1 - 2y/h) 的约定采样 GBuffer，实测像素
 * 拾取即按此约定重建出正确世界坐标）。控制器射线必须与拾取同一约定，
 * 否则拾取/拖拽点会沿屏幕 y 镜像（曾因去掉此翻转导致拖拽抓点反向）。
 */
export function adjustedPointerToCoords(pointer: Vector2, element: HTMLElement, target: Vector2): Vector2 {
  target.x = (pointer.x / element.clientWidth) * 2 - 1;
  target.y = -(pointer.y / element.clientHeight) * 2 + 1;
  return target;
}

/**
 * 由相机与 NDC 坐标构造射线（origin 为相机位置，direction 指向场景内）。
 *
 * fork 渲染管线的真实约定（逆向自 ORI_Vert 顶点着色器与拾取标定）：
 *  - 顶点着色器把视图矩阵的平移列清零（fixViewMat[3].xyz = 0），并把投影的
 *    z 列改写成 clip.z = w —— 渲染等效于"相机位于原点、只带旋转"的透视；
 *  - 投影矩阵 x 列为负（a[0] = -cot(fov/2)/aspect），NDC x 与屏幕 x 镜像；
 *  - 该约定下 NDC → 视图空间方向 = (ndcX / a[0], ndcY / a[5], 1)，经
 *    平移清零视图的逆（纯旋转）变换回世界空间即得像素射线方向。
 * 本实现已用 pixel 拾取逐点标定（屏幕上下/左右多像素）：x 与 y 均与拾取
 * 重建的命中点精确一致。注意 coords.y 必须是 y 向上的 NDC（即先经
 * adjustedPointerToCoords 翻转），否则射线沿屏幕 y 镜像。
 */
export function setRayFromCamera(ray: Ray, coords: { x: number; y: number }, camera: Camera3D): Ray {
  ensureScratchMatrices();
  const { origin, direction } = ray;

  const raw = camera.projectionMatrix.rawData;
  const a0 = raw[0]; // -cot(fov/2) / aspect
  const a5 = raw[5]; //  cot(fov/2)

  // 平移清零的视图矩阵（渲染等效相机位于原点、只带旋转）的逆 = 其旋转块的
  // 转置 Rᵀ（世界方向 = Rᵀ · 视图方向）。注意必须先清零平移再求逆：
  // 先求逆再清零会把 R 与 Rᵀ 弄反（曾导致射线方向 x 分量丢失、落点偏移）。
  _matrix.copy(camera.viewMatrix);
  _matrix.rawData[12] = 0;
  _matrix.rawData[13] = 0;
  _matrix.rawData[14] = 0;
  _matrix.invert();

  direction.set(coords.x / a0, coords.y / a5, 1).transformDirection(_matrix);
  origin.copy(camera.object3D.transform.worldPosition);
  return ray;
}

/**
 * 由相机与 NDC 坐标设置 ray-pick `Raycaster` 的射线（origin 为相机位置，
 * direction 指向场景内）。数学与 `setRayFromCamera` 完全一致（fork 渲染管线
 * 的标定约定），只是写入 ray-pick 包自带的引擎 Ray（`raycaster.ray`），供
 * `raycaster.intersectScene` 做 CPU 三角形求交。
 */
export function setRaycasterFromCamera(raycaster: Raycaster, coords: { x: number; y: number }, camera: Camera3D): Raycaster {
  ensureScratchMatrices();
  const { origin, direction } = raycaster.ray;

  const raw = camera.projectionMatrix.rawData;
  const a0 = raw[0]; // -cot(fov/2) / aspect
  const a5 = raw[5]; //  cot(fov/2)

  _matrix.copy(camera.viewMatrix);
  _matrix.rawData[12] = 0;
  _matrix.rawData[13] = 0;
  _matrix.rawData[14] = 0;
  _matrix.invert();

  direction.set(coords.x / a0, coords.y / a5, 1).transformDirection(_matrix);
  origin.copy(camera.object3D.transform.worldPosition);
  return raycaster;
}

/**
 * 把世界矩阵分解为 position / quaternion / scale（three.js Matrix4.decompose 算法）。
 * 旋转矩阵由归一化列基构造后交给 Quaternion.setFromRotationMatrix。
 */
export function decomposeMatrix4(matrix: Matrix4, position: Vector3, quaternion: Quaternion, scale: Vector3): void {
    ensureScratchMatrices();
  const raw = matrix.rawData;
  position.set(raw[12], raw[13], raw[14]);

  const sx = Math.hypot(raw[0], raw[1], raw[2]);
  const sy = Math.hypot(raw[4], raw[5], raw[6]);
  const sz = Math.hypot(raw[8], raw[9], raw[10]);
  scale.set(sx, sy, sz);

  _matrix.identity();
  const basis = _matrix.rawData;
  basis[0] = raw[0] / sx;
  basis[1] = raw[1] / sx;
  basis[2] = raw[2] / sx;
  basis[4] = raw[4] / sy;
  basis[5] = raw[5] / sy;
  basis[6] = raw[6] / sy;
  basis[8] = raw[8] / sz;
  basis[9] = raw[9] / sz;
  basis[10] = raw[10] / sz;
  quaternion.setFromRotationMatrix(_matrix);
}
