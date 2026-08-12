import { Matrix4, Vector3 } from '@orillusion/core';
import { Ray } from '../Controls/Ray.js';

let _matrix!: Matrix4;
// Matrix4 依赖 Engine3D.init 之后的全局矩阵池，模块级创建会在 init 前崩溃；
// 所有 scratch 矩阵延迟到首次使用时创建。
function ensureScratchMatrices(): void {
  if (_matrix) return;
  _matrix = new Matrix4();
}

const _norm = new Vector3();
const _vec = new Vector3();
const _vec2 = new Vector3();
const _ray = new Ray();

const EPSILON12 = 1e-12;
const CENTER_EPS = 0.1;

/** WGS84 长半轴（赤道半径，米）。 */
export const WGS84_RADIUS = 6378137;
/** WGS84 短半轴（极半径，米）。 */
export const WGS84_HEIGHT = 6356752.314245179;

/**
 * three.js 系三轴椭球数学类，1:1 移植自 3d-tiles-renderer 的
 * `src/three/renderer/math/Ellipsoid.js`（该方法集本身是 Cesium
 * Ellipsoid / scaleToGeodeticSurface / cartesianToCartographic 的移植）。
 * 所有经纬度均为弧度；calculateHorizonDistance 的纬度参数为度（与原版一致）。
 */
export class Ellipsoid {
  /** 半轴半径。 */
  public radius: Vector3;
  /** 可选名称。 */
  public name = '';

  public constructor(x = 1, y = 1, z = 1) {
    this.radius = new Vector3(x, y, z);
  }

  /** 射线与椭球面求交；命中写入 target 并返回，未命中返回 null。 */
  public intersectRay(ray: Ray, target: Vector3): Vector3 | null {
    ensureScratchMatrices();
    const { radius } = this;
    _matrix.identity().setScale(new Vector3(1 / radius.x, 1 / radius.y, 1 / radius.z));
    _ray.copy(ray).applyMatrix4(_matrix);
    const hit = _ray.intersectSphere(new Vector3(0, 0, 0), 1, target);
    if (hit === null) return null;
    _matrix.identity().setScale(radius);
    return target.applyMatrix4(_matrix);
  }

  /**
   * 射线到椭球面最近点的估计值；射线与椭球相交时返回精确交点，
   * 否则返回射线与球心最近点在椭球面上的投影。
   */
  public closestPointToRayEstimate(ray: Ray, target: Vector3): Vector3 {
    ensureScratchMatrices();
    const { radius } = this;
    if (this.intersectRay(ray, target)) return target;
    _matrix.identity().setScale(new Vector3(1 / radius.x, 1 / radius.y, 1 / radius.z));
    _ray.copy(ray).applyMatrix4(_matrix);
    _vec.set(0, 0, 0);
    _ray.closestPointToPoint(_vec, target).normalize();
    _matrix.identity().setScale(radius);
    return target.applyMatrix4(_matrix);
  }

  /** 椭球面上一点的法线（p / r² 归一化）。 */
  public getPositionToNormal(pos: Vector3, target: Vector3): Vector3 {
    const { radius } = this;
    target.copy(pos);
    target.x /= radius.x ** 2;
    target.y /= radius.y ** 2;
    target.z /= radius.z ** 2;
    return target.normalize();
  }

  /** 笛卡尔位置 → { lon, lat, height }（弧度）。 */
  public getPositionToCartographic(pos: Vector3, target: { lon: number; lat: number; height: number }): { lon: number; lat: number; height: number } {
    this.getPositionToSurfacePoint(pos, _vec);
    this.getPositionToNormal(_vec, _norm);
    _vec2.subVectors(pos, _vec);
    target.lon = Math.atan2(_norm.y, _norm.x);
    target.lat = Math.asin(_norm.z);
    target.height = Math.sign(_vec2.dot(pos)) * _vec2.length;
    return target;
  }

  /** 位置相对椭球面的高度（米）。 */
  public getPositionElevation(pos: Vector3): number {
    this.getPositionToSurfacePoint(pos, _vec);
    _vec2.subVectors(pos, _vec);
    return Math.sign(_vec2.dot(pos)) * _vec2.length;
  }

  /** 沿大地法线把位置投影到椭球面上（Cesium scaleToGeodeticSurface 的牛顿迭代移植）。 */
  public getPositionToSurfacePoint(pos: Vector3, target: Vector3): Vector3 | null {
    ensureScratchMatrices();
    const { radius } = this;
    const invRadiusSqX = 1 / radius.x ** 2;
    const invRadiusSqY = 1 / radius.y ** 2;
    const invRadiusSqZ = 1 / radius.z ** 2;

    const x2 = pos.x * pos.x * invRadiusSqX;
    const y2 = pos.y * pos.y * invRadiusSqY;
    const z2 = pos.z * pos.z * invRadiusSqZ;

    // 椭球范数平方。
    const squaredNorm = x2 + y2 + z2;
    const ratio = Math.sqrt(1 / squaredNorm);

    // 初始近似：径向交点。
    const intersection = _vec.copy(pos).multiplyScalar(ratio);
    if (squaredNorm < CENTER_EPS) {
      return !Number.isFinite(ratio) ? null : target.copy(intersection);
    }

    // 用交点处的梯度代替真实单位法线。
    const gradient = _vec2.set(
      intersection.x * invRadiusSqX * 2,
      intersection.y * invRadiusSqY * 2,
      intersection.z * invRadiusSqZ * 2,
    );

    // 法线乘子 lambda 的初始猜测。
    let lambda = ((1 - ratio) * pos.length) / (0.5 * gradient.length);
    let correction = 0;

    let func = 0;
    let denominator = 0;
    let xMultiplier = 0;
    let yMultiplier = 0;
    let zMultiplier = 0;
    let xMultiplier2 = 0;
    let yMultiplier2 = 0;
    let zMultiplier2 = 0;
    let xMultiplier3 = 0;
    let yMultiplier3 = 0;
    let zMultiplier3 = 0;

    do {
      lambda -= correction;

      xMultiplier = 1 / (1 + lambda * invRadiusSqX);
      yMultiplier = 1 / (1 + lambda * invRadiusSqY);
      zMultiplier = 1 / (1 + lambda * invRadiusSqZ);

      xMultiplier2 = xMultiplier * xMultiplier;
      yMultiplier2 = yMultiplier * yMultiplier;
      zMultiplier2 = zMultiplier * zMultiplier;

      xMultiplier3 = xMultiplier2 * xMultiplier;
      yMultiplier3 = yMultiplier2 * yMultiplier;
      zMultiplier3 = zMultiplier2 * zMultiplier;

      func = x2 * xMultiplier2 + y2 * yMultiplier2 + z2 * zMultiplier2 - 1;

      denominator =
        x2 * xMultiplier3 * invRadiusSqX +
        y2 * yMultiplier3 * invRadiusSqY +
        z2 * zMultiplier3 * invRadiusSqZ;

      const derivative = -2 * denominator;
      correction = func / derivative;
    } while (Math.abs(func) > EPSILON12);

    return target.set(
      pos.x * xMultiplier,
      pos.y * yMultiplier,
      pos.z * zMultiplier,
    );
  }

  /** 从给定纬度和海拔到地平线的几何距离（纬度单位为度，与原版一致）。 */
  public calculateHorizonDistance(latitude: number, elevation: number): number {
    const effectiveRadius = this.calculateEffectiveRadius(latitude);
    return Math.sqrt(2 * effectiveRadius * elevation + elevation ** 2);
  }

  /** 给定纬度处的卯酉圈曲率半径（Cesium 同款公式）。 */
  public calculateEffectiveRadius(latitude: number): number {
    const semiMajorAxis = this.radius.x;
    const semiMinorAxis = this.radius.z;
    const eSquared = 1 - semiMinorAxis ** 2 / semiMajorAxis ** 2;
    const phi = latitude * (Math.PI / 180);
    const sinPhiSquared = Math.sin(phi) ** 2;
    return semiMajorAxis / Math.sqrt(1 - eSquared * sinPhiSquared);
  }

  public copy(source: Ellipsoid): this {
    this.radius.copy(source.radius);
    return this;
  }

  public clone(): Ellipsoid {
    return new Ellipsoid().copy(this);
  }
}

/** WGS84 参考椭球（与 3d-tiles-renderer GeoConstants 一致）。 */
export const WGS84_ELLIPSOID = new Ellipsoid(WGS84_RADIUS, WGS84_RADIUS, WGS84_HEIGHT);
WGS84_ELLIPSOID.name = 'WGS84 Earth';
