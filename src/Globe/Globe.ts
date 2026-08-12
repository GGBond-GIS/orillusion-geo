import { Camera3D, Engine3D, GeometryBase, MeshRenderer, Object3D, UnLitMaterial, setFrameDelay } from '@orillusion/core';
import { Cartesian2, Cartesian3, EllipsoidTerrainProvider, ImageryLayer, ImageryLayerCollection, type ImageryProvider, type TerrainProvider } from '@cesium/engine';
import { CesiumGlobeTileMaterial, type CesiumGlobeTileTexture } from '../Renderer/CesiumGlobeTileMaterial.js';
import { CesiumFrameTaskQueue } from '../Scheduler/CesiumFrameTaskQueue.js';
import { CesiumTileReplacementQueue } from '../Scheduler/CesiumTileReplacementQueue.js';
import { CesiumImageryRuntime, CesiumSurfaceImagery } from '../Terrain/CesiumImagerySkeleton.js';
import { CesiumSurfaceTile, type CesiumTerrainMesh } from '../Terrain/CesiumSurfaceTile.js';
import { GlobeQuadtree } from '../Terrain/GlobeQuadtree.js';
import { TerrainTileState } from '../Terrain/TerrainTileState.js';
import { configureCesiumWorkerRuntime } from '../Terrain/CesiumWorkerRuntime.js';

/** Cesium 瓦片坐标。 */
export interface GlobeTileCoordinate { x: number; y: number; level: number; }

/** Globe 初始化参数。 */
export interface GlobeOptions { engine: Engine3D; camera: Camera3D; terrainProvider?: TerrainProvider; imageryLayers?: ImageryLayerCollection; }

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
}

/** 管理 Cesium 地形、影像状态机和 Orillusion ECS 瓦片实体。 */
export class Globe {
  /** 可挂入 Scene3D 的 ECS 根节点。 */
  public readonly group = new Object3D();
  /** Cesium 原生影像图层集合。 */
  public readonly imageryLayers: ImageryLayerCollection;
  /** 当前地形提供器。 */
  public terrainProvider: TerrainProvider;
  /** 对齐 Cesium QuadtreePrimitive 的瓦片资源缓存大小。 */
  public tileCacheSize = 512;
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
  private readonly terrainLoadTimeSlice = 5.0;
  private readonly options: GlobeOptions;
  private lastSelected: GlobeTileCoordinate[] = [];
  private lastSelectedKeys = new Set<string>();
  private frameNumber = 0;
  private gpuCommitReady = true;
  private disposed = false;

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
   * 等待指定坐标的地形网格首次创建。
   * @param coordinate 待加载的 Cesium 瓦片坐标。
   * @returns 已挂入 Globe 的 ECS 实体。
   */
  public async loadTile(coordinate: GlobeTileCoordinate): Promise<Object3D> {
    const key = this.tileKey(coordinate);
    const cached = this.tiles.get(key);
    if (cached) return cached;
    this.ensureSurfaceTile(coordinate);
    return new Promise((resolve, reject) => {
      const timer = window.setInterval(() => {
        const tile = this.tiles.get(key);
        if (tile) { window.clearInterval(timer); resolve(tile); }
        if (!this.surfaceTiles.has(key)) { window.clearInterval(timer); reject(new Error(`Tile released: ${key}`)); }
      }, 16);
    });
  }

  /**
   * 按 Cesium 的帧阶段推进选择、地形、影像、GPU 准备和最终可见提交。
   * 网络 Promise 只改变状态；纹理和材质创建都在受限的帧末队列内完成。
   */
  public update(): void {
    this.frameNumber += 1;
    this.tileReplacementQueue.markStartOfRenderFrame();
    const selected = this.quadtree.select();
    this.lastSelected = selected;
    const selectedKeys = this.collectSelectedAndAncestors(selected);
    this.lastSelectedKeys = selectedKeys;
    for (const key of selectedKeys) {
      const tile = this.ensureSurfaceTile(this.parseTileKey(key));
      this.tileReplacementQueue.markTileRendered(key, tile);
    }

    this.processTerrainLoadQueue(selectedKeys);
    this.processImageryStateMachines(selectedKeys);
    this.processGpuCommitQueues();
    // 材质提交会解除祖先纹理引用；随后再执行 Cesium/Orillusion 双引用回收。
    this.imageryRuntime.releaseUnused();
    this.applySelection(selected);
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
      pendingTerrainCount: [...this.lastSelectedKeys].filter(key => this.surfaceTiles.get(key)?.state !== TerrainTileState.Ready).length,
      managedImageryCount: imageryStatistics.managedImageryCount,
      activeImageryRequests: imageryStatistics.activeRequests,
      pendingTextureUploads: imageryStatistics.pendingTextureUploads,
      pendingReprojections: imageryStatistics.pendingReprojections,
      pendingTerrainCommits: this.terrainCommitQueue.statistics.pending,
      pendingMaterialCommits: this.materialCommitQueue.statistics.pending,
    };
  }

  /** 释放 ECS、Cesium 引用、GPU 纹理和所有待执行闭包。 */
  public dispose(): void {
    this.disposed = true;
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
    for (const imagery of imageryToDispose) imagery.dispose();
    for (const object of objectsToDestroy) this.destroyTerrainObject(object);
    for (const material of this.recycledMaterials) material.destroy(true);
    this.recycledMaterials.length = 0;
    this.imageryRuntime.dispose();
    if (this.placeholderMaterial.shader) this.placeholderMaterial.destroy(true);
    this.group.destroy(true);
  }

  /**
   * 按 Cesium 帧末提交语义消费 GPU 资源队列，并用上一批 WebGPU 工作的完成信号施加背压。
   * 网络请求和状态机仍然异步推进；只有纹理、重投影、网格和材质的 GPU 提交被限流。
   */
  private processGpuCommitQueues(): void {
    if (!this.gpuCommitReady) return;
    let submittedTasks = this.terrainCommitQueue.process(2);
    submittedTasks += this.imageryRuntime.processGpuQueues();
    submittedTasks += this.materialCommitQueue.process(4);
    if (submittedTasks === 0) return;

    this.gpuCommitReady = false;
    void setFrameDelay(1)
      .then(() => this.options.engine.context3D.device.queue.onSubmittedWorkDone())
      .catch(() => undefined)
      .then(() => { if (!this.disposed) this.gpuCommitReady = true; });
  }

  /**
   * 按 Cesium 的 5ms 时间片推进高优先级地形状态机。
   * @param selectedKeys 当前选择瓦片及祖先键集合。
   */
  private processTerrainLoadQueue(selectedKeys: ReadonlySet<string>): void {
    const pendingTiles = [...this.surfaceTiles.entries()]
      .filter(([key, tile]) => selectedKeys.has(key) && tile.state !== TerrainTileState.Ready)
      .sort(([leftKey, left], [rightKey, right]) => {
        const priorityDifference = Number(selectedKeys.has(rightKey)) - Number(selectedKeys.has(leftKey));
        return priorityDifference !== 0 ? priorityDifference : left.key.level - right.key.level;
      });
    // Cesium 只在本帧存在加载队列时 trim，随后才在同一 5ms 时间片内推进 high/medium/low 加载。
    if (pendingTiles.length > 0) this.trimTileCache();
    const endTime = performance.now() + this.terrainLoadTimeSlice;
    let processed = 0;
    for (const [key, tile] of pendingTiles) {
      if (processed > 0 && performance.now() >= endTime) break;
      processed += 1;
      if (tile.update(this.terrainProvider, 1, 0)) this.enqueueTerrainCommit(key, tile);
    }
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
    const positions = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const webMercatorUvs = new Float32Array(vertexCount * 2);
    const position = new Cartesian3();
    const uv = new Cartesian2();
    for (let index = 0; index < vertexCount; index += 1) {
      terrainMesh.encoding.decodePosition(terrainMesh.vertices, index, position);
      terrainMesh.encoding.decodeTextureCoordinates(terrainMesh.vertices, index, uv);
      positions.set([position.x, position.y, position.z], index * 3);
      uvs.set([uv.x, uv.y], index * 2);
      webMercatorUvs.set([uv.x, terrainMesh.encoding.decodeWebMercatorT(terrainMesh.vertices, index)], index * 2);
    }
    const geometry = new GeometryBase();
    geometry.setAttribute('position', positions);
    geometry.setAttribute('uv', uvs);
    geometry.setAttribute('TEXCOORD_1', webMercatorUvs);
    geometry.setIndices(terrainMesh.indices);
    geometry.addSubGeometry({ indexStart: 0, indexCount: terrainMesh.indices.length, vertexStart: 0, vertexCount, firstStart: 0, index: 0, topology: 0 });
    const object = new Object3D();
    object.name = `Terrain ${coordinate.level}/${coordinate.x}/${coordinate.y}`;
    const renderer = object.addComponent(MeshRenderer);
    renderer.geometry = geometry;
    renderer.material = this.placeholderMaterial;
    renderer.enable = false;
    return object;
  }

  /**
   * 推进 GlobeSurfaceTile → TileImagery → Imagery，并只对最终完成的纹理排入材质提交。
   * @param selectedKeys 当前选择瓦片及祖先键集合。
   */
  private processImageryStateMachines(selectedKeys: ReadonlySet<string>): void {
    for (const key of selectedKeys) {
      const surfaceTile = this.surfaceTiles.get(key);
      if (!surfaceTile || surfaceTile.state !== TerrainTileState.Ready) continue;
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
      const textures: CesiumGlobeTileTexture[] = imagery.processStateMachine();
      if (!imagery.isReadyForCommit || textures.length === 0 || !this.tiles.has(key)) continue;
      if (this.imageryMaterialRevision.get(key) === imagery.revision || this.queuedMaterialCommits.has(key)) continue;
      this.enqueueMaterialCommit(key, imagery, textures);
    }
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
      const renderer = object.getComponent(MeshRenderer);
      const previous = renderer.material;
      if (previous instanceof CesiumGlobeTileMaterial) previous.updateImagery(textures);
      else renderer.material = this.acquireTileMaterial(textures);
      this.imageryMaterialRevision.set(key, revision);
    }).catch(() => { this.queuedMaterialCommits.delete(key); });
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

  /**
   * 收集选择叶瓦片和所有祖先，作为 Cesium 高优先级加载队列。
   * @param selected 当前四叉树选择结果。
   * @returns 瓦片键集合。
   */
  private collectSelectedAndAncestors(selected: GlobeTileCoordinate[]): Set<string> {
    const keys = new Set<string>();
    for (const selectedTile of selected) {
      let current = selectedTile;
      while (true) {
        keys.add(this.tileKey(current));
        if (current.level === 0) break;
        current = { x: Math.floor(current.x / 2), y: Math.floor(current.y / 2), level: current.level - 1 };
      }
    }
    return keys;
  }

  /** 依据已选择叶瓦片进行完整子树就绪检查和父级回退显示。 */
  private applySelection(selected: GlobeTileCoordinate[]): void {
    const selectedKeys = new Set(selected.map(tile => this.tileKey(tile)));
    const renderKeys = new Set<string>();
    const rootsX = this.terrainProvider.tilingScheme.getNumberOfXTilesAtLevel(0);
    const rootsY = this.terrainProvider.tilingScheme.getNumberOfYTilesAtLevel(0);
    for (let y = 0; y < rootsY; y += 1) for (let x = 0; x < rootsX; x += 1) this.resolveRenderableSubtree({ x, y, level: 0 }, selectedKeys)?.forEach(key => renderKeys.add(key));
    for (const [key, object] of this.tiles) object.getComponent(MeshRenderer).enable = renderKeys.has(key);
  }

  /** 递归决定当前子树显示完整子瓦片组还是最近就绪祖先。 */
  private resolveRenderableSubtree(tile: GlobeTileCoordinate, selectedKeys: ReadonlySet<string>): string[] | null {
    const key = this.tileKey(tile);
    if (selectedKeys.has(key)) return this.isRenderable(key) ? [key] : null;
    const level = tile.level + 1;
    const children = [{ x: tile.x * 2, y: tile.y * 2, level }, { x: tile.x * 2 + 1, y: tile.y * 2, level }, { x: tile.x * 2, y: tile.y * 2 + 1, level }, { x: tile.x * 2 + 1, y: tile.y * 2 + 1, level }];
    const requested = children.filter(child => this.hasSelectedDescendant(child, selectedKeys));
    if (requested.length === 0) return [];
    const result = requested.map(child => this.resolveRenderableSubtree(child, selectedKeys));
    if (result.some(value => value === null)) return this.isRenderable(key) ? [key] : null;
    return result.flatMap(value => value ?? []);
  }

  /** 判断一个子树中是否存在选中的叶瓦片。 */
  private hasSelectedDescendant(tile: GlobeTileCoordinate, selectedKeys: ReadonlySet<string>): boolean {
    for (const key of selectedKeys) {
      const [levelText, xText, yText] = key.split('/');
      const level = Number(levelText);
      if (level < tile.level) continue;
      const scale = 2 ** (level - tile.level);
      if (Math.floor(Number(xText) / scale) === tile.x && Math.floor(Number(yText) / scale) === tile.y) return true;
    }
    return false;
  }

  /** 地形实体和最终影像材质都提交后才允许显示。 */
  private isRenderable(key: string): boolean {
    return this.surfaceTiles.get(key)?.state === TerrainTileState.Ready && this.tiles.has(key) && this.imageryMaterialRevision.has(key);
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
      const object = this.tiles.get(key);
      this.tiles.delete(key);
      const imagery = this.surfaceImagery.get(key);
      this.surfaceImagery.delete(key);
      this.imageryMaterialRevision.delete(key);
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

  /** 从内部瓦片键恢复坐标。 */
  private parseTileKey(key: string): GlobeTileCoordinate {
    const [level, x, y] = key.split('/').map(Number);
    return { x, y, level };
  }
}
