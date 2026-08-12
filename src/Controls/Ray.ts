import { Matrix4, Vector3 } from '@orillusion/core';

const _scratch = new Vector3();
const _scratch2 = new Vector3();

/**
 * three.js `Ray` 的对齐移植（Orillusion 数学库与 three.js 对齐）。
 * 仅实现 3d-tiles-renderer 控制器用到的子集：at / recast / applyMatrix4 /
 * intersectSphere / closestPointToPoint / intersectPlane。
 */
export class Ray {
  public origin: Vector3;
  public direction: Vector3;

  public constructor(origin: Vector3 = new Vector3(), direction: Vector3 = new Vector3()) {
    this.origin = origin;
    this.direction = direction;
  }

  public set(origin: Vector3, direction: Vector3): this {
    this.origin.copy(origin);
    this.direction.copy(direction);
    return this;
  }

  public copy(ray: Ray): this {
    this.origin.copy(ray.origin);
    this.direction.copy(ray.direction);
    return this;
  }

  public clone(): Ray {
    return new Ray().copy(this);
  }

  /** origin + direction * t。 */
  public at(t: number, target: Vector3 = new Vector3()): Vector3 {
    return target.copy(this.direction).multiplyScalar(t).add(this.origin);
  }

  public normalize(): this {
    this.direction.normalize();
    return this;
  }

  /** 沿方向平移原点。 */
  public recast(t: number): this {
    this.origin.addScaledVector(this.direction, t);
    return this;
  }

  /** 原点做完整 4x4 变换，方向做 3x3 方向变换（与 three.js 一致）。 */
  public applyMatrix4(matrix: Matrix4): this {
    this.origin.applyMatrix4(matrix);
    this.direction.transformDirection(matrix);
    return this;
  }

  /** 射线与球求交；命中写入 target 并返回，未命中返回 null。 */
  public intersectSphere(center: Vector3, radius: number, target: Vector3): Vector3 | null {
    _scratch.subVectors(this.origin, center);
    const a = this.direction.dot(this.direction);
    const b = 2 * _scratch.dot(this.direction);
    const c = _scratch.dot(_scratch) - radius * radius;
    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) return null;
    const t = (-b - Math.sqrt(discriminant)) / (2 * a);
    if (t < 0) return null;
    return this.at(t, target);
  }

  /** 射线上离指定点最近的点。 */
  public closestPointToPoint(point: Vector3, target: Vector3): Vector3 {
    _scratch.subVectors(point, this.origin);
    const t = _scratch.dot(this.direction);
    if (t < 0) return target.copy(this.origin);
    return target.copy(this.direction).multiplyScalar(t).add(this.origin);
  }

  /** 射线与平面求交；命中写入 target 并返回，未命中返回 null。 */
  public intersectPlane(normal: Vector3, constant: number, target: Vector3): Vector3 | null {
    const denominator = this.direction.dot(normal);
    if (denominator === 0) return null;
    const t = -(this.origin.dot(normal) + constant) / denominator;
    if (t < 0) return null;
    return this.at(t, target);
  }

  /** 射线起点到平面上一点的符号距离（用于 distance 排序）。 */
  public distanceToPoint(point: Vector3): number {
    return Math.sqrt(this.distanceSqToPoint(point));
  }

  public distanceSqToPoint(point: Vector3): number {
    _scratch.subVectors(point, this.origin);
    const directionDistance = _scratch.dot(this.direction);
    if (directionDistance < 0) return _scratch.dot(_scratch);
    _scratch2.copy(this.direction).multiplyScalar(directionDistance).add(this.origin);
    return _scratch2.sub(point).lengthSq();
  }
}
