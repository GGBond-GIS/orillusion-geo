import { BitmapTexture2D, Reference, Texture } from '@orillusion/core';
import { Cartesian4, ImageryLayer, WebMercatorProjection, type Rectangle, type TerrainProvider } from '@cesium/engine';
import { GlobeReprojectionCompute } from '../Renderer/GlobeReprojectionCompute.js';
import type { CesiumGlobeTileTexture } from '../Renderer/CesiumGlobeTileMaterial.js';
import { CesiumFrameTaskQueue } from '../Scheduler/CesiumFrameTaskQueue.js';
import type { TerrainTileKey } from './TerrainTileState.js';

/** Cesium ImageryState 的适配状态；不修改 engine 内部的 WebGL 资源。 */
const ImageryState = { Unloaded: 0, Transitioning: 1, Received: 2, TextureLoaded: 3, Ready: 4, Failed: 5, Invalid: 6 } as const;
type ImageryState = (typeof ImageryState)[keyof typeof ImageryState];

/** Cesium 私有 Imagery 实例的最小运行时结构。 */
interface CesiumImageryLike {
  imageryLayer: ImageryLayer;
  x: number;
  y: number;
  level: number;
  rectangle: Rectangle;
  parent?: CesiumImageryLike;
  referenceCount?: number;
  addReference?(): void;
  releaseReference?(): number;
}

/** Cesium 私有 TileImagery 实例的最小运行时结构。 */
interface CesiumTileImageryLike {
  loadingImagery?: CesiumImageryLike;
  readyImagery?: CesiumImageryLike;
  textureCoordinateRectangle?: Cartesian4;
  textureTranslationAndScale?: Cartesian4;
  useWebMercatorT?: boolean;
  freeResources?(): void;
  /** 当前 TileImagery 已得到最终影像或最终祖先回退。 */
  done?: boolean;
}

/** Cesium ImageryLayer 私有链路所需的接口。 */
interface CesiumImageryLayerInternals {
  _createTileImagerySkeletons(tile: CesiumTerrainTileLike, terrainProvider: TerrainProvider): boolean;
  _calculateTextureTranslationAndScale(tile: CesiumTerrainTileLike, tileImagery: CesiumTileImageryLike): Cartesian4;
}

/** 供 Cesium ImageryLayer 创建 TileImagery 骨架的地形瓦片结构。 */
interface CesiumTerrainTileLike {
  x: number;
  y: number;
  level: number;
  rectangle: Rectangle;
  data: { imagery: CesiumTileImageryLike[] };
}

/** 一个 Cesium Imagery 的请求、上传和重投影状态。 */
interface ManagedImagery {
  source: CesiumImageryLike;
  state: ImageryState;
  request?: Promise<void>;
  image?: any;
  texture?: Texture;
  textureWebMercator?: Texture;
  textureQueued: boolean;
  reprojectionQueued: boolean;
  disposed: boolean;
}

/** 影像运行时统计，用于验证静止场景不再增长。 */
export interface CesiumImageryRuntimeStatistics {
  managedImageryCount: number;
  activeRequests: number;
  pendingTextureUploads: number;
  pendingReprojections: number;
}

/** 由 Globe 使用的影像状态机依赖。 */
export interface CesiumSurfaceImageryOptions {
  context: any;
  terrainProvider: TerrainProvider;
  imageryLayers: { length: number; get(index: number): ImageryLayer | undefined };
  runtime: CesiumImageryRuntime;
}

/** Globe 级共享的 Cesium Imagery 缓存和分帧 GPU 调度器。 */
export class CesiumImageryRuntime {
  /** 全部地形瓦片共享同一份 Cesium Imagery 状态。 */
  public readonly managed = new Map<CesiumImageryLike, ManagedImagery>();
  /** WebMercator 重投影计算器。 */
  public readonly reprojector: GlobeReprojectionCompute;
  /** 当前在途影像请求数。 */
  public activeRequests = 0;
  /** 对齐 Cesium RequestScheduler 的并发保护上限。 */
  public maximumConcurrentRequests = 8;
  private readonly textureUploadQueue = new CesiumFrameTaskQueue(2.0);
  private readonly reprojectionQueue = new CesiumFrameTaskQueue(2.0);

  /**
   * 创建全局影像运行时。
   * @param context Orillusion GPU 上下文。
   */
  public constructor(context: any) { this.reprojector = new GlobeReprojectionCompute(context); }

  /**
   * 延迟到帧末创建影像纹理。
   * @param managed 已收到网络图像的状态对象。
   * @param execute 实际纹理上传步骤。
   */
  public enqueueTextureUpload(managed: ManagedImagery, execute: () => void): void {
    if (managed.textureQueued || managed.disposed) return;
    managed.textureQueued = true;
    void this.textureUploadQueue.enqueue(() => {
      managed.textureQueued = false;
      if (!managed.disposed) execute();
    }).catch(() => { if (!managed.disposed) managed.state = ImageryState.Failed; });
  }

  /**
   * 延迟到后续帧执行计算重投影，保证它不与同一影像的上传处于同一帧。
   * @param managed 已创建源纹理的状态对象。
   * @param execute 实际 ComputeShader 提交步骤。
   */
  public enqueueReprojection(managed: ManagedImagery, execute: () => void): void {
    if (managed.reprojectionQueued || managed.disposed) return;
    managed.reprojectionQueued = true;
    void this.reprojectionQueue.enqueue(() => {
      managed.reprojectionQueued = false;
      if (!managed.disposed) execute();
    }).catch(() => { if (!managed.disposed) managed.state = ImageryState.Failed; });
  }

  /**
   * 对齐 Cesium endFrame：网络状态机结束后才消费 GPU 资源准备队列。
   * 分别限额消费上传与重投影；网络状态机与 GPU 提交仍分帧，但不会把精细层固定拖慢到每帧一张。
   */
  public processGpuQueues(): number {
    const uploaded = this.textureUploadQueue.process(4);
    const reprojected = this.reprojectionQueue.process(1);
    return uploaded + reprojected;
  }

  /** 清理 Cesium 已无引用的影像及对应 Orillusion GPU 纹理。 */
  public releaseUnused(): void {
    for (const [source, managed] of this.managed) {
      if ((source.referenceCount ?? 1) > 0) continue;
      // Cesium 引用归零只表示 TileImagery 已切换；帧末材质提交前，旧 Orillusion 材质仍可能持有祖先纹理。
      // 必须等待两个体系都解除引用，避免下一次 RenderShader 重建 BindGroup 时取得已销毁的纹理视图。
      if (this.hasOrillusionReferences(managed)) continue;
      this.destroyManaged(managed);
      this.managed.delete(source);
    }
  }

  /**
   * 判断当前影像纹理是否仍被 Orillusion 材质或计算命令引用。
   * @param managed 待检查的共享影像状态。
   * @returns 任一 GPU 纹理仍有引擎侧引用时返回 true。
   */
  private hasOrillusionReferences(managed: ManagedImagery): boolean {
    const references = Reference.getInstance();
    return Boolean((managed.texture && references.hasReference(managed.texture))
      || (managed.textureWebMercator && references.hasReference(managed.textureWebMercator)));
  }

  /** 释放所有队列和纹理资源。 */
  public dispose(): void {
    this.textureUploadQueue.clear();
    this.reprojectionQueue.clear();
    for (const managed of this.managed.values()) this.destroyManaged(managed);
    this.managed.clear();
  }

  /** 返回静止场景内存稳定性计数。 */
  public get statistics(): CesiumImageryRuntimeStatistics {
    return {
      managedImageryCount: this.managed.size,
      activeRequests: this.activeRequests,
      pendingTextureUploads: this.textureUploadQueue.statistics.pending,
      pendingReprojections: this.reprojectionQueue.statistics.pending,
    };
  }

  /**
   * 释放一个共享影像状态持有的资源。
   * @param managed 待销毁的影像状态。
   */
  private destroyManaged(managed: ManagedImagery): void {
    if (managed.disposed) return;
    managed.disposed = true;
    const textures = new Set<Texture>();
    if (managed.texture) textures.add(managed.texture);
    if (managed.textureWebMercator) textures.add(managed.textureWebMercator);
    for (const texture of textures) texture.destroy(true);
    if (typeof managed.image?.close === 'function') managed.image.close();
    managed.image = undefined;
    managed.texture = undefined;
    managed.textureWebMercator = undefined;
  }
}

/**
 * 保留 Cesium ImageryLayer 创建的 TileImagery 骨架，并逐帧执行原状态机阶段。
 * 新地形实体只有在 loadingImagery 完成后才消费最终纹理。
 */
export class CesiumSurfaceImagery {
  private readonly tile: CesiumTerrainTileLike;
  private readonly options: CesiumSurfaceImageryOptions;
  private initializedLayerCount = 0;
  private revisionValue = 0;
  private disposed = false;

  /**
   * 创建一个地形瓦片对应的持久影像状态机。
   * @param key 地形瓦片坐标。
   * @param rectangle 地形瓦片的地理范围。
   * @param options Orillusion 上下文和 Cesium 图层集合。
   */
  public constructor(key: TerrainTileKey, rectangle: Rectangle, options: CesiumSurfaceImageryOptions) {
    this.tile = { ...key, rectangle, data: { imagery: [] } };
    this.options = options;
  }

  /** 当前可渲染影像变化版本。 */
  public get revision(): number { return this.revisionValue; }

  /**
   * 对齐 Cesium GlobeSurfaceTile.renderable：每个 TileImagery 只要已有可用 readyImagery 即可渲染。
   * readyImagery 可以是祖先回退；最终 loadingImagery 完成后会继续更新同一个材质。
   */
  public get isReadyForCommit(): boolean {
    return this.tile.data.imagery.length > 0 && this.tile.data.imagery.every(tileImagery => {
      if (!tileImagery.readyImagery) return false;
      return Boolean(this.getTexture(tileImagery.readyImagery, tileImagery.useWebMercatorT ?? false));
    });
  }

  /**
   * 对齐 GlobeSurfaceTile.eligibleForUnloading：Imagery 请求、上传或重投影进行中时禁止淘汰。
   */
  public get eligibleForUnloading(): boolean {
    return this.tile.data.imagery.every(tileImagery => {
      const loading = tileImagery.loadingImagery;
      if (!loading) return true;
      const managed = this.options.runtime.managed.get(loading);
      return !managed || (managed.state !== ImageryState.Transitioning && !managed.textureQueued && !managed.reprojectionQueued);
    });
  }

  /**
   * 按 GlobeSurfaceTile.processImagery 的语义推进所有 TileImagery。
   * @param skipLoading 是否跳过新的网络请求。
   * @returns 可直接传入 Globe tile shader 的当前 readyImagery。
   */
  public processStateMachine(skipLoading = false): CesiumGlobeTileTexture[] {
    if (this.disposed) return [];
    this.createMissingSkeletons();
    const output: CesiumGlobeTileTexture[] = [];
    for (const tileImagery of this.tile.data.imagery) {
      this.processTileImagery(tileImagery, skipLoading);
      const ready = tileImagery.readyImagery;
      const texture = ready ? this.getTexture(ready, tileImagery.useWebMercatorT ?? false) : undefined;
      if (!ready || !texture || !tileImagery.textureCoordinateRectangle || !tileImagery.textureTranslationAndScale) continue;
      output.push({
        texture,
        textureCoordinateRectangle: tileImagery.textureCoordinateRectangle,
        textureTranslationAndScale: tileImagery.textureTranslationAndScale,
        useWebMercatorT: tileImagery.useWebMercatorT ?? false,
      });
    }
    return output;
  }

  /** 释放 TileImagery 对 Cesium Imagery 缓存的引用。 */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const tileImagery of this.tile.data.imagery) tileImagery.freeResources?.();
    this.tile.data.imagery.length = 0;
  }

  /** 调用 Cesium ImageryLayer._createTileImagerySkeletons，并且只对新图层执行一次。 */
  private createMissingSkeletons(): void {
    for (let index = this.initializedLayerCount; index < this.options.imageryLayers.length; index += 1) {
      const layer = this.options.imageryLayers.get(index);
      if (!layer?.show || !layer.ready) continue;
      (layer as unknown as CesiumImageryLayerInternals)._createTileImagerySkeletons(this.tile, this.options.terrainProvider);
    }
    this.initializedLayerCount = this.options.imageryLayers.length;
  }

  /**
   * 对应 TileImagery.processStateMachine：优先最终子级，否则保留最近可用祖先。
   * @param tileImagery Cesium 创建的 TileImagery。
   * @param skipLoading 是否跳过新的网络请求。
   */
  private processTileImagery(tileImagery: CesiumTileImageryLike, skipLoading: boolean): void {
    const loading = tileImagery.loadingImagery;
    if (!loading || tileImagery.done) return;
    const useWebMercatorT = tileImagery.useWebMercatorT ?? false;
    const managed = this.getManaged(loading);
    this.processImagery(managed, !useWebMercatorT, skipLoading);
    if (managed.state === ImageryState.Ready) {
      tileImagery.readyImagery?.releaseReference?.();
      tileImagery.readyImagery = loading;
      tileImagery.loadingImagery = undefined;
      tileImagery.done = true;
      this.updateTranslation(tileImagery);
      this.revisionValue += 1;
      return;
    }
    let ancestor = loading.parent;
    let closestLoadingAncestor: ManagedImagery | undefined;
    while (ancestor) {
      const ancestorManaged = this.getManaged(ancestor);
      this.processImagery(ancestorManaged, !useWebMercatorT, skipLoading);
      if (ancestorManaged.state !== ImageryState.Ready || !this.getTexture(ancestor, useWebMercatorT)) {
        if (ancestorManaged.state !== ImageryState.Failed && ancestorManaged.state !== ImageryState.Invalid) closestLoadingAncestor ??= ancestorManaged;
        ancestor = ancestor.parent;
        continue;
      }
      if (tileImagery.readyImagery !== ancestor) {
        tileImagery.readyImagery?.releaseReference?.();
        tileImagery.readyImagery = ancestor;
        ancestor.addReference?.();
        this.updateTranslation(tileImagery);
        this.revisionValue += 1;
      }
      break;
    }
    if (managed.state === ImageryState.Failed || managed.state === ImageryState.Invalid) {
      if (closestLoadingAncestor) this.processImagery(closestLoadingAncestor, !useWebMercatorT, false);
      else tileImagery.done = Boolean(tileImagery.readyImagery);
    }
  }

  /**
   * 对应 Imagery.processStateMachine；每次只排入一个异步阶段，不在同一帧连续上传和重投影。
   * @param managed 当前影像状态。
   * @param needGeographicProjection 是否需要地理投影纹理。
   * @param skipLoading 是否跳过新的网络请求。
   */
  private processImagery(managed: ManagedImagery, needGeographicProjection: boolean, skipLoading: boolean): void {
    if (managed.disposed) return;
    if (managed.state === ImageryState.Unloaded && !skipLoading) {
      this.requestImagery(managed);
      return;
    }
    if (managed.state === ImageryState.Received) {
      this.options.runtime.enqueueTextureUpload(managed, () => this.createTexture(managed));
      return;
    }
    const needsReprojection = managed.state === ImageryState.Ready && needGeographicProjection && !managed.texture;
    if (managed.state === ImageryState.TextureLoaded || needsReprojection) {
      this.options.runtime.enqueueReprojection(managed, () => this.reprojectTexture(managed, needGeographicProjection));
    }
  }

  /**
   * 对应 ImageryLayer._requestImagery，只调用 Cesium provider 的异步 requestImage。
   * @param managed 待请求的影像。
   */
  private requestImagery(managed: ManagedImagery): void {
    if (this.options.runtime.activeRequests >= this.options.runtime.maximumConcurrentRequests) return;
    const { imageryLayer, x, y, level } = managed.source;
    const request = imageryLayer.imageryProvider.requestImage(x, y, level);
    if (!request) return;
    managed.state = ImageryState.Transitioning;
    this.options.runtime.activeRequests += 1;
    managed.request = Promise.resolve(request)
      .then(image => {
        if (managed.disposed) { if (typeof (image as any)?.close === 'function') (image as any).close(); return; }
        if (!image) { managed.state = ImageryState.Invalid; return; }
        managed.image = image;
        managed.state = ImageryState.Received;
      })
      .catch(() => { if (!managed.disposed) managed.state = ImageryState.Failed; })
      .finally(() => { this.options.runtime.activeRequests -= 1; });
  }

  /**
   * 对应 ImageryLayer._createTexture，在 Orillusion 中创建 sRGB 原投影纹理。
   * @param managed 已接收图片的影像。
   */
  private createTexture(managed: ManagedImagery): void {
    if (!managed.image) { managed.state = ImageryState.Invalid; return; }
    const texture = new BitmapTexture2D(true, this.options.context, 'srgb');
    texture.source = managed.image;
    if (managed.source.imageryLayer.imageryProvider.tilingScheme.projection instanceof WebMercatorProjection) managed.textureWebMercator = texture;
    else managed.texture = texture;
    managed.image = undefined;
    managed.state = ImageryState.TextureLoaded;
  }

  /**
   * 对应 ImageryLayer._reprojectTexture，WebMercator 到 Geographic 由 Orillusion ComputeShader 完成。
   * @param managed 已有源纹理的影像。
   * @param needGeographicProjection 是否需要地理投影结果。
   */
  private reprojectTexture(managed: ManagedImagery, needGeographicProjection: boolean): void {
    const source = managed.textureWebMercator ?? managed.texture;
    if (!source) { managed.state = ImageryState.Invalid; return; }
    const provider = managed.source.imageryLayer.imageryProvider;
    const isWebMercator = provider.tilingScheme.projection instanceof WebMercatorProjection;
    const nativeRectangle = provider.tilingScheme.tileXYToNativeRectangle(managed.source.x, managed.source.y, managed.source.level);
    if (needGeographicProjection && isWebMercator && managed.source.rectangle.width / Math.max(1, (source as any).width ?? 256) > 1e-5) {
      // 对齐 Cesium ComputeCommand：提交后保持 TRANSITIONING，只有 GPU postExecute 完成才进入 READY。
      // 这段时间 eligibleForUnloading=false，源纹理和目标纹理都不会被缓存淘汰。
      managed.state = ImageryState.Transitioning;
      void this.options.runtime.reprojector.reproject(source, {
        width: Math.max(1, (source as any).width ?? 256),
        height: Math.max(1, (source as any).height ?? 256),
        geographicRectangle: managed.source.rectangle,
        webMercatorRectangle: nativeRectangle,
      }).then(texture => {
        if (managed.disposed) { texture.destroy(true); return; }
        managed.texture = texture;
        managed.state = ImageryState.Ready;
      }).catch(() => {
        if (!managed.disposed) managed.state = ImageryState.TextureLoaded;
      });
      return;
    } else if (needGeographicProjection) {
      managed.texture = source;
    }
    managed.state = ImageryState.Ready;
  }

  /** 取得或创建一个 Cesium Imagery 对应的适配状态。 */
  private getManaged(source: CesiumImageryLike): ManagedImagery {
    let managed = this.options.runtime.managed.get(source);
    if (!managed) {
      managed = { source, state: ImageryState.Unloaded, textureQueued: false, reprojectionQueued: false, disposed: false };
      this.options.runtime.managed.set(source, managed);
    }
    return managed;
  }

  /** 按 TileImagery 的采样模式取得可用纹理。 */
  private getTexture(source: CesiumImageryLike, useWebMercatorT: boolean): Texture | undefined {
    const managed = this.getManaged(source);
    return useWebMercatorT ? managed.textureWebMercator ?? managed.texture : managed.texture;
  }

  /** 使用 Cesium ImageryLayer 的原始实现计算 textureTranslationAndScale。 */
  private updateTranslation(tileImagery: CesiumTileImageryLike): void {
    const ready = tileImagery.readyImagery;
    if (!ready) return;
    tileImagery.textureTranslationAndScale = (ready.imageryLayer as unknown as CesiumImageryLayerInternals)
      ._calculateTextureTranslationAndScale(this.tile, tileImagery);
  }
}
