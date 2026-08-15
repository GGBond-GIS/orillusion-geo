import { BitmapTexture2D, Reference, Texture } from '@orillusion/core';
import { Cartesian4, WebMercatorProjection, type ImageryLayer, type Rectangle, type TerrainProvider } from '@cesium/engine';
import { GlobeReprojectionCompute, type GlobeReprojectionOptions, type GlobeReprojectionTask } from '../Renderer/GlobeReprojectionCompute.js';
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
  /** 当前 TileImagery 已得到最终影像或最终祖先回退（对齐 Cesium processStateMachine 返回 true）。 */
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
  /** Number of consecutive network failures. Reset after a successful response. */
  retryCount: number;
  /** Earliest time at which another request may be issued. */
  retryAfter: number;
  /** Invalidates callbacks belonging to an older timed-out request. */
  requestGeneration: number;
}

/** 待批处理的重投影任务。 */
interface PendingReprojection {
  managed: ManagedImagery;
  source: Texture;
  options: GlobeReprojectionOptions;
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
  /**
   * 对齐 Cesium RequestScheduler.maximumRequestsPerServer（18）的影像请求并发上限；
   * 超过时保持 Unloaded，下一帧重试（对齐 Cesium 被节流时返回 undefined 的语义）。
   */
  public maximumConcurrentRequests = 18;
  /** A provider promise must not keep one LOD branch in TRANSITIONING forever. */
  public imageryRequestTimeout = 12_000;
  /** Exponential retry delay is capped so a transiently failed tile eventually upgrades. */
  public maximumImageryRetryDelay = 10_000;
  /**
   * 每帧最多重投影的影像数量。地理投影影像（非 WebMercator）时每个任务都是一次
   * 全屏 compute dispatch（源纹理采样 + 目标写入，显存带宽密集）；默认 32 会让
   * 单帧 GPU 出现带宽峰值（"GPU 占用高但硬件没跑满"的典型来源之一），降到 8
   * 把负载分摊到多帧，影像就绪略慢但帧率稳定。WebMercator 影像（tianditu 等）
   * 走 webMercatorUv 路径，不经过这里。
   */
  public maximumReprojectionsPerFrame = 8;
  private readonly textureUploadQueue = new CesiumFrameTaskQueue(2.0);
  private readonly pendingReprojections: PendingReprojection[] = [];

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
   * 把重投影任务加入本帧批处理队列。与 Cesium 一致：多个重投影在同一个
   * compute pass 内按序执行（frameState.commandList 语义），不再逐帧逐张。
   * @param managed 已创建源纹理的状态对象。
   * @param source 源 WebMercator 纹理。
   * @param options 重投影参数。
   */
  public enqueueReprojection(managed: ManagedImagery, source: Texture, options: GlobeReprojectionOptions): void {
    if (managed.reprojectionQueued || managed.disposed) return;
    managed.reprojectionQueued = true;
    this.pendingReprojections.push({ managed, source, options });
  }

  /**
   * 帧末消费 GPU 准备队列：
   *  - 纹理上传是同步 copyExternalImageToTexture，按数量限额消费，无背压；
   *  - 重投影整批提交一个 CommandEncoder，仅在上一批 GPU 工作完成前跳过（对齐 Cesium 帧内计算队列）。
   */
  public processGpuQueues(): number {
    const uploaded = this.textureUploadQueue.process(16);
    const reprojected = this.processReprojections();
    return uploaded + reprojected;
  }

  /** 把当前积压的重投影任务作为一批提交。 */
  private processReprojections(): number {
    if (this.reprojector.isBusy || this.pendingReprojections.length === 0) {
      return 0;
    }
    const batch = this.pendingReprojections.splice(0, this.maximumReprojectionsPerFrame);
    for (const entry of batch) {
      entry.managed.reprojectionQueued = false;
    }
    const tasks: GlobeReprojectionTask[] = batch.map(entry => ({
      source: entry.source,
      options: entry.options,
      resolve: texture => {
        const managed = entry.managed;
        if (managed.disposed) { texture.destroy(true); return; }
        managed.texture = texture;
        managed.state = ImageryState.Ready;
      },
      reject: () => {
        const managed = entry.managed;
        // 对齐 Cesium：重投影失败回退到 TEXTURE_LOADED，需要地理投影时下一帧重新入队。
        if (!managed.disposed) managed.state = ImageryState.TextureLoaded;
      },
    }));
    void this.reprojector.reprojectBatch(tasks);
    return tasks.length;
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
    this.pendingReprojections.length = 0;
    for (const managed of this.managed.values()) this.destroyManaged(managed);
    this.managed.clear();
  }

  /** 返回静止场景内存稳定性计数。 */
  public get statistics(): CesiumImageryRuntimeStatistics {
    return {
      managedImageryCount: this.managed.size,
      activeRequests: this.activeRequests,
      pendingTextureUploads: this.textureUploadQueue.statistics.pending,
      pendingReprojections: this.pendingReprojections.length,
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
  private readonly initializedLayers = new Set<ImageryLayer>();
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
   * 对齐 Cesium GlobeSurfaceTile.processImagery 的 renderable 判定：
   * 只要有任一 TileImagery 完成或存在可用 readyImagery，该瓦片影像即可渲染；
   * 全部失败/完成的 TileImagery 不再阻塞渲染（对齐 Cesium：FAILED/INVALID 且无加载中祖先 → done）。
   */
  public get isReadyForCommit(): boolean {
    const tileImageryCollection = this.tile.data.imagery;
    if (tileImageryCollection.length === 0) return false;
    let isAnyTileLoaded = false;
    let isDoneLoading = true;
    for (const tileImagery of tileImageryCollection) {
      const done = !tileImagery.loadingImagery || tileImagery.done === true;
      const hasTexture = Boolean(tileImagery.readyImagery && this.getTexture(tileImagery.readyImagery, tileImagery.useWebMercatorT ?? false));
      isAnyTileLoaded = isAnyTileLoaded || done || hasTexture;
      isDoneLoading = isDoneLoading && done;
    }
    return isAnyTileLoaded || isDoneLoading;
  }

  /** 对齐 Cesium processImagery 返回的 isDoneLoading：所有 TileImagery 都已完成加载。 */
  public get isDoneLoading(): boolean {
    return this.tile.data.imagery.every(tileImagery => !tileImagery.loadingImagery || tileImagery.done === true);
  }

  /**
   * 对齐 Cesium processImagery 的 isUpsampledOnly 影像部分：
   * 所有 TileImagery 的 loadingImagery 都处于 FAILED/INVALID（无 TileImagery 时视为真）。
   */
  public get allTileImageryFailedOrInvalid(): boolean {
    return this.tile.data.imagery.every(tileImagery => {
      const loading = tileImagery.loadingImagery;
      if (!loading) return false;
      const managed = this.options.runtime.managed.get(loading);
      return managed !== undefined && (managed.state === ImageryState.Failed || managed.state === ImageryState.Invalid);
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
        imageryLayer: ready.imageryLayer,
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

  /**
   * 移除指定图层在本瓦片的 TileImagery 骨架。
   * 对齐 Cesium GlobeSurfaceTileProvider._onLayerRemoved 的 removeTileImagery。
   */
  public removeLayer(layer: ImageryLayer): void {
    const tileImageryCollection = this.tile.data.imagery;
    for (let index = 0; index < tileImageryCollection.length; index += 1) {
      const tileImagery = tileImageryCollection[index];
      const imagery = tileImagery.loadingImagery ?? tileImagery.readyImagery;
      if (imagery && imagery.imageryLayer === layer) {
        tileImagery.freeResources?.();
        tileImageryCollection.splice(index, 1);
        this.revisionValue += 1;
        return;
      }
    }
  }

  /** 调用 Cesium ImageryLayer._createTileImagerySkeletons，并且每个图层只执行一次。
   *  图层未就绪（对齐 Cesium PLACEHOLDER 语义）时保持未初始化，就绪后再创建骨架。 */
  private createMissingSkeletons(): void {
    const layers = this.options.imageryLayers;
    for (let index = 0; index < layers.length; index += 1) {
      const layer = layers.get(index);
      if (!layer || this.initializedLayers.has(layer)) continue;
      if (!layer.show || !layer.ready) continue;
      this.initializedLayers.add(layer);
      (layer as unknown as CesiumImageryLayerInternals)._createTileImagerySkeletons(this.tile, this.options.terrainProvider);
    }
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
      if (closestLoadingAncestor) {
        this.processImagery(closestLoadingAncestor, !useWebMercatorT, false);
      } else {
        // 对齐 Cesium：影像失败/无效且没有加载中的祖先 → 该 TileImagery 完成，
        // 即使没有 readyImagery 也不再阻塞瓦片渲染。
        tileImagery.done = true;
      }
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
    if (managed.state === ImageryState.Unloaded && !skipLoading && performance.now() >= managed.retryAfter) {
      this.requestImagery(managed);
      return;
    }
    if (managed.state === ImageryState.Received) {
      this.options.runtime.enqueueTextureUpload(managed, () => this.createTexture(managed));
      return;
    }
    const needsReprojection = managed.state === ImageryState.Ready && needGeographicProjection && !managed.texture;
    if (managed.state === ImageryState.TextureLoaded || needsReprojection) {
      this.enqueueReprojection(managed, needGeographicProjection);
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
    const generation = ++managed.requestGeneration;
    managed.state = ImageryState.Transitioning;
    this.options.runtime.activeRequests += 1;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const sourceRequest = Promise.resolve(request);
    const timeoutRequest = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        reject(new Error(`Imagery request timed out: ${level}/${x}/${y}`));
      }, this.options.runtime.imageryRequestTimeout);
    });
    // A late ImageBitmap is no longer consumed by Promise.race; close it explicitly instead of
    // leaving native image memory alive until GC.
    void sourceRequest.then(image => {
      if (timedOut && typeof (image as any)?.close === 'function') (image as any).close();
    }).catch(() => undefined);
    managed.request = Promise.race([sourceRequest, timeoutRequest])
      .then(image => {
        if (managed.disposed || managed.requestGeneration !== generation) {
          if (typeof (image as any)?.close === 'function') (image as any).close();
          return;
        }
        if (!image) { managed.state = ImageryState.Invalid; return; }
        // Some WMTS services (notably Tianditu) answer quota/auth failures with HTTP 200 and a
        // beige, watermarked JPEG. Cesium's provider therefore resolves requestImage normally.
        // Reject flat light-colour placeholder tiles here so the normal ancestor fallback and
        // retry path are used instead of uploading the error image as valid imagery.
        if (this.isLikelyProviderErrorImage(image)) {
          if (typeof (image as any)?.close === 'function') (image as any).close();
          throw new Error(`Imagery provider returned a placeholder tile: ${level}/${x}/${y}`);
        }
        managed.image = image;
        managed.retryCount = 0;
        managed.retryAfter = 0;
        managed.state = ImageryState.Received;
      })
      .catch(() => {
        if (managed.disposed || managed.requestGeneration !== generation) return;
        // A transient provider/network failure must not permanently freeze this region on its
        // ancestor texture. Keep the ancestor visible and retry with bounded exponential backoff.
        managed.retryCount += 1;
        managed.retryAfter = performance.now() + Math.min(
          this.options.runtime.maximumImageryRetryDelay,
          250 * (2 ** Math.min(managed.retryCount - 1, 6)),
        );
        managed.state = ImageryState.Unloaded;
      })
      .finally(() => {
        if (timeout) clearTimeout(timeout);
        if (managed.requestGeneration === generation) managed.request = undefined;
        this.options.runtime.activeRequests -= 1;
      });
  }

  /**
   * Detect the flat, light-colour error JPEG returned as a successful WMTS response.
   * The test deliberately requires one quantized colour to cover most samples, which avoids
   * rejecting ordinary bright satellite content such as clouds or snow.
   */
  private isLikelyProviderErrorImage(image: any): boolean {
    const sourceWidth = Number(image?.naturalWidth ?? image?.videoWidth ?? image?.width ?? 0);
    const sourceHeight = Number(image?.naturalHeight ?? image?.videoHeight ?? image?.height ?? 0);
    if (sourceWidth < 16 || sourceHeight < 16) return false;
    try {
      const size = 32;
      const canvas = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(size, size)
        : Object.assign(document.createElement('canvas'), { width: size, height: size });
      const context = canvas.getContext('2d', { willReadFrequently: true }) as
        | CanvasRenderingContext2D
        | OffscreenCanvasRenderingContext2D
        | null;
      if (!context) return false;
      context.drawImage(image, 0, 0, size, size);
      const pixels = context.getImageData(0, 0, size, size).data;
      const histogram = new Map<number, number>();
      let dominantKey = 0;
      let dominantCount = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index + 3] < 240) continue;
        const key = ((pixels[index] >> 3) << 10) | ((pixels[index + 1] >> 3) << 5) | (pixels[index + 2] >> 3);
        const count = (histogram.get(key) ?? 0) + 1;
        histogram.set(key, count);
        if (count > dominantCount) {
          dominantCount = count;
          dominantKey = key;
        }
      }
      if (dominantCount / (size * size) < 0.68) return false;
      const red = ((dominantKey >> 10) & 31) << 3;
      const green = ((dominantKey >> 5) & 31) << 3;
      const blue = (dominantKey & 31) << 3;
      return Math.min(red, green, blue) >= 168 && Math.max(red, green, blue) - Math.min(red, green, blue) <= 48;
    } catch {
      // A tainted HTMLImageElement cannot be inspected. Keep the provider's normal behaviour in
      // that case; Cesium providers fetched through Resource usually expose an ImageBitmap.
      return false;
    }
  }

  /**
   * 对应 ImageryLayer._createTexture，在 Orillusion 中创建 sRGB 原投影纹理。
   * @param managed 已接收图片的影像。
   */
  private createTexture(managed: ManagedImagery): void {
    if (!managed.image) { managed.state = ImageryState.Invalid; return; }
    const image = managed.image;
    const texture = new BitmapTexture2D(true, this.options.context, 'srgb');
    // 影像瓦片的 UV 会精确落在 0/1 边界。Texture 默认的 repeat 会让线性过滤
    // 混入对侧像素，在相邻瓦片之间形成亮缝；Cesium 的影像采样语义应固定为边缘钳制。
    texture.addressModeU = 'clamp-to-edge';
    texture.addressModeV = 'clamp-to-edge';
    texture.source = image;
    // Cesium Resource 通常返回 ImageBitmap。Orillusion 会同时把它保存在 `_source` 和
    // `_sourceImageData`，即使 GPU 上传完成也不清空，数百张瓦片会因此长期占用原生
    // 解码内存。先强制物化并排入 copyExternalImageToTexture/mipmap，再关闭并断开 CPU 源。
    if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) {
      texture.getGPUTexture();
      image.close();
      const releasable = texture as unknown as { _source?: unknown; _sourceImageData?: unknown };
      releasable._source = undefined;
      releasable._sourceImageData = undefined;
    }
    if (managed.source.imageryLayer.imageryProvider.tilingScheme.projection instanceof WebMercatorProjection) managed.textureWebMercator = texture;
    else managed.texture = texture;
    managed.image = undefined;
    managed.state = ImageryState.TextureLoaded;
  }

  /**
   * 对应 ImageryLayer._reprojectTexture，WebMercator 到 Geographic 由 Orillusion ComputeShader 完成。
   * 与 Cesium 的 ComputeCommand 一致：提交后保持 TRANSITIONING，GPU 完成后才进入 READY；
   * 期间 eligibleForUnloading=false，源纹理和目标纹理都不会被缓存淘汰。
   * @param managed 已有源纹理的影像。
   * @param needGeographicProjection 是否需要地理投影结果。
   */
  private enqueueReprojection(managed: ManagedImagery, needGeographicProjection: boolean): void {
    const source = managed.textureWebMercator ?? managed.texture;
    if (!source) { managed.state = ImageryState.Invalid; return; }
    const provider = managed.source.imageryLayer.imageryProvider;
    const isWebMercator = provider.tilingScheme.projection instanceof WebMercatorProjection;
    const nativeRectangle = provider.tilingScheme.tileXYToNativeRectangle(managed.source.x, managed.source.y, managed.source.level);
    if (needGeographicProjection && isWebMercator && managed.source.rectangle.width / Math.max(1, (source as any).width ?? 256) > 1e-5) {
      managed.state = ImageryState.Transitioning;
      this.options.runtime.enqueueReprojection(managed, source, {
        width: Math.max(1, (source as any).width ?? 256),
        height: Math.max(1, (source as any).height ?? 256),
        geographicRectangle: managed.source.rectangle,
        webMercatorRectangle: nativeRectangle,
      });
      return;
    }
    if (needGeographicProjection) {
      managed.texture = source;
    }
    managed.state = ImageryState.Ready;
  }

  /** 取得或创建一个 Cesium Imagery 对应的适配状态。 */
  private getManaged(source: CesiumImageryLike): ManagedImagery {
    let managed = this.options.runtime.managed.get(source);
    if (!managed) {
      managed = {
        source,
        state: ImageryState.Unloaded,
        textureQueued: false,
        reprojectionQueued: false,
        disposed: false,
        retryCount: 0,
        retryAfter: 0,
        requestGeneration: 0,
      };
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
