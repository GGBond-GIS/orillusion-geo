import { Camera3D, ComponentBase, View3D } from '@orillusion/core';
import { OrillusionTilesRenderer } from './OrillusionTilesRenderer.js';

/** 组件初始化参数。 */
export interface TilesRendererComponentOptions {
  /** 根 tileset.json 地址。 */
  url: string;
  /** 可选的相机；省略时使用当前 View3D 的相机。 */
  camera?: Camera3D;
  /** 屏幕空间误差阈值，值越小细节越高。 */
  errorTarget?: number;
  /** 渲染器创建完成后的配置回调。 */
  onRendererReady?: (renderer: OrillusionTilesRenderer) => void;
}

/**
 * 面向 Orillusion ECS 的 3D Tiles 组件，每帧自动驱动瓦片选择与加载。
 */
export class TilesRendererComponent extends ComponentBase {
  /** 底层 3D Tiles 渲染器，启动后可用于配置 errorTarget 等参数。 */
  public renderer: OrillusionTilesRenderer | null = null;
  private options: TilesRendererComponentOptions | null = null;

  /**
   * 初始化组件。
   * @param options 根 tileset 地址及可选相机。
   */
  public override init(options: TilesRendererComponentOptions): void {
    this.options = options;
  }

  /**
   * 在所属 View 准备完成后创建渲染器并挂接瓦片根节点。
   * @param view 当前渲染 View。
   */
  public override onEnable(view?: View3D): void {
    if (!view || this.renderer || !this.options) return;
    const camera = this.options.camera ?? view.camera;
    this.renderer = new OrillusionTilesRenderer(this.options.url, view.engine3D, camera);
    if (this.options.errorTarget !== undefined) this.renderer.errorTarget = this.options.errorTarget;
    this.object3D.addChild(this.renderer.group);
    this.options.onRendererReady?.(this.renderer);
  }

  /**
   * 每帧更新 3D Tiles 的 LOD、请求队列和可见性。
   * @param _view 当前渲染 View。
   */
  public override onUpdate(_view?: View3D): void {
    this.renderer?.update();
  }

  /** 在组件销毁前释放瓦片缓存和对象。 */
  public override beforeDestroy(): void {
    this.renderer?.dispose();
    this.renderer = null;
  }
}
