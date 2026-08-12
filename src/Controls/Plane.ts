import { Vector3 } from '@orillusion/core';

/**
 * three.js `Plane` 的对齐移植（Orillusion 数学库与 three.js 对齐）。
 * 控制器只用到 setFromNormalAndCoplanarPoint / copy / clone 子集。
 */
export class Plane {
  public normal: Vector3;
  public constant: number;

  public constructor(normal: Vector3 = new Vector3(0, 1, 0), constant = 0) {
    this.normal = normal;
    this.constant = constant;
  }

  public set(normal: Vector3, constant: number): this {
    this.normal.copy(normal);
    this.constant = constant;
    return this;
  }

  public setComponents(x: number, y: number, z: number, w: number): this {
    this.normal.set(x, y, z);
    this.constant = w;
    return this;
  }

  /** 由法线和一个共面点构造平面：constant = -n·p。 */
  public setFromNormalAndCoplanarPoint(normal: Vector3, point: Vector3): this {
    this.normal.copy(normal);
    this.constant = -point.dot(this.normal);
    return this;
  }

  public copy(plane: Plane): this {
    this.normal.copy(plane.normal);
    this.constant = plane.constant;
    return this;
  }

  public clone(): Plane {
    return new Plane().copy(this);
  }
}
