import { BoundingSphere, Cartesian3, type TerrainProvider, type TilingScheme } from '@cesium/engine';
// @ts-expect-error Cesium 将 Globe 使用的 EllipsoidalOccluder 保留在 Source 内部，运行时代码随 engine 包发布。
import EllipsoidalOccluder from '@cesium/engine/Source/Core/EllipsoidalOccluder.js';
import type { Camera3D } from '@orillusion/core';
import type { TerrainTileKey } from './TerrainTileState.js';

/** Globe 四叉树选择参数。 */
export interface GlobeQuadtreeOptions {
  /** Cesium 地形提供器。 */
  terrainProvider: TerrainProvider;
  /** Orillusion 相机。 */
  camera: Camera3D;
  /** 与 Cesium QuadtreePrimitive 对齐的最大屏幕空间误差。 */
  maximumScreenSpaceError?: number;
  /** 可选择的最大层级。 */
  maximumLevel?: number;
  /** 单帧最多请求的叶瓦片数量，防止视锥外递归造成突发请求。 */
  maximumTiles?: number;
}

/** Cesium visitTile 遍历期间的叶节点及其细化优先级。 */
interface GlobeTraversalLeaf {
  /** 当前叶瓦片。 */
  tile: TerrainTileKey;
  /** 当前相机下的屏幕空间误差。 */
  screenSpaceError: number;
  /** 达到预算或数据层级后是否仍允许细化。 */
  refinable: boolean;
}

/**
 * 从 Cesium QuadtreePrimitive 抽取的瓦片选择器。
 * 使用 terrainProvider.getLevelMaximumGeometricError、Cesium BoundingSphere 和
 * 相同的 SSE 公式决定何时从父瓦片细化到四个子瓦片；资源加载仍交由 CesiumSurfaceTile。
 */
export class GlobeQuadtree {
  /** 最大屏幕空间误差，单位为像素。 */
  public maximumScreenSpaceError: number;
  /** 最大细化层级。 */
  public maximumLevel: number;
  /** 每帧选择上限。 */
  public maximumTiles: number;
  private readonly terrainProvider: TerrainProvider;
  private readonly camera: Camera3D;
  private readonly tilingScheme: TilingScheme;
  private readonly occluder: EllipsoidalOccluder;

  /**
   * 创建 Cesium 风格的四叉树选择器。
   * @param options 地形、相机和 LOD 约束。
   */
  public constructor(options: GlobeQuadtreeOptions) {
    this.terrainProvider = options.terrainProvider;
    this.camera = options.camera;
    this.tilingScheme = options.terrainProvider.tilingScheme;
    this.occluder = new EllipsoidalOccluder(this.tilingScheme.ellipsoid);
    this.maximumScreenSpaceError = options.maximumScreenSpaceError ?? 2;
    this.maximumLevel = options.maximumLevel ?? 17;
    this.maximumTiles = options.maximumTiles ?? 256;
  }

  /**
   * 为当前相机选择所需的地形叶瓦片。
   * @returns 通过 Cesium SSE 筛选出的可见叶瓦片。
   */
  public select(): TerrainTileKey[] {
    const leaves: GlobeTraversalLeaf[] = [];
    const rootsX = this.tilingScheme.getNumberOfXTilesAtLevel(0);
    const rootsY = this.tilingScheme.getNumberOfYTilesAtLevel(0);
    for (let y = 0; y < rootsY; y += 1) {
      for (let x = 0; x < rootsX; x += 1) {
        const tile = { x, y, level: 0 };
        if (this.isVisibleFromCamera(tile)) leaves.push(this.createTraversalLeaf(tile));
      }
    }

    // 对齐 Cesium visitTile 的 SSE 优先细化语义：每次优先处理误差最大的可见叶，预算不足时继续保留父瓦片。
    while (true) {
      let candidateIndex = -1;
      let candidateError = this.maximumScreenSpaceError;
      for (let index = 0; index < leaves.length; index += 1) {
        const leaf = leaves[index];
        if (leaf.refinable && leaf.screenSpaceError > candidateError) {
          candidateIndex = index;
          candidateError = leaf.screenSpaceError;
        }
      }
      if (candidateIndex < 0) break;

      const candidate = leaves[candidateIndex];
      const children = this.visibleChildren(candidate.tile).map((tile) => this.createTraversalLeaf(tile));
      if (children.length === 0 || leaves.length - 1 + children.length > this.maximumTiles) {
        candidate.refinable = false;
        continue;
      }
      leaves.splice(candidateIndex, 1, ...children);
    }
    return leaves.map((leaf) => leaf.tile);
  }

  /**
   * 创建一个带 SSE 优先级的遍历叶节点。
   * @param tile 待进入选择队列的 Cesium 瓦片。
   * @returns 包含细化状态的遍历节点。
   */
  private createTraversalLeaf(tile: TerrainTileKey): GlobeTraversalLeaf {
    return {
      tile,
      screenSpaceError: this.screenSpaceError(tile),
      refinable: tile.level < this.maximumLevel,
    };
  }

  /**
   * 按 Cesium QuadtreeTile 的 southwest、southeast、northwest、northeast 顺序返回可见子瓦片。
   * @param tile 待细化的父瓦片。
   * @returns 通过椭球遮挡测试的子瓦片。
   */
  private visibleChildren(tile: TerrainTileKey): TerrainTileKey[] {
    const childLevel = tile.level + 1;
    const childX = tile.x * 2;
    const childY = tile.y * 2;
    return [
      { x: childX, y: childY + 1, level: childLevel },
      { x: childX + 1, y: childY + 1, level: childLevel },
      { x: childX, y: childY, level: childLevel },
      { x: childX + 1, y: childY, level: childLevel },
    ].filter((child) => this.isVisibleFromCamera(child));
  }

  /**
   * 用 Cesium QuadtreePrimitive 的透视 SSE 公式计算当前瓦片误差。
   * @param tile 待计算的瓦片。
   * @returns 像素单位的屏幕空间误差。
   */
  private screenSpaceError(tile: TerrainTileKey): number {
    const sphere = this.getBoundingSphere(tile);
    const cameraPosition = this.getCameraPosition();
    const distance = Math.max(1, Cartesian3.distance(cameraPosition, sphere.center) - sphere.radius);
    const geometricError = this.terrainProvider.getLevelMaximumGeometricError(tile.level);
    const drawingHeight = this.camera._boundCtx?.canvas.height ?? 1;
    const sseDenominator = 2 * Math.tan((this.camera.fov * Math.PI / 180) * 0.5);
    return (geometricError * drawingHeight) / (distance * sseDenominator);
  }

  /**
   * 执行椭球地平线可见性测试，避免细化相机背面的半球。
   * @param tile 待判断的瓦片。
   * @returns 瓦片是否处于可见半球。
   */
  private isVisibleFromCamera(tile: TerrainTileKey): boolean {
    const cameraPosition = this.getCameraPosition();
    if (Cartesian3.magnitude(cameraPosition) <= this.tilingScheme.ellipsoid.maximumRadius) return true;
    this.occluder.cameraPosition = cameraPosition;
    const rectangle = this.tilingScheme.tileXYToRectangle(tile.x, tile.y, tile.level);
    const cullingPoint = this.occluder.computeHorizonCullingPointFromRectangle(rectangle, this.tilingScheme.ellipsoid);
    return !cullingPoint || this.occluder.isScaledSpacePointVisible(cullingPoint);
  }

  /**
   * 获取一个瓦片的 Cesium ECEF 包围球。
   * @param tile 瓦片坐标。
   * @returns Cesium 计算的三维包围球。
   */
  private getBoundingSphere(tile: TerrainTileKey): BoundingSphere {
    const rectangle = this.tilingScheme.tileXYToRectangle(tile.x, tile.y, tile.level);
    return BoundingSphere.fromRectangle3D(rectangle, this.tilingScheme.ellipsoid, 0);
  }

  /**
   * 读取 Orillusion 相机并转换成 Cesium ECEF 坐标。
   * @returns Cesium Cartesian3 相机位置。
   */
  private getCameraPosition(): Cartesian3 {
    const position = this.camera.object3D.transform.worldPosition;
    return new Cartesian3(position.x, position.y, position.z);
  }
}
