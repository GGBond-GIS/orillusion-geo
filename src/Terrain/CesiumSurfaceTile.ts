import { Cartesian2, Cartesian3, type TerrainData, type TerrainProvider } from '@cesium/engine';
import { TerrainTileState, type TerrainTileKey } from './TerrainTileState.js';

/** Cesium TerrainMesh 的运行时结构；该类型并未由 @cesium/engine 公开导出。 */
export interface CesiumTerrainMesh {
  /** Cesium 地形瓦片的 RTC 中心；解码顶点须加回此 ECEF 偏移。 */
  center: Cartesian3;
  /** Worker 输出的压缩顶点缓冲。 */
  vertices: Float32Array;
  /** 三角形索引。 */
  indices: Uint8Array | Uint16Array | Uint32Array;
  /** 每个顶点的元素数量。 */
  stride: number;
  /** Cesium TerrainEncoding 解码器。 */
  encoding: {
    decodePosition(vertices: Float32Array, index: number, result: Cartesian3): Cartesian3;
    decodeTextureCoordinates(vertices: Float32Array, index: number, result: Cartesian2): Cartesian2;
    decodeWebMercatorT(vertices: Float32Array, index: number): number;
  };
}

/** 供 Orillusion 渲染层消费的已完成地形数据。 */
export interface TerrainMeshReadyEvent {
  /** 当前瓦片。 */
  tile: CesiumSurfaceTile;
  /** Cesium Worker 生成的网格。 */
  mesh: CesiumTerrainMesh;
}

/**
 * 从 Cesium GlobeSurfaceTile 抽出的、与渲染器无关的地形状态机。
 * 它只使用 TerrainProvider/TerrainData 的公开 API；资源创建由调用方完成。
 */
export class CesiumSurfaceTile {
  /** 当前瓦片坐标。 */
  public readonly key: TerrainTileKey;
  /** 父级瓦片；用于不可用地形的上采样。 */
  public readonly parent: CesiumSurfaceTile | null;
  /** 当前地形状态。 */
  public state: TerrainTileState = TerrainTileState.Unloaded;
  /** 已收到的 Cesium TerrainData。 */
  public terrainData: TerrainData | null = null;
  /** Cesium Worker 输出网格。 */
  public mesh: CesiumTerrainMesh | null = null;
  private pending: Promise<void> | null = null;

  /**
   * 创建一个四叉树地表瓦片。
   * @param key 瓦片坐标与层级。
   * @param parent 父瓦片，没有父级时传入 null。
   */
  public constructor(key: TerrainTileKey, parent: CesiumSurfaceTile | null) {
    this.key = key;
    this.parent = parent;
  }

  /**
   * 对齐 GlobeSurfaceTile.eligibleForUnloading：网络接收和 Worker 转换期间禁止淘汰。
   */
  public get eligibleForUnloading(): boolean {
    return !this.pending && this.state !== TerrainTileState.Receiving && this.state !== TerrainTileState.Transforming;
  }

  /**
   * 推进一次地形状态机。createMesh 仍由 Cesium 内部 TaskProcessor Worker 执行。
   * @param provider Cesium 地形提供器。
   * @param exaggeration 地形夸张倍数。
   * @param exaggerationRelativeHeight 地形夸张参考高程。
   * @returns 本帧是否新得到可提交给 Orillusion 的网格。
   */
  public update(provider: TerrainProvider, exaggeration: number, exaggerationRelativeHeight: number): boolean {
    if (this.pending) return false;
    if (this.state === TerrainTileState.Unloaded) {
      this.requestTerrain(provider);
      return false;
    }
    if (this.state === TerrainTileState.Failed) {
      this.upsample(provider);
      return false;
    }
    if (this.state === TerrainTileState.Received) {
      this.createMesh(provider, exaggeration, exaggerationRelativeHeight);
      return false;
    }
    if (this.state === TerrainTileState.Transformed) {
      this.state = TerrainTileState.Ready;
      return true;
    }
    return false;
  }

  /**
   * 释放不再位于 Cesium replacement queue 内的地形数据和 Worker 网格结果。
   * 在途 Promise 不会被强制取消；完成后瓦片可再次进入正常状态机。
   */
  public freeResources(): void {
    if (this.pending) return;
    this.terrainData = null;
    this.mesh = null;
    this.state = TerrainTileState.Unloaded;
  }

  /**
   * 请求原始地形数据；Cesium 返回 undefined 时保留 Unloaded 状态以便下一帧重试。
   * @param provider Cesium 地形提供器。
   */
  private requestTerrain(provider: TerrainProvider): void {
    const { x, y, level } = this.key;
    const request = provider.requestTileGeometry(x, y, level);
    if (!request) return;
    this.state = TerrainTileState.Receiving;
    this.pending = request.then(data => {
      this.terrainData = data;
      this.state = TerrainTileState.Received;
    }).catch(() => {
      this.state = TerrainTileState.Failed;
    }).finally(() => { this.pending = null; });
  }

  /**
   * 在服务端瓦片不可用时，从父级 TerrainData 调用 Cesium 上采样 API。
   * @param provider Cesium 地形提供器。
   */
  private upsample(provider: TerrainProvider): void {
    const parent = this.parent;
    if (!parent?.terrainData) return;
    const { x, y, level } = this.key;
    const source = parent.key;
    const request = parent.terrainData.upsample(provider.tilingScheme, source.x, source.y, source.level, x, y, level);
    if (!request) return;
    this.state = TerrainTileState.Receiving;
    this.pending = request.then(data => {
      this.terrainData = data;
      this.state = TerrainTileState.Received;
    }).catch(() => {
      this.state = TerrainTileState.Failed;
    }).finally(() => { this.pending = null; });
  }

  /**
   * 调用 TerrainData.createMesh，将网格构建留给 Cesium TaskProcessor Worker。
   * @param provider Cesium 地形提供器。
   * @param exaggeration 地形夸张倍数。
   * @param exaggerationRelativeHeight 地形夸张参考高程。
   */
  private createMesh(provider: TerrainProvider, exaggeration: number, exaggerationRelativeHeight: number): void {
    const terrainData = this.terrainData as unknown as { createMesh(options: object): Promise<CesiumTerrainMesh> | undefined };
    const request = terrainData.createMesh({ tilingScheme: provider.tilingScheme, ...this.key, exaggeration, exaggerationRelativeHeight, throttle: true });
    if (!request) return;
    this.state = TerrainTileState.Transforming;
    this.pending = request.then(mesh => {
      this.mesh = mesh;
      this.state = TerrainTileState.Transformed;
    }).catch(() => {
      this.state = TerrainTileState.Failed;
    }).finally(() => { this.pending = null; });
  }
}
