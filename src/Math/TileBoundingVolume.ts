import { Matrix4, Vector3 } from '@orillusion/core';

/** 3D Tiles 包围体原始定义。 */
export interface TileBoundingVolumeDefinition {
  box?: readonly number[];
  sphere?: readonly number[];
}

/**
 * 计算 3D Tiles 的球体和 OBB 包围体。
 */
export class TileBoundingVolume {
  private readonly center = new Vector3();
  private readonly halfAxes: [Vector3, Vector3, Vector3] = [new Vector3(), new Vector3(), new Vector3()];
  private radius = 0;
  private isSphere = false;

  /**
   * 创建包围体。
   * @param definition 3D Tiles JSON 中的 boundingVolume。
   * @param transform 瓦片继承后的世界变换矩阵。
   */
  public constructor(definition: TileBoundingVolumeDefinition, transform: Matrix4) {
    if (definition.sphere) {
      this.setSphere(definition.sphere, transform);
    } else if (definition.box) {
      this.setBox(definition.box, transform);
    } else {
      throw new Error('3D Tiles 瓦片缺少受支持的 boundingVolume。');
    }
  }

  /**
   * 获取相机到包围体表面的最短距离。
   * @param point 相机世界坐标。
   * @returns 距离，位于包围体内时为 0。
   */
  public distanceToPoint(point: Vector3): number {
    if (this.isSphere) {
      return Math.max(0, Vector3.distance(point, this.center) - this.radius);
    }

    const offset = Vector3.sub(point, this.center);
    let squaredDistance = 0;
    for (const axis of this.halfAxes) {
      const axisLength = axis.length;
      if (axisLength === 0) continue;
      const normalizedAxis = axis.clone().divideScalar(axisLength);
      const excess = Math.abs(Vector3.dot(offset, normalizedAxis)) - axisLength;
      if (excess > 0) squaredDistance += excess * excess;
    }
    return Math.sqrt(squaredDistance);
  }

  /**
   * 判断包围体是否可能出现在相机视锥中。
   * @param containsPoint Orillusion 视锥的点包含检测函数。
   * @returns 若相交或无法精确判定则返回 true，避免错误剔除。
   */
  public intersectsFrustum(containsPoint: (point: Vector3) => boolean): boolean {
    if (containsPoint(this.center)) return true;
    for (const corner of this.getCorners()) {
      if (containsPoint(corner)) return true;
    }
    // 当视锥完全落在大型包围体内时，中心和角点都可能位于视锥外；
    // 此处保守地保留瓦片，避免发生错误剔除。
    return true;
  }

  /**
   * 写入球形包围体数据。
   * @param sphere 球心 xyz 与半径。
   * @param transform 世界变换矩阵。
   */
  private setSphere(sphere: readonly number[], transform: Matrix4): void {
    this.isSphere = true;
    this.center.set(sphere[0] ?? 0, sphere[1] ?? 0, sphere[2] ?? 0);
    Matrix4.transformPoint(transform, this.center, this.center);
    const scale = new Vector3();
    scale.setFromMatrixScale(transform);
    this.radius = (sphere[3] ?? 0) * Math.max(scale.x, scale.y, scale.z);
  }

  /**
   * 写入 OBB 包围体数据。
   * @param box 中心 xyz 与 3 组半轴向量。
   * @param transform 世界变换矩阵。
   */
  private setBox(box: readonly number[], transform: Matrix4): void {
    this.center.set(box[0] ?? 0, box[1] ?? 0, box[2] ?? 0);
    Matrix4.transformPoint(transform, this.center, this.center);
    for (let index = 0; index < 3; index += 1) {
      const offset = 3 + index * 3;
      const axis = this.halfAxes[index];
      axis.set(box[offset] ?? 0, box[offset + 1] ?? 0, box[offset + 2] ?? 0);
      Matrix4.transformVector(transform, axis, axis);
    }
  }

  /**
   * 获取 OBB 的八个角点；球体返回六个轴向采样点。
   * @returns 用于视锥保守检测的世界坐标点。
   */
  private getCorners(): Vector3[] {
    if (this.isSphere) {
      return [
        new Vector3(this.center.x + this.radius, this.center.y, this.center.z),
        new Vector3(this.center.x - this.radius, this.center.y, this.center.z),
        new Vector3(this.center.x, this.center.y + this.radius, this.center.z),
        new Vector3(this.center.x, this.center.y - this.radius, this.center.z),
        new Vector3(this.center.x, this.center.y, this.center.z + this.radius),
        new Vector3(this.center.x, this.center.y, this.center.z - this.radius),
      ];
    }
    const corners: Vector3[] = [];
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
      corners.push(this.center.clone().addScaledVector(this.halfAxes[0], x).addScaledVector(this.halfAxes[1], y).addScaledVector(this.halfAxes[2], z));
    }
    return corners;
  }
}
