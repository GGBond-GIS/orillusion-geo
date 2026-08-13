import { Camera3D, ColliderComponent, Engine3D, GeometryBase, MeshColliderShape, MeshRenderer, Object3D, UnLitMaterial, Vector3, setFrameDelay } from '@orillusion/core';
import { Cartesian2, Cartesian3, Cartesian4, EllipsoidTerrainProvider, ImageryLayerCollection, type ImageryLayer, type ImageryProvider, type TerrainProvider } from '@cesium/engine';
import { CesiumGlobeTileMaterial, type CesiumGlobeTileTexture } from '../Renderer/CesiumGlobeTileMaterial.js';
import { CesiumFrameTaskQueue } from '../Scheduler/CesiumFrameTaskQueue.js';
import { CesiumTileReplacementQueue } from '../Scheduler/CesiumTileReplacementQueue.js';
import { CesiumImageryRuntime, CesiumSurfaceImagery } from '../Terrain/CesiumImagerySkeleton.js';
import { CesiumSurfaceTile, type CesiumTerrainMesh } from '../Terrain/CesiumSurfaceTile.js';
import { GlobeQuadtree, type GlobeTileAccessor, type GlobeTraversalResult } from '../Terrain/GlobeQuadtree.js';
import { TerrainTileState, type TerrainTileKey } from '../Terrain/TerrainTileState.js';
import { configureCesiumWorkerRuntime } from '../Terrain/CesiumWorkerRuntime.js';

/** Cesium 瓦片坐标。 */
export interface GlobeTileCoordinate { x: number; y: number; level: number; }

/** Globe 初始化参数。 */
export interface GlobeOptions { engine: Engine3D; camera: Camera3D; terrainProvider?: TerrainProvider; imageryLayers?: ImageryLayerCollection; }

/** 单个瓦片的 LOD 阶段耗时（毫秒），用于量化加载链路延迟。 */
export interface GlobeStageTiming {
  /** 瓦片键。 */
  key: string;
  /** 创建 → 地形 Ready 耗时。 */
  terrainMs: number;
  /** 地形 Ready → 影像材质提交耗时。 */
  imageryMs: number;
}

/** 单帧各阶段耗时（毫秒），用于验证 LOD 切换是否卡顿。 */
export interface GlobeFrameTimes {
  /** 四叉树选择遍历。 */
  selectMs: number;
  /** 地形加载队列推进。 */
  loadMs: number;
  /** 影像状态机推进。 */
  imageryMs: number;
  /** GPU 提交（地形/纹理/重投影/材质）。 */
  gpuMs: number;
  /** 渲染列表应用。 */
  applyMs: number;
  /** 总计。 */
  totalMs: number;
}

/** Globe 调度统计，用于验证 LOD 和静止场景资源稳定性。 */
export interface GlobeStatistics {
  selectedLevels: number[];
  renderedLevels: number[];
  terrainTileCount: number;
  imageryTileCount: number;
  pendingTerrainCount: number;
  managedImageryCount: number;
  activeImageryRequests: number;
  pendingTextureUploads: number;
  pendingReprojections: number;
  pendingTerrainCommits: number;
  pendingMaterialCommits: number;
  loadQueueHighLength: number;
  loadQueueMediumLength: number;
  loadQueueLowLength: number;
  stageTimings: GlobeStageTiming[];
  /** 最近一帧各阶段耗时。 */
  frameTimes: GlobeFrameTimes;
}

/** 管理 Cesium 地形、影像状态机和 Orillusion ECS 瓦片实体。
 *  帧循环对齐 Cesium QuadtreePrimitive.beginFrame → selectTilesForRendering →
 *  processTileLoadQueue（三级队列、5ms 时间片、优先级排序）→ 渲染。
 *
 * 拾取说明：瓦片挂 ColliderComponent + MeshColliderShape（见 createTerrainObject），
 * 配合引擎官方 PickFire（bound 模式）做屏幕射线拾取，命中点即 ECEF 世界坐标。 */
export class Globe {
  /** 可挂入 Scene3D 的 ECS 根节点。 */
  public readonly group = new Object3D();
  /** Cesium 原生影像图层集合。 */
  public readonly imageryLayers: ImageryLayerCollection;
  /** 当前地形提供器。 */
  public terrainProvider: TerrainProvider;
  /** 对齐 Cesium QuadtreePrimitive 的瓦片资源缓存大小。 */
  public tileCacheSize = 512;
  /** 对齐 Cesium QuadtreePrimitive._loadQueueTimeSlice 的地形加载时间片（毫秒）。 */
  public loadQueueTimeSlice = 5.0;
  private readonly quadtree: GlobeQuadtree;
  private readonly tiles = new Map<string, Object3D>();
  private readonly surfaceTiles = new Map<string, CesiumSurfaceTile>();
  private readonly surfaceImagery = new Map<string, CesiumSurfaceImagery>();
  private readonly imageryRuntime: CesiumImageryRuntime;
  private readonly imageryMaterialRevision = new Map<string, number>();
  private readonly terrainCommitQueue = new CesiumFrameTaskQueue(2.0);
  private readonly materialCommitQueue = new CesiumFrameTaskQueue(2.0);
  private readonly queuedTerrainCommits = new Set<string>();
  private readonly queuedMaterialCommits = new Set<string>();
  private readonly tileReplacementQueue = new CesiumTileReplacementQueue<CesiumSurfaceTile>();
  private readonly recycledMaterials: CesiumGlobeTileMaterial[] = [];
  private readonly placeholderMaterial: UnLitMaterial;
  private readonly tileLoadWaiters = new Map<string, { promise: Promise<Object3D>; resolve: (object: Object3D) => void; reject: (error: Error) => void }>();
  private readonly stageTimings: GlobeStageTiming[] = [];
  private readonly options: GlobeOptions;
  private lastSelected: GlobeTileCoordinate[] = [];
  private frameNumber = 0;

  /** GlobeTileAccessor：把 Cesium QuadtreeTile / GlobeSurfaceTile 的只读面暴露给选择器。 */
  private readonly accessor: GlobeTileAccessor = {
    isFullyRenderable: (tile) => this.isRenderable(this.tileKey(tile)),
    isCompletelyLoaded: (tile) => {
      const key = this.tileKey(tile);
      const surfaceTile = this.surfaceTiles.get(key);
      if (!surfaceTile || surfaceTile.state !== TerrainTileState.Ready) return false;
      const imagery = this.surfaceImagery.get(key);
      return !imagery || imagery.isDoneLoading;
    },
    canRenderWithoutLosingDetail: (tile) => {
      const key = this.tileKey(tile);
      const surfaceTile = this.surfaceTiles.get(key);
      // 对齐 Cesium：本瓦片地形必须就绪，且影像层全部就绪或完成。
      if (!surfaceTile || surfaceTile.state !== TerrainTileState.Ready) return false;
      const imagery = this.surfaceImagery.get(key);
      if (imagery && !imagery.isReadyForCommit) return false;
      // 后代检查：上一帧渲染过的后代拥有真实地形时，渲染本瓦片会让细节消失，阻塞。
      return !this.descendantBlocksDetail(key);
    },
    needsLoading: (tile) => {
      const key = this.tileKey(tile);
      const surfaceTile = this.surfaceTiles.get(key);
      // Traversal creates virtual quadtree children before Globe materializes their
      // CesiumSurfaceTile state. They must be considered loadable in this frame; update()
      // creates every touched SurfaceTile before consuming the returned load queues.
      if (!surfaceTile) return true;
      if (surfaceTile.state !== TerrainTileState.Ready) return true;
      const imagery = this.surfaceImagery.get(key);
      // Download completion is not the end of this adapter's load pipeline. A child can be
      // kicked from the render frontier after its image finishes but before its material commit
      // runs. If that state is reported as fully loaded it disappears from every queue forever,
      // while the parent keeps waiting for isFullyRenderable and remains visibly coarse.
      if (!this.imageryMaterialRevision.has(key)) return true;
      return imagery ? !imagery.isDoneLoading : false;
    },
    hasTerrainData: (tile) => {
      const surfaceTile = this.surfaceTiles.get(this.tileKey(tile));
      return Boolean(surfaceTile?.terrainData);
    },
    isUpsampledFromParent: (tile) => {
      const key = this.tileKey(tile);
      const surfaceTile = this.surfaceTiles.get(key);
      if (!surfaceTile?.upsampledFromParent) return false;
      const imagery = this.surfaceImagery.get(key);
      return imagery ? imagery.allTileImageryFailedOrInvalid : true;
    },
    getBoundingVolume: (tile) => {
      // Only return this tile's measured terrain bounds. GlobeQuadtree creates a tile-local
      // synthetic region for virtual/unloaded children; inheriting an ancestor sphere makes
      // every descendant appear visible at grazing angles.
      return this.surfaceTiles.get(this.tileKey(tile))?.boundingVolume ?? undefined;
    },
  };

  /**
   * 创建 Globe 管理器。
   * @param options Orillusion 引擎、相机和 Cesium 服务配置。
   */
  public constructor(options: GlobeOptions) {
    this.options = options;
    configureCesiumWorkerRuntime();
    this.terrainProvider = options.terrainProvider ?? new EllipsoidTerrainProvider();
    this.imageryLayers = options.imageryLayers ?? new ImageryLayerCollection();
    this.imageryRuntime = new CesiumImageryRuntime(options.engine.context3D);
    this.quadtree = new GlobeQuadtree({ terrainProvider: this.terrainProvider, camera: options.camera });
    this.placeholderMaterial = new UnLitMaterial(options.engine.context3D);
    this.placeholderMaterial.baseMap = options.engine.res.whiteTexture;
    this.group.name = 'Cesium Globe';
  }

  /**
   * 以 Cesium 语义添加影像提供器。
   * @param provider Cesium Engine 影像提供器。
   * @returns 创建的 Cesium 影像图层。
   */
  public addImageryProvider(provider: ImageryProvider): ImageryLayer {
    return this.imageryLayers.addImageryProvider(provider);
  }

  /**
   * 移除影像图层并释放全部瓦片上的 TileImagery 骨架。
   * 对齐 Cesium ImageryLayerCollection.remove → GlobeSurfaceTileProvider._onLayerRemoved。
   * @param layer 待移除的影像图层。
   */
  public removeImageryLayer(layer: ImageryLayer): void {
    if (this.imageryLayers.indexOf(layer) < 0) return;
    this.imageryLayers.remove(layer, true);
    for (const [key, imagery] of this.surfaceImagery) {
      imagery.removeLayer(layer);
      // 影像内容变化，强制瓦片重新提交材质。
      this.imageryMaterialRevision.delete(key);
    }
  }

  /**
   * 等待指定坐标的地形网格首次创建（事件驱动，不再轮询）。
   * @param coordinate 待加载的 Cesium 瓦片坐标。
   * @returns 已挂入 Globe 的 ECS 实体。
   */
  public loadTile(coordinate: GlobeTileCoordinate): Promise<Object3D> {
    const key = this.tileKey(coordinate);
    const cached = this.tiles.get(key);
    if (cached) return Promise.resolve(cached);
    this.ensureSurfaceTile(coordinate);
    const existing = this.tileLoadWaiters.get(key);
    if (existing) return existing.promise;
    let resolve!: (object: Object3D) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<Object3D>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.tileLoadWaiters.set(key, { promise, resolve, reject });
    return promise;
  }

  /** 最近一帧各阶段耗时。 */
  private frameTimes: GlobeFrameTimes = { selectMs: 0, loadMs: 0, imageryMs: 0, gpuMs: 0, applyMs: 0, totalMs: 0 };

  /**
   * 按 Cesium 的帧阶段推进选择、地形、影像、GPU 准备和最终可见提交。
   * 网络 Promise 只改变状态；纹理和材质创建都在受限的帧末队列内完成。
   */
  public update(): void {
    const frameStart = performance.now();
    this.frameNumber += 1;
    this.tileReplacementQueue.markStartOfRenderFrame();
    const traversal = this.quadtree.select(this.frameNumber, this.accessor);
    this.lastSelected = traversal.renderList;
    const selectEnd = performance.now();

    // 为所有遍历到的瓦片建立状态机（含父链），并保活 replacement queue（对齐 visitTile 的 markTileRendered）。
    for (const key of traversal.touchedKeys) {
      const coordinate = this.parseTileKey(key);
      const tile = this.ensureSurfaceTile(coordinate);
      this.tileReplacementQueue.markTileRendered(key, tile);
    }

    this.processTileLoadQueue(traversal);
    const loadEnd = performance.now();
    this.processImageryStateMachines(traversal);
    const imageryEnd = performance.now();
    this.processGpuQueues();
    // 材质提交会解除祖先纹理引用；随后再执行 Cesium/Orillusion 双引用回收。
    this.imageryRuntime.releaseUnused();
    const gpuEnd = performance.now();
    this.applySelection(traversal.renderList);
    const applyEnd = performance.now();

    this.frameTimes = {
      selectMs: selectEnd - frameStart,
      loadMs: loadEnd - selectEnd,
      imageryMs: imageryEnd - loadEnd,
      gpuMs: gpuEnd - imageryEnd,
      applyMs: applyEnd - gpuEnd,
      totalMs: applyEnd - frameStart,
    };
  }

  /** 返回当前选择、队列和资源计数。 */
  public get statistics(): GlobeStatistics {
    const renderedLevels: number[] = [];
    for (const [key, object] of this.tiles) if (object.getComponent(MeshRenderer)?.enable) renderedLevels.push(this.parseTileKey(key).level);
    const imageryStatistics = this.imageryRuntime.statistics;
    return {
      selectedLevels: [...new Set(this.lastSelected.map(tile => tile.level))].sort((a, b) => a - b),
      renderedLevels: [...new Set(renderedLevels)].sort((a, b) => a - b),
      terrainTileCount: this.tiles.size,
      imageryTileCount: this.surfaceImagery.size,
      pendingTerrainCount: [...this.surfaceTiles.values()].filter(tile => tile.state !== TerrainTileState.Ready).length,
      managedImageryCount: imageryStatistics.managedImageryCount,
      activeImageryRequests: imageryStatistics.activeRequests,
      pendingTextureUploads: imageryStatistics.pendingTextureUploads,
      pendingReprojections: imageryStatistics.pendingReprojections,
      pendingTerrainCommits: this.terrainCommitQueue.statistics.pending,
      pendingMaterialCommits: this.materialCommitQueue.statistics.pending,
      loadQueueHighLength: this.lastTraversal?.loadQueueHigh.length ?? 0,
      loadQueueMediumLength: this.lastTraversal?.loadQueueMedium.length ?? 0,
      loadQueueLowLength: this.lastTraversal?.loadQueueLow.length ?? 0,
      stageTimings: this.stageTimings,
      frameTimes: this.frameTimes,
    };
  }

  /** 释放 ECS、Cesium 引用、GPU 纹理和所有待执行闭包。 */
  public dispose(): void {
    this.terrainCommitQueue.clear();
    this.materialCommitQueue.clear();
    const imageryToDispose = [...this.surfaceImagery.values()];
    const objectsToDestroy = [...this.tiles.values()];
    this.tiles.clear();
    this.surfaceTiles.clear();
    this.surfaceImagery.clear();
    this.imageryMaterialRevision.clear();
    this.queuedTerrainCommits.clear();
    this.queuedMaterialCommits.clear();
    this.tileReplacementQueue.clear();
    for (const waiter of this.tileLoadWaiters.values()) waiter.reject(new Error('Globe disposed'));
    this.tileLoadWaiters.clear();
    for (const imagery of imageryToDispose) imagery.dispose();
    for (const object of objectsToDestroy) this.destroyTerrainObject(object);
    for (const material of this.recycledMaterials) material.destroy(true);
    this.recycledMaterials.length = 0;
    this.imageryRuntime.dispose();
    if (this.placeholderMaterial.shader) this.placeholderMaterial.destroy(true);
    this.group.destroy(true);
  }

  /**
   * 对齐 Cesium QuadtreePrimitive.processTileLoadQueue：
   * 高/中/低三级队列依次处理，5ms 时间片内至少推进一个瓦片；队列为空时不做 trim。
   */
  private processTileLoadQueue(traversal: GlobeTraversalResult): void {
    this.lastTraversal = traversal;
    const { loadQueueHigh, loadQueueMedium, loadQueueLow } = traversal;
    // 3d-tiles-renderer enforces its LRU budget every update. The previous Cesium-style early
    // return retained the deepest zoom's resources forever after the load queues settled.
    this.trimTileCache();
    if (loadQueueHigh.length === 0 && loadQueueMedium.length === 0 && loadQueueLow.length === 0) {
      return;
    }
    const endTime = performance.now() + this.loadQueueTimeSlice;
    let didSomeLoading = this.processSingleLoadQueue(loadQueueHigh, endTime, false);
    didSomeLoading = this.processSingleLoadQueue(loadQueueMedium, endTime, didSomeLoading);
    this.processSingleLoadQueue(loadQueueLow, endTime, didSomeLoading);
  }

  /** 对齐 Cesium processSinglePriorityLoadQueue：队列已按优先级排序，时间片内推进状态机。 */
  private processSingleLoadQueue(queue: TerrainTileKey[], endTime: number, didSomeLoading: boolean): boolean {
    for (let index = 0; index < queue.length && (performance.now() < endTime || !didSomeLoading); index += 1) {
      const key = this.tileKey(queue[index]);
      const tile = this.surfaceTiles.get(key);
      if (!tile) continue;
      this.tileReplacementQueue.markTileRendered(key, tile);
      this.advanceTileLoad(key, tile);
      didSomeLoading = true;
    }
    return didSomeLoading;
  }

  /**
   * 对齐 Cesium GlobeSurfaceTileProvider.loadTile：
   * 只推进地形状态机；影像由 processImageryStateMachines 在同一帧推进，
   * 且只对确定可见（未被 CULLED_BUT_NEEDED）且包围体已准确（地形 Ready）的瓦片加载。
   */
  private advanceTileLoad(key: string, tile: CesiumSurfaceTile): void {
    if (tile.update(this.terrainProvider, 1, 0)) this.enqueueTerrainCommit(key, tile);
  }

  /**
   * 推进 GlobeSurfaceTile → TileImagery → Imagery，并只对最终完成的纹理排入材质提交。
   * 只处理本帧可渲染/已入队且未被 CULLED_BUT_NEEDED 的瓦片（对齐 Cesium terrainOnly 语义）。
   */
  private processImageryStateMachines(traversal: GlobeTraversalResult): void {
    const keys = new Set<string>();
    // The quadtree has already sorted the high queue by screen-centre angle and distance. Feed
    // imagery in that order before the DFS render list; otherwise the first 18 DFS tiles can
    // repeatedly occupy every request slot and starve a central visible tile until the camera
    // moves enough to change traversal order.
    for (const coordinate of traversal.loadQueueHigh) keys.add(this.tileKey(coordinate));
    for (const coordinate of traversal.renderList) keys.add(this.tileKey(coordinate));
    for (const coordinate of traversal.loadQueueMedium) keys.add(this.tileKey(coordinate));
    for (const coordinate of traversal.loadQueueLow) keys.add(this.tileKey(coordinate));
    for (const key of traversal.culledButNeededKeys) keys.delete(key);
    for (const key of keys) this.processImageryForKey(key);
  }

  /** 推进单个瓦片的影像状态机，就绪后排队材质提交。 */
  private processImageryForKey(key: string): void {
    const surfaceTile = this.surfaceTiles.get(key);
    if (!surfaceTile || surfaceTile.state !== TerrainTileState.Ready) return;
    const coordinate = surfaceTile.key;
    let imagery = this.surfaceImagery.get(key);
    if (!imagery) {
      imagery = new CesiumSurfaceImagery(coordinate, this.terrainProvider.tilingScheme.tileXYToRectangle(coordinate.x, coordinate.y, coordinate.level), {
        context: this.options.engine.context3D,
        terrainProvider: this.terrainProvider,
        imageryLayers: this.imageryLayers,
        runtime: this.imageryRuntime,
      });
      this.surfaceImagery.set(key, imagery);
    }
    const textures = imagery.processStateMachine();
    if (!imagery.isReadyForCommit || !this.tiles.has(key)) return;
    if (this.imageryMaterialRevision.get(key) === imagery.revision || this.queuedMaterialCommits.has(key)) return;
    this.enqueueMaterialCommit(key, imagery, textures);
  }

  /**
   * 帧末消费 GPU 资源队列。对齐 Cesium 帧内命令队列：
   *  - 地形 ECS 提交与材质提交是同步操作，按数量限额消费，无全局背压；
   *  - 纹理上传（同步 copy）按数量限额消费；
   *  - 重投影整批提交一个 CommandEncoder，仅在上一批 GPU 工作完成前跳过（reprojector.isBusy）。
   */
  private processGpuQueues(): void {
    this.terrainCommitQueue.process(4);
    this.imageryRuntime.processGpuQueues();
    this.materialCommitQueue.process(8);
  }

  /**
   * 把 Worker 已完成的网格延迟到 ECS 提交队列。
   * @param key 瓦片键。
   * @param tile 已得到 Cesium TerrainMesh 的瓦片。
   */
  private enqueueTerrainCommit(key: string, tile: CesiumSurfaceTile): void {
    if (this.tiles.has(key) || this.queuedTerrainCommits.has(key)) return;
    this.queuedTerrainCommits.add(key);
    void this.terrainCommitQueue.enqueue(() => {
      this.queuedTerrainCommits.delete(key);
      if (this.tiles.has(key) || this.surfaceTiles.get(key) !== tile || !tile.mesh) return;
      const object = this.createTerrainObject(tile.mesh, tile.key);
      this.tiles.set(key, object);
      this.group.addChild(object);
      this.resolveTileLoadWaiters(key, object);
    }).catch(() => { this.queuedTerrainCommits.delete(key); });
  }

  /**
   * 将 Cesium TerrainMesh 解码成 Orillusion GeometryBase。
   * @param terrainMesh Cesium Worker 生成的网格。
   * @param coordinate 对应地形坐标。
   * @returns 默认隐藏、等待最终影像材质的 ECS 实体。
   */
  private createTerrainObject(terrainMesh: CesiumTerrainMesh, coordinate: GlobeTileCoordinate): Object3D {
    const vertexCount = terrainMesh.vertices.length / terrainMesh.stride;
    // 平坦椭球地形（EllipsoidTerrainProvider，高度恒为 0）下相邻瓦片边缘高度完全
    // 一致，不存在 LOD 高度差裂缝——Cesium 的裙边（默认 = 几何误差 × 5，
    // level 12 ≈ 24km、level 2 ≈ 2.5 万 km）纯属冗余几何：浪费显存/带宽，贴地与
    // 地平线视角还会露出竖墙（用户反馈的"裙边"）。平坦地形直接剔除：只保留
    // indexCountWithoutSkirts 个地表三角形、只解码非裙边顶点。真实地形 provider
    // （有高度起伏）时裙边保留（补缝必需）。
    const isFlatTerrain = this.terrainProvider instanceof EllipsoidTerrainProvider;
    const skirtVertexCount = isFlatTerrain
      ? terrainMesh.westIndicesSouthToNorth.length +
        terrainMesh.southIndicesEastToWest.length +
        terrainMesh.eastIndicesNorthToSouth.length +
        terrainMesh.northIndicesWestToEast.length
      : 0;
    const surfaceVertexCount = vertexCount - skirtVertexCount;
    const indexCount = isFlatTerrain ? terrainMesh.indexCountWithoutSkirts : terrainMesh.indices.length;
    const positions = new Float32Array(surfaceVertexCount * 3);
    const uvs = new Float32Array(surfaceVertexCount * 2);
    const webMercatorUvs = new Float32Array(surfaceVertexCount * 2);
    const position = new Cartesian3();
    const uv = new Cartesian2();
    // RTC（Relative To Center）：顶点存相对瓦片中心的偏移（小数值，f32 精度高），
    // 绝对 ECEF 中心放进瓦片实体 transform。引擎 RTE 模式按模型世界位置的高/低
    // 分裂表做分裂双精度减法（modelPos - cameraPos），配合 doublePrecision(f64
    // 矩阵) 让贴地视角的顶点精度达到毫米级；若直接存绝对 ECEF f32（~6.4e6，
    // ulp≈0.5m），近距渲染会抖动。Cesium 的 TerrainEncoding.decodePosition 返回
    // 绝对坐标（已加回 relativeToCenter），这里减回 mesh.center 得到相对坐标。
    const center = terrainMesh.center;
    for (let index = 0; index < surfaceVertexCount; index += 1) {
      terrainMesh.encoding.decodePosition(terrainMesh.vertices, index, position);
      terrainMesh.encoding.decodeTextureCoordinates(terrainMesh.vertices, index, uv);
      positions.set([position.x - center.x, position.y - center.y, position.z - center.z], index * 3);
      uvs.set([uv.x, uv.y], index * 2);
      webMercatorUvs.set([uv.x, terrainMesh.encoding.decodeWebMercatorT(terrainMesh.vertices, index)], index * 2);
    }
    const geometry = new GeometryBase();
    geometry.setAttribute('position', positions);
    geometry.setAttribute('uv', uvs);
    geometry.setAttribute('TEXCOORD_1', webMercatorUvs);
    geometry.setIndices(isFlatTerrain ? terrainMesh.indices.subarray(0, indexCount) : terrainMesh.indices);
    geometry.addSubGeometry({ indexStart: 0, indexCount, vertexStart: 0, vertexCount: surfaceVertexCount, firstStart: 0, index: 0, topology: 0 });
    const object = new Object3D();
    object.name = `Terrain ${coordinate.level}/${coordinate.x}/${coordinate.y}`;
    // 瓦片实体位移 = 绝对 ECEF 瓦片中心；顶点缓冲是相对偏移（RTC）。
    object.transform.localPosition = new Vector3(center.x, center.y, center.z);
    const renderer = object.addComponent(MeshRenderer);
    renderer.geometry = geometry;
    renderer.material = this.placeholderMaterial;
    renderer.enable = false;
    // GPU 拾取（Orillusion pick 管线）：pixel 模式下引擎每帧把挂 ColliderComponent 的
    // 网格画进拾取缓冲，点击时读回 meshID 与命中点世界坐标（ECEF，与顶点同一参考系）。
    const collider = object.addComponent(ColliderComponent);
    const shape = new MeshColliderShape();
    shape.mesh = geometry;
    collider.shape = shape;
    return object;
  }

  /**
   * 把最终影像材质创建延迟到独立帧，并在完成前继续渲染父瓦片。
   * @param key 瓦片键。
   * @param imagery 对应的最终影像状态机。
   * @param textures 已完成上传或重投影的纹理条目。
   */
  private enqueueMaterialCommit(key: string, imagery: CesiumSurfaceImagery, textures: CesiumGlobeTileTexture[]): void {
    this.queuedMaterialCommits.add(key);
    const revision = imagery.revision;
    void this.materialCommitQueue.enqueue(() => {
      this.queuedMaterialCommits.delete(key);
      const object = this.tiles.get(key);
      if (!object || this.surfaceImagery.get(key) !== imagery || !imagery.isReadyForCommit) return;
      // 对齐 Cesium：全部影像失败/完成的瓦片以占位纹理渲染（GlobeFS dayTextureCount == 0 的等价物）。
      if (textures.length === 0) {
        textures.push(this.createPlaceholderTexture());
      }
      const renderer = object.getComponent(MeshRenderer);
      const previous = renderer.material;
      if (previous instanceof CesiumGlobeTileMaterial) previous.updateImagery(textures);
      else renderer.material = this.acquireTileMaterial(textures);
      this.imageryMaterialRevision.set(key, revision);
      this.recordStageTiming(key);
    }).catch(() => { this.queuedMaterialCommits.delete(key); });
  }

  /** 全部影像图层失败时使用的占位纹理条目（白色，采样参数为单位映射）。 */
  private createPlaceholderTexture(): CesiumGlobeTileTexture {
    return {
      texture: this.options.engine.res.whiteTexture,
      textureCoordinateRectangle: new Cartesian4(0, 0, 1, 1),
      textureTranslationAndScale: new Cartesian4(0, 0, 1, 1),
      useWebMercatorT: false,
    };
  }

  /** 记录瓦片 LOD 阶段耗时（保留最近 50 条）。 */
  private recordStageTiming(key: string): void {
    const surfaceTile = this.surfaceTiles.get(key);
    if (!surfaceTile || surfaceTile.readyAt === 0) return;
    this.stageTimings.push({
      key,
      terrainMs: Math.max(0, surfaceTile.readyAt - surfaceTile.createdAt),
      imageryMs: Math.max(0, performance.now() - surfaceTile.readyAt),
    });
    if (this.stageTimings.length > 50) this.stageTimings.shift();
  }

  /** 建立指定瓦片及其所有祖先。 */
  private ensureSurfaceTile(coordinate: GlobeTileCoordinate): CesiumSurfaceTile {
    const key = this.tileKey(coordinate);
    const cached = this.surfaceTiles.get(key);
    if (cached) return cached;
    const parent = coordinate.level === 0 ? null : this.ensureSurfaceTile({ x: Math.floor(coordinate.x / 2), y: Math.floor(coordinate.y / 2), level: coordinate.level - 1 });
    const tile = new CesiumSurfaceTile(coordinate, parent);
    this.surfaceTiles.set(key, tile);
    return tile;
  }

  /** 对齐 Cesium addTileToRenderList 后的绘制阶段：可渲染瓦片直接绘制，否则回退最近的可渲染祖先
   *  （Cesium 在此时绘制 fill，项目没有 fill 几何，用祖先替代，细节不消失）。 */
  private applySelection(renderList: TerrainTileKey[]): void {
    const candidates = new Set<string>();
    for (const coordinate of renderList) {
      const key = this.tileKey(coordinate);
      if (this.isRenderable(key)) {
        candidates.add(key);
        continue;
      }
      let ancestor = this.quadtree.parentKey(key);
      while (ancestor) {
        if (this.isRenderable(ancestor)) {
          candidates.add(ancestor);
          break;
        }
        ancestor = this.quadtree.parentKey(ancestor);
      }
    }

    // Cesium renders an unready selected tile with a TerrainFillMesh that has exactly the
    // selected tile's footprint. We do not have fill geometry yet, so the fallback above uses
    // a complete ancestor tile. If one sibling falls back while another sibling is ready, the
    // ancestor and the ready sibling would otherwise be drawn over the same surface for a frame.
    // Collapse the candidates to a quadtree antichain: an ancestor fallback atomically replaces
    // every candidate below it until all selected descendants are renderable.
    const drawKeys = new Set<string>();
    const shallowestFirst = [...candidates].sort((left, right) =>
      this.parseTileKey(left).level - this.parseTileKey(right).level,
    );
    for (const key of shallowestFirst) {
      let ancestor = this.quadtree.parentKey(key);
      let coveredByAncestor = false;
      while (ancestor) {
        if (drawKeys.has(ancestor)) {
          coveredByAncestor = true;
          break;
        }
        ancestor = this.quadtree.parentKey(ancestor);
      }
      if (!coveredByAncestor) drawKeys.add(key);
    }

    // Commit the replacement in two phases. Tiles are inserted parent-first, so a single pass
    // would enable a parent before disabling its old descendants during a down-level switch.
    // Orillusion updates its render-component registry from the enable setter; removing every
    // outgoing tile first prevents an intermediate parent+descendant state from leaking into a
    // render-node snapshot or a picking pass.
    for (const [key, object] of this.tiles) {
      if (!drawKeys.has(key)) this.setTileVisibility(object, false);
    }
    for (const key of drawKeys) {
      const object = this.tiles.get(key);
      if (object) this.setTileVisibility(object, true);
    }
  }

  /** Atomically keep the terrain renderer and its picker participation in the same state. */
  private setTileVisibility(object: Object3D, visible: boolean): void {
    const renderer = object.getComponent(MeshRenderer);
    if (renderer.enable !== visible) renderer.enable = visible;
    // 拾取一致性：ColliderComponent 参与引擎 enablePickerList 遍历（bound 拾取），
    // 必须与渲染可见性同步，避免屏幕外的隐藏瓦片被拾取到。
    const collider = object.getComponent(ColliderComponent);
    if (collider && collider.enable !== visible) collider.enable = visible;
  }

  /** 地形实体和最终影像材质都提交后才允许显示。 */
  private isRenderable(key: string): boolean {
    return this.surfaceTiles.get(key)?.state === TerrainTileState.Ready && this.tiles.has(key) && this.imageryMaterialRevision.has(key);
  }

  /**
   * 对齐 Cesium canRenderWithoutLosingDetail 的后代检查：
   * 遍历上一帧被细化（REFINED）的后代，若其中任一上一帧渲染过（RENDERED）且地形已就绪，
   * 渲染本瓦片会导致细节消失，返回 true 阻塞。
   */
  private descendantBlocksDetail(key: string): boolean {
    const stack: string[] = [];
    const children = this.childKeys(key);
    for (const child of children) stack.push(child);
    while (stack.length > 0) {
      const descendant = stack.pop() as string;
      if (this.quadtree.wasRenderedLastFrame(descendant, this.frameNumber)) {
        if (this.surfaceTiles.get(descendant)?.state === TerrainTileState.Ready) {
          return true;
        }
      } else if (this.quadtree.wasRefinedLastFrame(descendant, this.frameNumber)) {
        for (const grandchild of this.childKeys(descendant)) stack.push(grandchild);
      }
    }
    return false;
  }

  /** 取四个子瓦片键。 */
  private childKeys(key: string): string[] {
    const coordinate = this.parseTileKey(key);
    const level = coordinate.level + 1;
    const x = coordinate.x * 2;
    const y = coordinate.y * 2;
    return [
      this.tileKey({ x, y, level }),
      this.tileKey({ x: x + 1, y, level }),
      this.tileKey({ x, y: y + 1, level }),
      this.tileKey({ x: x + 1, y: y + 1, level }),
    ];
  }

  /**
   * 对齐 Cesium TileReplacementQueue：超过缓存预算时释放最久未使用的瓦片资源。
   * @param protectedKeys 当前选择及祖先，绝不在本帧淘汰。
   */
  private trimTileCache(): void {
    this.tileReplacementQueue.trimTiles(
      this.tileCacheSize,
      (tile, key) => !this.queuedTerrainCommits.has(key)
        && !this.queuedMaterialCommits.has(key)
        && tile.eligibleForUnloading
        && (this.surfaceImagery.get(key)?.eligibleForUnloading ?? true),
      (tile, key) => {
        this.quadtree.invalidate(key);
        const object = this.tiles.get(key);
        this.tiles.delete(key);
        // The replacement queue owns the lifetime of the surface tile as well. Keeping it in
        // this map retained TerrainData, parent links and traversal state after GPU eviction.
        this.surfaceTiles.delete(key);
        const imagery = this.surfaceImagery.get(key);
        this.surfaceImagery.delete(key);
        this.imageryMaterialRevision.delete(key);
        this.rejectTileLoadWaiters(key);
        this.retireTerrainResources(object, imagery, tile);
      },
    );
  }

  /**
   * 先从渲染收集器摘除瓦片，下一帧遍历结束后等待 WebGPU 已提交工作完成，再释放资源。
   * 这对应 Cesium 在本帧选择完成后的 freeResources 边界，同时满足 WebGPU 显式资源生命周期。
   * @param object 待淘汰的 ECS 地形实体。
   * @param imagery 待释放 Cesium 引用的影像状态机。
   * @param tile 待清理 TerrainData 和 Worker 网格的地形瓦片。
   */
  private retireTerrainResources(object: Object3D | undefined, imagery: CesiumSurfaceImagery | undefined, tile: CesiumSurfaceTile): void {
    let geometry: GeometryBase | undefined;
    let material: CesiumGlobeTileMaterial | undefined;
    if (object) {
      const renderer = object.getComponent(MeshRenderer);
      if (renderer) {
        renderer.enable = false;
        geometry = renderer.geometry;
        const currentMaterial = renderer.material;
        if (currentMaterial instanceof CesiumGlobeTileMaterial) material = currentMaterial;
        // 先解除 RenderNode 对 GPU 资源的引用，再销毁 ECS 节点；resize/pipeline rebuild 不会再看到退役材质。
        renderer.materials = [];
        renderer.geometry = undefined as unknown as GeometryBase;
      }
      object.removeSelf();
      object.destroy(false);
    }
    const finalize = (): void => {
      geometry?.destroy(true);
      if (material) {
        material.resetForPool(this.options.engine.res.whiteTexture);
        this.recycledMaterials.push(material);
      }
      imagery?.dispose();
      tile.freeResources();
      this.imageryRuntime.releaseUnused();
    };
    void setFrameDelay(2)
      .then(() => this.options.engine.context3D.device.queue.onSubmittedWorkDone())
      .then(finalize)
      .catch(finalize);
  }

  /** 瓦片实体创建完成时兑现 loadTile 等待者。 */
  private resolveTileLoadWaiters(key: string, object: Object3D): void {
    const waiter = this.tileLoadWaiters.get(key);
    if (waiter) {
      this.tileLoadWaiters.delete(key);
      waiter.resolve(object);
    }
  }

  /** 瓦片被淘汰时拒绝 loadTile 等待者。 */
  private rejectTileLoadWaiters(key: string): void {
    const waiter = this.tileLoadWaiters.get(key);
    if (waiter) {
      this.tileLoadWaiters.delete(key);
      waiter.reject(new Error(`Tile released: ${key}`));
    }
  }

  /**
   * 从有界复用池取得 Globe tile 材质，避免 Orillusion 旧 RenderPass 晚到时引用已销毁参数纹理。
   * @param textures 当前瓦片已准备好的 Cesium 影像采样参数。
   * @returns 已更新为当前影像的瓦片材质。
   */
  private acquireTileMaterial(textures: CesiumGlobeTileTexture[]): CesiumGlobeTileMaterial {
    const material = this.recycledMaterials.pop();
    if (material) {
      material.updateImagery(textures);
      return material;
    }
    return new CesiumGlobeTileMaterial(this.options.engine.context3D, textures);
  }

  /**
   * 销毁单个地形实体的材质、几何体和 ECS 节点。
   * @param object 待释放的地形实体。
   */
  private destroyTerrainObject(object: Object3D): void {
    // RenderNode.beforeDestroy 已按引用计数释放 Geometry 和 Material；调用方禁止再次销毁它们。
    object.destroy(true);
  }

  /** 生成内部瓦片键。 */
  private tileKey(tile: GlobeTileCoordinate): string { return `${tile.level}/${tile.x}/${tile.y}`; }

  /** 从内部瓦片键恢复坐标（热路径：避免 split/map 分配）。 */
  private parseTileKey(key: string): GlobeTileCoordinate {
    const first = key.indexOf('/');
    const second = key.indexOf('/', first + 1);
    return { x: Number(key.slice(first + 1, second)), y: Number(key.slice(second + 1)), level: Number(key.slice(0, first)) };
  }

  private lastTraversal: GlobeTraversalResult | null = null;
}
