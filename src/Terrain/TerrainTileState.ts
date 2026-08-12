/** 地形瓦片加载状态，与 Cesium GlobeSurfaceTile 的状态转换保持一致。 */
export const TerrainTileState = {
  /** 尚未请求地形数据。 */
  Unloaded: 'unloaded',
  /** 正在请求 TerrainProvider 数据。 */
  Receiving: 'receiving',
  /** 已获得 TerrainData，等待 Cesium Worker 生成网格。 */
  Received: 'received',
  /** Cesium Worker 正在执行 TerrainData.createMesh。 */
  Transforming: 'transforming',
  /** 已取得 Cesium TerrainMesh，等待创建 Orillusion 资源。 */
  Transformed: 'transformed',
  /** Orillusion 几何、材质和纹理资源已就绪。 */
  Ready: 'ready',
  /** 原始地形不可用，等待从父瓦片上采样。 */
  Failed: 'failed',
} as const;

/** 地形瓦片加载状态值。 */
export type TerrainTileState = (typeof TerrainTileState)[keyof typeof TerrainTileState];

/** 四叉树瓦片坐标与层级。 */
export interface TerrainTileKey {
  /** 瓦片列号。 */
  x: number;
  /** 瓦片行号。 */
  y: number;
  /** 瓦片层级。 */
  level: number;
}
