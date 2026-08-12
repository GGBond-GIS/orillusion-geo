import { Camera3D, ComponentBase, View3D } from '@orillusion/core';
import { type ImageryLayerCollection, type TerrainProvider } from '@cesium/engine';
import { Globe, type GlobeTileCoordinate } from './Globe.js';

/** Globe ECS 组件参数。 */
export interface GlobeComponentOptions { terrainProvider?: TerrainProvider; imageryLayers?: ImageryLayerCollection; camera?: Camera3D; initialTiles?: GlobeTileCoordinate[]; onReady?: (globe: Globe) => void; }

/** 将 Globe 接入 Orillusion 生命周期的 ECS 组件。 */
export class GlobeComponent extends ComponentBase {
  /** 已创建的 Globe 管理器。 */
  public globe: Globe | null = null;
  private options: GlobeComponentOptions | null = null;

  /**
   * 保存 ECS 组件初始化参数。
   * @param options Globe 所需的数据源、相机与初始瓦片。
   */
  public override init(options: GlobeComponentOptions): void { this.options = options; }

  /**
   * 在 View 可用后创建 Globe，并异步加载初始瓦片。
   * @param view 当前 Orillusion View。
   */
  public override onEnable(view?: View3D): void {
    if (!view || this.globe || !this.options) return;
    this.globe = new Globe({ engine: view.engine3D, camera: this.options.camera ?? view.camera, terrainProvider: this.options.terrainProvider, imageryLayers: this.options.imageryLayers });
    this.object3D.addChild(this.globe.group);
    this.options.onReady?.(this.globe);
    for (const coordinate of this.options.initialTiles ?? []) void this.globe.loadTile(coordinate);
  }

  /** 每帧推进 Cesium 地形状态机及其 Worker 结果提交。 */
  public override onUpdate(): void { this.globe?.update(); }

  /** 组件销毁时释放所有地形 ECS 实体。 */
  public override beforeDestroy(): void { this.globe?.dispose(); this.globe = null; }
}
