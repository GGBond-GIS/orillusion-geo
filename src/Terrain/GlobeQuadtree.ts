import { BoundingSphere, Cartesian3, Cartographic, Rectangle, type TerrainProvider, type TilingScheme } from '@cesium/engine';
// @ts-expect-error Cesium 将 Globe 使用的 EllipsoidalOccluder 保留在 Source 内部，运行时代码随 engine 包发布。
import EllipsoidalOccluder from '@cesium/engine/Source/Core/EllipsoidalOccluder.js';
import type { Camera3D } from '@orillusion/core';
import type { TerrainTileKey } from './TerrainTileState.js';

/** 与 Cesium Intersect 一致的球体-平面求交结果。 */
const Intersect = { OUTSIDE: -1, INTERSECTING: 0, INSIDE: 1 } as const;

/** 与 Cesium Visibility 一致的瓦片可见性。 */
const Visibility = { NONE: 0, PARTIAL: 1, FULL: 2 } as const;

/**
 * 瓦片键的整数编码（消灭遍历热路径的字符串 key 分配，GC 压力源之一）：
 * key = level * 2^36 + x * 2^18 + y。
 * maximumLevel=17 时 x/y ≤ 2^17-1 < 2^18，level ≤ 17 < 2^5，level 段最大 17*2^36 ≈ 2^40.1 < 2^53，安全。
 */
const KEY_LEVEL_MULT = 0x4000000000; // 2^36
const KEY_X_MULT = 0x40000;          // 2^18
const KEY_COORD_MASK = 0x3ffff;      // 2^18 - 1

/** level/x/y → 整数瓦片键。 */
function keyOf(level: number, x: number, y: number): number {
  return level * KEY_LEVEL_MULT + x * KEY_X_MULT + y;
}

/** 整数瓦片键 → level。 */
function levelOf(key: number): number {
  return Math.floor(key / KEY_LEVEL_MULT);
}

/** 整数瓦片键 → x。 */
function xOf(key: number): number {
  return Math.floor(key / KEY_X_MULT) & KEY_COORD_MASK;
}

/** 整数瓦片键 → y。 */
function yOf(key: number): number {
  return key & KEY_COORD_MASK;
}

/** 一个视锥平面：ax + by + cz + d = 0。 */
interface FrustumPlane {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Known terrain-height interval inherited from the nearest ready ancestor. */
export interface TerrainHeightRange {
  minimumHeight: number;
  maximumHeight: number;
}

/** Globe 提供的瓦片状态访问器，对应 Cesium QuadtreeTile / GlobeSurfaceTile 的只读面。 */
export interface GlobeTileAccessor {
  /** 对齐 Cesium tile.renderable：地形网格与影像都就绪，本帧可真实绘制。 */
  isFullyRenderable(key: number): boolean;
  /** Legacy Cesium selector hook retained for accessor compatibility. */
  isCompletelyLoaded(key: number): boolean;
  /** Legacy Cesium selector hook retained for accessor compatibility. */
  canRenderWithoutLosingDetail(key: number): boolean;
  /** 对齐 Cesium tile.needsLoading：该瓦片还需要加载。 */
  needsLoading(key: number): boolean;
  /** 对齐 Cesium surfaceTile.terrainData !== undefined。 */
  hasTerrainData(key: number): boolean;
  /** 对齐 Cesium tile.upsampledFromParent：地形上采样且影像全部失败。 */
  isUpsampledFromParent(key: number): boolean;
  /** 对齐 Cesium tileBoundingRegion.boundingVolume：真实地形包围体，未就绪回退父级，再无则 undefined。 */
  getBoundingVolume(key: number): BoundingSphere | undefined;
  /** Height interval from this tile when it already has a decoded terrain mesh. */
  getHeightRange(key: number): TerrainHeightRange | undefined;
}

/** GlobeQuadtree 选择参数，对齐 Cesium QuadtreePrimitive / Globe / Scene.fog。 */
export interface GlobeQuadtreeOptions {
  /** Cesium 地形提供器。 */
  terrainProvider: TerrainProvider;
  /** Orillusion 相机。 */
  camera: Camera3D;
  /** 与 Cesium QuadtreePrimitive 对齐的最大屏幕空间误差（像素），默认 2。 */
  maximumScreenSpaceError?: number;
  /** 可选择的最大层级。 */
  maximumLevel?: number;
  /** 对齐 Cesium QuadtreePrimitive.loadingDescendantLimit，默认 20。 */
  loadingDescendantLimit?: number;
  /** 对齐 Cesium Globe.preloadAncestors，默认 true。 */
  preloadAncestors?: boolean;
  /** 对齐 Cesium Globe.preloadSiblings，默认 false。 */
  preloadSiblings?: boolean;
  /** 对齐 Cesium Scene.fog.density，默认 0.0006。 */
  fogDensity?: number;
  /** 对齐 Cesium Scene.fog.screenSpaceErrorFactor，默认 2.0。 */
  fogSse?: number;
  /** 对齐 Cesium Scene.fog.maxHeight：相机高于该高度时雾失效，默认 800km。 */
  fogMaxHeight?: number;
  /** 对齐 Cesium Scene.fog.heightScalar，默认 0.001。 */
  fogHeightScalar?: number;
  /** 对齐 Cesium Scene.fog.heightFalloff，默认 0.59。 */
  fogHeightFalloff?: number;
}

/** 单帧遍历结果，对齐 Cesium _tilesToRender 与三级加载队列。 */
export interface GlobeTraversalResult {
  /** 本帧渲染列表（整数瓦片键，可能包含尚未就绪的瓦片，由 Globe 回退到最近可渲染祖先）。 */
  renderList: number[];
  /** 高优先级加载队列：阻止细化的瓦片。 */
  loadQueueHigh: number[];
  /** 中优先级加载队列：可渲染但需要加载、后代超限后提升的父瓦片、相机所在瓦片。 */
  loadQueueMedium: number[];
  /** 低优先级加载队列：preloadAncestors / preloadSiblings。 */
  loadQueueLow: number[];
  /** 本帧访问过的所有瓦片键（含剔除），用于 replacement queue 保活。 */
  touchedKeys: Set<number>;
  /** 相机所在、仅需加载地形的瓦片（CULLED_BUT_NEEDED）。 */
  culledButNeededKeys: Set<number>;
}

/**
 * 3d-tiles-renderer traversal state 的地形四叉树适配。
 * active 表示本帧 REPLACE 前沿，visible 表示 active 且资源已可绘制。
 */
interface TraversalTileState {
  key: number;
  lastFrameVisited: number;
  used: boolean;
  usedLastFrame: boolean;
  active: boolean;
  wasActive: boolean;
  visible: boolean;
  wasVisible: boolean;
  inFrustum: boolean;
  isLeaf: boolean;
  refined: boolean;
  wasRefined: boolean;
  allChildrenReady: boolean;
  allChildrenLoaded: boolean;
  kicked: boolean;
  distance: number;
  error: number;
  priority: number;
  rectangle: Rectangle | null;
  syntheticVolume: BoundingSphere | null;
  syntheticMinimumHeight: number;
  syntheticMaximumHeight: number;
}

/**
 * 每帧 accessor 结果缓存：一次遍历内同一瓦片的 accessor 调用多达 5-7 次
 * （可见性、SSE、加载优先级、allAreUpsampled、canRefine、渲染判定），
 * 其中 getBoundingVolume 需要沿父链回溯。对齐 Cesium 把状态缓存在 QuadtreeTile 上、
 * 每帧只计算一次的做法。
 */
interface AccessorCacheEntry {
  frame: number;
  fullyRenderable: boolean;
  needsLoading: boolean;
  hasTerrainData: boolean;
  upsampled: boolean;
  volume: BoundingSphere | undefined;
  heightRange: TerrainHeightRange | undefined;
}

/** 单帧遍历上下文。 */
interface TraversalContext {
  frameNumber: number;
  accessor: GlobeTileAccessor;
  renderList: number[];
  loadQueueHigh: number[];
  loadQueueMedium: number[];
  loadQueueLow: number[];
  touchedKeys: Set<number>;
  culledButNeededKeys: Set<number>;
  queuedLoads: Set<number>;
}

const scratchTileDirection = new Cartesian3();
const scratchCenter = new Cartesian3();
const scratchCenter2 = new Cartesian3();
const scratchNormal = new Cartesian3();
const scratchNearCenter = new Cartesian3();
const scratchFarCenter = new Cartesian3();
const scratchRight = new Cartesian3();
const scratchCartographic = new Cartographic();
const scratchFogNormal = new Cartesian3();
const EPSILON5 = 1e-5;

/**
 * 从 Cesium QuadtreePrimitive.selectTilesForRendering 移植的瓦片选择器。
 * 完整保留 Cesium 的遍历语义：
 *  - 视锥剔除（PerspectiveOffCenterFrustum.computeCullingVolume 的平面构建）+ 椭球地平线剔除 + 雾剔除；
 *  - SSE 优先的深度优先遍历，子瓦片按相机所在象限 near-to-far 访问；
 *  - KICK 语义：未就绪的后代被踢出渲染列表并标记 RENDERED_AND_KICKED，父瓦片顶替渲染，
 *    上一帧渲染过的瓦片本帧保持可渲染，禁止细节消失；
 *  - loadingDescendantLimit：等待后代过多时停止加载后代，转而加载父瓦片（medium）；
 *  - 三级加载队列（high/medium/low），按 computeTileLoadPriority（屏幕中心角 + 距离）排序；
 *  - 真实地形包围体（accessor.getBoundingVolume）驱动 SSE 距离、剔除与优先级；
 *  - 雾（CesiumMath.fog）降低远处瓦片的 SSE，行为与 Scene.fog 默认值一致。
 */
export class GlobeQuadtree {
  /** 最大屏幕空间误差，单位为像素。 */
  public maximumScreenSpaceError: number;
  /** 最大细化层级。 */
  public maximumLevel: number;
  /** 对齐 Cesium loadingDescendantLimit。 */
  public loadingDescendantLimit: number;
  /** 对齐 Cesium Globe.preloadAncestors。 */
  public preloadAncestors: boolean;
  /** 对齐 Cesium Globe.preloadSiblings。 */
  public preloadSiblings: boolean;
  private readonly terrainProvider: TerrainProvider;
  private readonly camera: Camera3D;
  private readonly tilingScheme: TilingScheme;
  private readonly occluder: EllipsoidalOccluder;
  private readonly fogDensity: number;
  private readonly fogSse: number;
  private readonly fogMaxHeight: number;
  private readonly fogHeightScalar: number;
  private readonly fogHeightFalloff: number;
  /** 本帧有效雾密度（对齐 Cesium Fog.update：按相机高度与朝向调制，太空/俯视时为 0）。 */
  private frameFogDensity = 0;
  /** 每帧遍历调试计数（诊断用）。 */
  public readonly debugCounts = { visited: 0, fog: 0, frustum: 0, horizon: 0, rendered: 0, refined: 0 };

  private readonly states = new Map<number, TraversalTileState>();
  private readonly accessorCache = new Map<number, AccessorCacheEntry>();
  private readonly maximumCachedStates = 16_384;
  private cameraPosition = new Cartesian3();
  private cameraDirection = new Cartesian3();
  private cameraUp = new Cartesian3();
  private cameraCartographic = new Cartographic();
  private frustumPlanes: FrustumPlane[] = [];
  private drawingBufferHeight = 1;
  private pixelRatio = 1;

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
    this.loadingDescendantLimit = options.loadingDescendantLimit ?? 20;
    this.preloadAncestors = options.preloadAncestors ?? true;
    this.preloadSiblings = options.preloadSiblings ?? false;
    this.fogDensity = options.fogDensity ?? 0.0006;
    this.fogSse = options.fogSse ?? 2.0;
    this.fogMaxHeight = options.fogMaxHeight ?? 800_000.0;
    this.fogHeightScalar = options.fogHeightScalar ?? 0.001;
    this.fogHeightFalloff = options.fogHeightFalloff ?? 0.59;
  }

  /**
   * 为当前相机执行一次 Cesium 风格的选择遍历。
   * @param frameNumber 当前帧号（Globe 递增后传入）。
   * @param accessor Globe 提供的瓦片状态访问器。
   * @returns 渲染列表、三级加载队列与本帧访问过的瓦片。
   */
  public select(frameNumber: number, accessor: GlobeTileAccessor): GlobeTraversalResult {
    const ctx: TraversalContext = {
      frameNumber,
      accessor,
      renderList: [],
      loadQueueHigh: [],
      loadQueueMedium: [],
      loadQueueLow: [],
      touchedKeys: new Set<number>(),
      culledButNeededKeys: new Set<number>(),
      queuedLoads: new Set<number>(),
    };
    this.updateFrameContext();
    this.debugCounts.visited = 0;
    this.debugCounts.fog = 0;
    this.debugCounts.frustum = 0;
    this.debugCounts.horizon = 0;
    this.debugCounts.rendered = 0;
    this.debugCounts.refined = 0;

    // 与 Cesium 一致：level zero 瓦片按与相机的距离排序后逐个遍历。
    const roots = this.levelZeroTiles();
    roots.sort((a, b) => {
      const centerA = this.tilingScheme.ellipsoid.cartographicToCartesian(this.rectangleCenter(a), scratchCenter);
      const centerB = this.tilingScheme.ellipsoid.cartographicToCartesian(this.rectangleCenter(b), scratchCenter2);
      return Cartesian3.distance(this.cameraPosition, centerA) - Cartesian3.distance(this.cameraPosition, centerB);
    });

    // 3d-tiles-renderer runTraversal 的四段语义：
    // markUsedTiles -> markUsedSetLeaves -> markVisibleTiles -> toggle/collectTiles。
    // 多个 level-zero 根节点等价于一个无内容的虚拟根，因此逐根执行前三段，最后统一收集。
    for (const root of roots) this.markUsedTiles(root, ctx);
    for (const root of roots) this.markUsedSetLeaves(root, ctx);
    for (const root of roots) this.markVisibleTiles(root, ctx);
    for (const root of roots) this.collectTiles(root, ctx);

    // 对齐 Cesium processTileLoadQueue：队列按加载优先级排序（低值先加载）。
    ctx.loadQueueHigh.sort((a, b) => this.stateOf(a).priority - this.stateOf(b).priority);
    ctx.loadQueueMedium.sort((a, b) => this.stateOf(a).priority - this.stateOf(b).priority);
    ctx.loadQueueLow.sort((a, b) => this.stateOf(a).priority - this.stateOf(b).priority);
    this.sweepCache(ctx.touchedKeys);

    return {
      renderList: ctx.renderList,
      loadQueueHigh: ctx.loadQueueHigh,
      loadQueueMedium: ctx.loadQueueMedium,
      loadQueueLow: ctx.loadQueueLow,
      touchedKeys: ctx.touchedKeys,
      culledButNeededKeys: ctx.culledButNeededKeys,
    };
  }

  /**
   * 查询某瓦片上一帧是否被渲染（RENDERED 或 RENDERED_AND_KICKED）。
   * 供 Globe 实现 canRenderWithoutLosingDetail 的后代检查使用。
   */
  public wasRenderedLastFrame(key: number, frameNumber: number): boolean {
    const state = this.states.get(key);
    if (!state) return false;
    if (state.lastFrameVisited === frameNumber) return state.wasActive;
    return state.lastFrameVisited === frameNumber - 1 && state.active;
  }

  /**
   * 查询某瓦片上一帧是否被细化（REFINED 或 REFINED_AND_KICKED）。
   * 供 Globe 实现 canRenderWithoutLosingDetail 的后代遍历使用。
   */
  public wasRefinedLastFrame(key: number, frameNumber: number): boolean {
    const state = this.states.get(key);
    if (!state) return false;
    if (state.lastFrameVisited === frameNumber) return state.wasRefined;
    return state.lastFrameVisited === frameNumber - 1 && state.refined;
  }

  /** 取父瓦片键，根瓦片返回 -1。 */
  public parentKeyOf(key: number): number {
    const level = levelOf(key);
    if (level === 0) return -1;
    return keyOf(level - 1, Math.floor(xOf(key) / 2), Math.floor(yOf(key) / 2));
  }

  /** 整数瓦片键 → 坐标（供 Globe 等消费遍历结果）。 */
  public decodeKey(key: number): TerrainTileKey {
    return { level: levelOf(key), x: xOf(key), y: yOf(key) };
  }

  /** level/x/y → 整数瓦片键（供 Globe 等生成遍历键）。 */
  public keyOf(level: number, x: number, y: number): number {
    return keyOf(level, x, y);
  }

  /** 供 Globe 在瓦片被淘汰时清理四叉树缓存。 */
  public invalidate(key: number): void {
    this.states.delete(key);
    this.accessorCache.delete(key);
  }

  /** 3d-tiles-renderer markUsedTiles：按视锥与 SSE 构建本帧 used 子树。 */
  private markUsedTiles(key: number, ctx: TraversalContext): void {
    const state = this.resetFrameState(key, ctx);
    if (!state.inFrustum) {
      if (this.containsNeededPosition(key) && this.accessorOf(key, ctx).needsLoading) {
        ctx.culledButNeededKeys.add(state.key);
        this.queueTileLoad(ctx, ctx.loadQueueMedium, key, state);
      }
      return;
    }

    if (!this.canTraverse(key, state, ctx)) {
      state.used = true;
      return;
    }

    // 四个子瓦片内联展开（避免每瓦片分配 children 数组与 4 个坐标对象）。
    const level = levelOf(key);
    const x = xOf(key);
    const y = yOf(key);
    const childLevel = level + 1;
    const childX = x * 2;
    const childY = y * 2;
    const c0 = keyOf(childLevel, childX, childY);
    const c1 = keyOf(childLevel, childX + 1, childY);
    const c2 = keyOf(childLevel, childX, childY + 1);
    const c3 = keyOf(childLevel, childX + 1, childY + 1);
    let anyChildrenUsed = false;
    let anyChildrenInFrustum = false;
    this.markUsedTiles(c0, ctx);
    let childState = this.ensureState(c0);
    anyChildrenUsed ||= childState.lastFrameVisited === ctx.frameNumber && childState.used;
    anyChildrenInFrustum ||= childState.lastFrameVisited === ctx.frameNumber && childState.inFrustum;
    this.markUsedTiles(c1, ctx);
    childState = this.ensureState(c1);
    anyChildrenUsed ||= childState.lastFrameVisited === ctx.frameNumber && childState.used;
    anyChildrenInFrustum ||= childState.lastFrameVisited === ctx.frameNumber && childState.inFrustum;
    this.markUsedTiles(c2, ctx);
    childState = this.ensureState(c2);
    anyChildrenUsed ||= childState.lastFrameVisited === ctx.frameNumber && childState.used;
    anyChildrenInFrustum ||= childState.lastFrameVisited === ctx.frameNumber && childState.inFrustum;
    this.markUsedTiles(c3, ctx);
    childState = this.ensureState(c3);
    anyChildrenUsed ||= childState.lastFrameVisited === ctx.frameNumber && childState.used;
    anyChildrenInFrustum ||= childState.lastFrameVisited === ctx.frameNumber && childState.inFrustum;

    if (!anyChildrenInFrustum) {
      state.inFrustum = false;
      ctx.touchedKeys.add(c0);
      ctx.touchedKeys.add(c1);
      ctx.touchedKeys.add(c2);
      ctx.touchedKeys.add(c3);
      return;
    }

    state.used = true;
    state.refined = anyChildrenUsed;
    if (state.refined) this.debugCounts.refined += 1;
    if (anyChildrenUsed && (this.preloadAncestors || this.preloadSiblings)) {
      // Match 3d-tiles-renderer exactly: loadAncestors implicitly enables the four siblings.
      // This prevents a newly visible sibling from forcing its whole parent active for 1-2
      // frames during lateral camera movement. Tile-local synthetic bounds keep this bounded.
      this.recursivelyMarkUsed(c0, ctx);
      this.recursivelyMarkUsed(c1, ctx);
      this.recursivelyMarkUsed(c2, ctx);
      this.recursivelyMarkUsed(c3, ctx);
    }
  }

  /** Mark a sibling fallback tile as used without forcing deeper refinement. */
  private recursivelyMarkUsed(key: number, ctx: TraversalContext): void {
    this.resetFrameState(key, ctx).used = true;
  }

  /** 3d-tiles-renderer markUsedSetLeaves：自底向上计算叶节点和子内容就绪状态。 */
  private markUsedSetLeaves(key: number, ctx: TraversalContext): void {
    const state = this.ensureState(key);
    if (state.lastFrameVisited !== ctx.frameNumber || !state.used) return;

    const level = levelOf(key);
    const x = xOf(key);
    const y = yOf(key);
    const childLevel = level + 1;
    const childX = x * 2;
    const childY = y * 2;
    const c0 = keyOf(childLevel, childX, childY);
    const c1 = keyOf(childLevel, childX + 1, childY);
    const c2 = keyOf(childLevel, childX, childY + 1);
    const c3 = keyOf(childLevel, childX + 1, childY + 1);
    const s0 = this.ensureState(c0);
    const s1 = this.ensureState(c1);
    const s2 = this.ensureState(c2);
    const s3 = this.ensureState(c3);
    const used0 = s0.lastFrameVisited === ctx.frameNumber && s0.used;
    const used1 = s1.lastFrameVisited === ctx.frameNumber && s1.used;
    const used2 = s2.lastFrameVisited === ctx.frameNumber && s2.used;
    const used3 = s3.lastFrameVisited === ctx.frameNumber && s3.used;
    if (!used0 && !used1 && !used2 && !used3) {
      state.isLeaf = true;
      return;
    }

    let allChildrenLoaded = true;
    if (used0) {
      this.markUsedSetLeaves(c0, ctx);
      // loadAncestors marks all four siblings as used for prefetching. Unlike a 3D Tiles content
      // tree, globe siblings can cover a large off-screen or polar region whose imagery may never
      // become renderable. Keep preloading it, but do not let it gate replacement of the visible
      // part of this parent.
      if (this.ensureState(c0).inFrustum) {
        allChildrenLoaded &&= this.accessorOf(c0, ctx).fullyRenderable || this.ensureState(c0).allChildrenLoaded;
      }
    }
    if (used1) {
      this.markUsedSetLeaves(c1, ctx);
      if (this.ensureState(c1).inFrustum) {
        allChildrenLoaded &&= this.accessorOf(c1, ctx).fullyRenderable || this.ensureState(c1).allChildrenLoaded;
      }
    }
    if (used2) {
      this.markUsedSetLeaves(c2, ctx);
      if (this.ensureState(c2).inFrustum) {
        allChildrenLoaded &&= this.accessorOf(c2, ctx).fullyRenderable || this.ensureState(c2).allChildrenLoaded;
      }
    }
    if (used3) {
      this.markUsedSetLeaves(c3, ctx);
      if (this.ensureState(c3).inFrustum) {
        allChildrenLoaded &&= this.accessorOf(c3, ctx).fullyRenderable || this.ensureState(c3).allChildrenLoaded;
      }
    }
    state.allChildrenLoaded = allChildrenLoaded;
  }

  /** 3d-tiles-renderer markVisibleTiles：REPLACE 父级保持 active，直到全部 used 子级可显示。 */
  private markVisibleTiles(key: number, ctx: TraversalContext): void {
    const state = this.ensureState(key);
    if (state.lastFrameVisited !== ctx.frameNumber || !state.used) return;

    // loadAncestors may hold a parent while its first child frontier is loading. Once this
    // branch was already refined last frame, never demote it merely because a newly visible
    // sibling is still loading; keep the ready descendants active. A genuine zoom-out still
    // stops in markUsedTiles and reaches the normal isLeaf path above.
    if (this.preloadAncestors && state.refined && !state.allChildrenLoaded && !state.wasRefined) {
      state.isLeaf = true;
    }
    if (state.isLeaf) {
      state.active = true;
      return;
    }

    const level = levelOf(key);
    const x = xOf(key);
    const y = yOf(key);
    const childLevel = level + 1;
    const childX = x * 2;
    const childY = y * 2;
    const c0 = keyOf(childLevel, childX, childY);
    const c1 = keyOf(childLevel, childX + 1, childY);
    const c2 = keyOf(childLevel, childX, childY + 1);
    const c3 = keyOf(childLevel, childX + 1, childY + 1);
    let allChildrenReady = true;
    let childState = this.ensureState(c0);
    if (childState.lastFrameVisited === ctx.frameNumber && childState.used) {
      this.markVisibleTiles(c0, ctx);
      childState = this.ensureState(c0);
      if (childState.inFrustum) {
        const childReady = childState.active && this.accessorOf(c0, ctx).fullyRenderable;
        if (!childReady && !childState.allChildrenReady) allChildrenReady = false;
      }
    }
    childState = this.ensureState(c1);
    if (childState.lastFrameVisited === ctx.frameNumber && childState.used) {
      this.markVisibleTiles(c1, ctx);
      childState = this.ensureState(c1);
      if (childState.inFrustum) {
        const childReady = childState.active && this.accessorOf(c1, ctx).fullyRenderable;
        if (!childReady && !childState.allChildrenReady) allChildrenReady = false;
      }
    }
    childState = this.ensureState(c2);
    if (childState.lastFrameVisited === ctx.frameNumber && childState.used) {
      this.markVisibleTiles(c2, ctx);
      childState = this.ensureState(c2);
      if (childState.inFrustum) {
        const childReady = childState.active && this.accessorOf(c2, ctx).fullyRenderable;
        if (!childReady && !childState.allChildrenReady) allChildrenReady = false;
      }
    }
    childState = this.ensureState(c3);
    if (childState.lastFrameVisited === ctx.frameNumber && childState.used) {
      this.markVisibleTiles(c3, ctx);
      childState = this.ensureState(c3);
      if (childState.inFrustum) {
        const childReady = childState.active && this.accessorOf(c3, ctx).fullyRenderable;
        if (!childReady && !childState.allChildrenReady) allChildrenReady = false;
      }
    }
    state.allChildrenReady = allChildrenReady;

    if (!allChildrenReady && state.wasActive && this.accessorOf(key, ctx).fullyRenderable) {
      state.active = true;
      this.kickActiveChildren(key, ctx);
    }
  }

  /** Keep descendants loaded while removing them from the REPLACE display frontier. */
  private kickActiveChildren(key: number, ctx: TraversalContext): void {
    const level = levelOf(key);
    const x = xOf(key);
    const y = yOf(key);
    const childLevel = level + 1;
    const childX = x * 2;
    const childY = y * 2;
    const c0 = keyOf(childLevel, childX, childY);
    const c1 = keyOf(childLevel, childX + 1, childY);
    const c2 = keyOf(childLevel, childX, childY + 1);
    const c3 = keyOf(childLevel, childX + 1, childY + 1);
    let childState = this.ensureState(c0);
    if (childState.lastFrameVisited === ctx.frameNumber && childState.used) {
      if (childState.active) {
        childState.active = false;
        childState.kicked = true;
      }
      this.kickActiveChildren(c0, ctx);
    }
    childState = this.ensureState(c1);
    if (childState.lastFrameVisited === ctx.frameNumber && childState.used) {
      if (childState.active) {
        childState.active = false;
        childState.kicked = true;
      }
      this.kickActiveChildren(c1, ctx);
    }
    childState = this.ensureState(c2);
    if (childState.lastFrameVisited === ctx.frameNumber && childState.used) {
      if (childState.active) {
        childState.active = false;
        childState.kicked = true;
      }
      this.kickActiveChildren(c2, ctx);
    }
    childState = this.ensureState(c3);
    if (childState.lastFrameVisited === ctx.frameNumber && childState.used) {
      if (childState.active) {
        childState.active = false;
        childState.kicked = true;
      }
      this.kickActiveChildren(c3, ctx);
    }
  }

  /** 3d-tiles-renderer toggleTiles 的无渲染器适配：生成 renderList 与加载优先级。 */
  private collectTiles(key: number, ctx: TraversalContext): void {
    const state = this.ensureState(key);
    if (state.lastFrameVisited !== ctx.frameNumber || !state.used) return;

    ctx.touchedKeys.add(state.key);
    const accessor = this.accessorOf(key, ctx);
    const activeInFrustum = state.active && state.inFrustum;
    state.visible = activeInFrustum && accessor.fullyRenderable;
    // Keep unloaded active leaves in the selected frontier. Globe.applySelection resolves
    // them to the nearest renderable ancestor, so a pending mesh/material cannot expose the
    // clear color as a rectangular hole.
    if (activeInFrustum) this.addTileToRenderList(ctx, key);

    if (accessor.needsLoading) {
      if (state.active || state.kicked) this.queueTileLoad(ctx, ctx.loadQueueHigh, key, state);
      else if (state.inFrustum) this.queueTileLoad(ctx, ctx.loadQueueMedium, key, state);
      else this.queueTileLoad(ctx, ctx.loadQueueLow, key, state);
    }
    const level = levelOf(key);
    const x = xOf(key);
    const y = yOf(key);
    const childLevel = level + 1;
    const childX = x * 2;
    const childY = y * 2;
    this.collectTiles(keyOf(childLevel, childX, childY), ctx);
    this.collectTiles(keyOf(childLevel, childX + 1, childY), ctx);
    this.collectTiles(keyOf(childLevel, childX, childY + 1), ctx);
    this.collectTiles(keyOf(childLevel, childX + 1, childY + 1), ctx);
  }

  /** Reset persistent traversal state exactly once per frame and calculate view error. */
  private resetFrameState(key: number, ctx: TraversalContext): TraversalTileState {
    const state = this.ensureState(key);
    if (state.lastFrameVisited === ctx.frameNumber) return state;
    state.wasActive = state.active;
    state.wasVisible = state.visible;
    state.usedLastFrame = state.used;
    state.wasRefined = state.refined;
    state.lastFrameVisited = ctx.frameNumber;
    state.used = false;
    state.active = false;
    state.visible = false;
    state.inFrustum = this.computeTileVisibility(key, ctx) !== Visibility.NONE;
    state.isLeaf = false;
    state.refined = false;
    state.allChildrenReady = false;
    state.allChildrenLoaded = false;
    state.kicked = false;
    state.error = this.screenSpaceError(levelOf(key), state);
    ctx.touchedKeys.add(state.key);
    this.debugCounts.visited += 1;
    return state;
  }

  private canTraverse(key: number, state: TraversalTileState, ctx: TraversalContext): boolean {
    return state.error > this.maximumScreenSpaceError && this.canRefine(key, ctx);
  }

  /** 取得或计算瓦片矩形（缓存于瓦片状态，避免每帧多次分配 Cesium Rectangle）。 */
  private rectangleOf(key: number): Rectangle {
    const state = this.ensureState(key);
    if (!state.rectangle) {
      state.rectangle = this.tilingScheme.tileXYToRectangle(xOf(key), yOf(key), levelOf(key));
    }
    return state.rectangle;
  }

  /**
   * 取得或创建瓦片本帧的 accessor 结果缓存（每帧每瓦片只计算一次）。
   */
  private accessorOf(key: number, ctx: TraversalContext): AccessorCacheEntry {
    const cached = this.accessorCache.get(key);
    if (cached && cached.frame === ctx.frameNumber) {
      return cached;
    }
    const level = levelOf(key);
    const ownHeightRange = ctx.accessor.getHeightRange(key);
    const inheritedHeightRange = ownHeightRange ?? (level > 0
      ? this.accessorOf(keyOf(level - 1, Math.floor(xOf(key) / 2), Math.floor(yOf(key) / 2)), ctx).heightRange
      : undefined);
    const state = this.ensureState(key);
    const volume = ctx.accessor.getBoundingVolume(key) ?? this.createConservativeBoundingVolume(
      key,
      inheritedHeightRange,
      state,
    );
    const entry = cached ?? {
      frame: -1,
      fullyRenderable: false,
      needsLoading: true,
      hasTerrainData: false,
      upsampled: false,
      heightRange: undefined,
      volume: undefined,
    };
    entry.frame = ctx.frameNumber;
    entry.fullyRenderable = ctx.accessor.isFullyRenderable(key);
    entry.needsLoading = ctx.accessor.needsLoading(key);
    entry.hasTerrainData = ctx.accessor.hasTerrainData(key);
    entry.upsampled = ctx.accessor.isUpsampledFromParent(key);
    entry.heightRange = inheritedHeightRange;
    entry.volume = volume;
    if (!cached) this.accessorCache.set(key, entry);
    return entry;
  }

  /** Build a local pre-load volume without inheriting the ancestor's much wider footprint. */
  private createConservativeBoundingVolume(
    key: number,
    range: TerrainHeightRange | undefined,
    state: TraversalTileState,
  ): BoundingSphere {
    const geometricError = this.terrainProvider.getLevelMaximumGeometricError(levelOf(key));
    // TerrainMesh min/max describe the full ancestor tile, so every descendant is already
    // enclosed by that interval. Expanding it again by each level's geometric error makes
    // grazing-angle volumes unnecessarily large and causes traversal/load fan-out.
    const minimumHeight = range?.minimumHeight ?? -geometricError;
    const maximumHeight = range?.maximumHeight ?? geometricError;
    if (
      state.syntheticVolume &&
      state.syntheticMinimumHeight === minimumHeight &&
      state.syntheticMaximumHeight === maximumHeight
    ) {
      return state.syntheticVolume;
    }
    const rectangle = this.rectangleOf(key);
    const ellipsoid = this.tilingScheme.ellipsoid;
    const positions = Rectangle.subsample(rectangle, ellipsoid, minimumHeight);
    const upperPositions = Rectangle.subsample(rectangle, ellipsoid, maximumHeight);
    for (const position of upperPositions) positions.push(position);
    state.syntheticVolume = BoundingSphere.fromPoints(positions, state.syntheticVolume ?? undefined);
    state.syntheticMinimumHeight = minimumHeight;
    state.syntheticMaximumHeight = maximumHeight;
    return state.syntheticVolume;
  }

  /**
   * 对齐 Cesium GlobeSurfaceTileProvider.computeTileVisibility：
   * 雾剔除 → 视锥剔除 → 椭球地平线剔除；并缓存本帧瓦片距离。
   */
  private computeTileVisibility(key: number, ctx: TraversalContext): number {
    const state = this.ensureState(key);
    // 对齐 Cesium computeDistanceToTile：包围体来自本瓦片或祖先地形（含高度）；
    // 完全找不到高度数据时使用 9999999999 哨兵距离——SSE 趋近于 0（加载并渲染而不细化），
    // 且会被雾剔除，避免没有包围体时无限细化。
    const cachedAccessor = this.accessorOf(key, ctx);
    state.distance = cachedAccessor.volume
      ? Math.max(0, Cartesian3.distance(this.cameraPosition, cachedAccessor.volume.center) - cachedAccessor.volume.radius)
      : 9_999_999_999.0;

    // 雾剔除（对齐 Cesium computeTileVisibility：使用 Fog.update 调制后的有效密度）。
    if (this.fog(state.distance, this.frameFogDensity) >= 1.0) {
      this.debugCounts.fog += 1;
      return Visibility.NONE;
    }

    // 没有可用包围体（对齐 Cesium boundingVolumeSourceTile === undefined → PARTIAL）。
    if (!cachedAccessor.volume) {
      return Visibility.PARTIAL;
    }

    // 视锥剔除。
    let intersection: number = Intersect.INSIDE;
    const sphere = cachedAccessor.volume;
    for (const plane of this.frustumPlanes) {
      const distance = plane.x * sphere.center.x + plane.y * sphere.center.y + plane.z * sphere.center.z + plane.w;
      if (distance < -sphere.radius) {
        intersection = Intersect.OUTSIDE;
        break;
      }
      if (Math.abs(distance) < sphere.radius) {
        intersection = Intersect.INTERSECTING;
      }
    }
    if (intersection === Intersect.OUTSIDE) {
      this.debugCounts.frustum += 1;
      return Visibility.NONE;
    }

    // 椭球地平线剔除。
    if (!this.isVisibleFromCamera(key)) {
      this.debugCounts.horizon += 1;
      return Visibility.NONE;
    }

    return intersection === Intersect.INSIDE ? Visibility.FULL : Visibility.PARTIAL;
  }

  /**
   * 对齐 Cesium GlobeSurfaceTileProvider.canRefine：
   * 只有「本瓦片已有地形」或「provider 明确告知子瓦片存在（availability）」时才允许细化。
   * 注意：EllipsoidTerrainProvider 等无 availability 的 provider 返回 undefined，
   * 此时 **不允许** 细化到未加载的层级——遍历深度被已加载层级约束，
   * 这正是 Cesium 从太空看椭球地形时不会一次性下钻到 SSE 叶层级的关键限制。
   */
  private canRefine(key: number, ctx: TraversalContext): boolean {
    const level = levelOf(key);
    if (level >= this.maximumLevel) {
      return false;
    }
    if (this.accessorOf(key, ctx).hasTerrainData) {
      return true;
    }
    const childX = xOf(key) * 2;
    const childY = yOf(key) * 2;
    const childAvailable = (this.terrainProvider as { getTileDataAvailable?(x: number, y: number, level: number): boolean | undefined })
      .getTileDataAvailable?.(childX, childY, level + 1);
    return childAvailable !== undefined;
  }

  /** 对齐 Cesium QuadtreePrimitive.queueTileLoad：只入队需要加载的瓦片并计算优先级。 */
  private queueTileLoad(ctx: TraversalContext, queue: number[], key: number, state: TraversalTileState): void {
    if (!this.accessorOf(key, ctx).needsLoading || ctx.queuedLoads.has(state.key)) {
      return;
    }
    ctx.queuedLoads.add(state.key);
    state.priority = this.computeTileLoadPriority(key, state, ctx);
    queue.push(key);
  }

  /** 对齐 Cesium GlobeSurfaceTileProvider.computeTileLoadPriority：(1 - dot(tileDir, cameraDir)) * distance。 */
  private computeTileLoadPriority(key: number, state: TraversalTileState, ctx: TraversalContext): number {
    const sphere = this.accessorOf(key, ctx).volume;
    if (!sphere) {
      return 0;
    }
    Cartesian3.subtract(sphere.center, this.cameraPosition, scratchTileDirection);
    const magnitude = Cartesian3.magnitude(scratchTileDirection);
    if (magnitude < EPSILON5) {
      return 0;
    }
    Cartesian3.divideByScalar(scratchTileDirection, magnitude, scratchTileDirection);
    return (1.0 - Cartesian3.dot(scratchTileDirection, this.cameraDirection)) * state.distance;
  }

  /** 对齐 Cesium QuadtreePrimitive.screenSpaceError：透视 SSE + 雾削减 + pixelRatio 归一。 */
  private screenSpaceError(level: number, state: TraversalTileState): number {
    const maxGeometricError = this.terrainProvider.getLevelMaximumGeometricError(level);
    const distance = Math.max(1, state.distance);
    const sseDenominator = 2 * Math.tan((this.camera.fov * Math.PI / 180) * 0.5);
    let error = (maxGeometricError * this.drawingBufferHeight) / (distance * sseDenominator);
    error -= this.fog(distance, this.frameFogDensity) * this.fogSse;
    error /= this.pixelRatio;
    return error;
  }

  /** 对齐 CesiumMath.fog。 */
  private fog(distance: number, density: number): number {
    const scalar = distance * density;
    return 1.0 - Math.exp(-(scalar * scalar));
  }

  /** 相机位置是否落在瓦片矩形内（对齐 Cesium containsNeededPosition）。 */
  private containsNeededPosition(key: number): boolean {
    const rectangle = this.rectangleOf(key);
    return (
      this.cameraCartographic.longitude >= rectangle.west &&
      this.cameraCartographic.longitude <= rectangle.east &&
      this.cameraCartographic.latitude >= rectangle.south &&
      this.cameraCartographic.latitude <= rectangle.north
    );
  }

  /** 椭球地平线可见性测试，避免细化相机背面的半球。 */
  private isVisibleFromCamera(key: number): boolean {
    if (Cartesian3.magnitude(this.cameraPosition) <= this.tilingScheme.ellipsoid.maximumRadius) return true;
    this.occluder.cameraPosition = this.cameraPosition;
    const rectangle = this.rectangleOf(key);
    const cullingPoint = this.occluder.computeHorizonCullingPointFromRectangle(rectangle, this.tilingScheme.ellipsoid);
    return !cullingPoint || this.occluder.isScaledSpacePointVisible(cullingPoint);
  }

  /** 取瓦片矩形中心经纬度。 */
  private rectangleCenter(key: number): Cartographic {
    const rectangle = this.rectangleOf(key);
    return Cartographic.fromRadians(
      (rectangle.west + rectangle.east) * 0.5,
      (rectangle.south + rectangle.north) * 0.5,
      0,
    );
  }

  /** level zero 瓦片键列表。 */
  private levelZeroTiles(): number[] {
    const roots: number[] = [];
    const rootsX = this.tilingScheme.getNumberOfXTilesAtLevel(0);
    const rootsY = this.tilingScheme.getNumberOfYTilesAtLevel(0);
    for (let y = 0; y < rootsY; y += 1) {
      for (let x = 0; x < rootsX; x += 1) {
        roots.push(keyOf(0, x, y));
      }
    }
    return roots;
  }

  /** 添加瓦片到渲染列表。 */
  private addTileToRenderList(ctx: TraversalContext, key: number): void {
    ctx.renderList.push(key);
    this.debugCounts.rendered += 1;
  }

  /** 每帧刷新相机上下文：位置/朝向/经纬度、视锥平面、绘制高度与像素比。 */
  private updateFrameContext(): void {
    const transform = this.camera.object3D.transform;
    const position = transform.worldPosition;
    const forward = transform.forward;
    const up = transform.up;
    this.cameraPosition.x = position.x;
    this.cameraPosition.y = position.y;
    this.cameraPosition.z = position.z;
    this.cameraDirection.x = forward.x;
    this.cameraDirection.y = forward.y;
    this.cameraDirection.z = forward.z;
    this.cameraUp.x = up.x;
    this.cameraUp.y = up.y;
    this.cameraUp.z = up.z;
    this.cameraCartographic = this.tilingScheme.ellipsoid.cartesianToCartographic(this.cameraPosition, scratchCartographic) ?? scratchCartographic;
    // 对齐 Cesium Fog.update：
    //  - 相机高于 maxHeight（太空）时雾关闭；
    //  - 否则 density = density * heightScalar * pow(max(height / maxHeight, eps), -heightFalloff)；
    //  - 再按相机朝向与径向的夹角淡入：density *= 1 - |dot(cameraDirection, normalize(cameraPosition))|。
    const height = this.cameraCartographic.height;
    if (height > this.fogMaxHeight) {
      this.frameFogDensity = 0;
    } else {
      let density = this.fogDensity * this.fogHeightScalar
        * Math.pow(Math.max(height / this.fogMaxHeight, 1e-4), -Math.max(this.fogHeightFalloff, 0));
      Cartesian3.normalize(this.cameraPosition, scratchFogNormal);
      const dot = Math.abs(Cartesian3.dot(this.cameraDirection, scratchFogNormal));
      density *= 1.0 - dot;
      this.frameFogDensity = density;
    }
    this.frustumPlanes = this.buildFrustumPlanes();
    this.drawingBufferHeight = this.camera._boundCtx?.canvas.height ?? 1;
    this.pixelRatio = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
  }

  /**
   * 对齐 Cesium PerspectiveOffCenterFrustum.computeCullingVolume：
   * 用相机位置/方向/上向量与 fov/aspect/near/far 直接构建 6 个视锥平面（世界系）。
   */
  private buildFrustumPlanes(): FrustumPlane[] {
    const camera = this.camera;
    const fovy = (camera.fov * Math.PI) / 180;
    const aspect = Math.max(0.01, (this.camera._boundCtx?.canvas.width ?? 1) / Math.max(1, this.drawingBufferHeight));
    const near = camera.near;
    const far = camera.far;
    const tangent = Math.tan(fovy * 0.5);
    const top = tangent * near;
    const bottom = -top;
    const right = tangent * aspect * near;
    const left = -right;

    const position = this.cameraPosition;
    const direction = this.cameraDirection;
    const up = this.cameraUp;

    // right = cross(direction, up)
    Cartesian3.cross(direction, up, scratchRight);
    // nearCenter = position + direction * near
    Cartesian3.multiplyByScalar(direction, near, scratchNearCenter);
    Cartesian3.add(position, scratchNearCenter, scratchNearCenter);
    // farCenter = position + direction * far
    Cartesian3.multiplyByScalar(direction, far, scratchFarCenter);
    Cartesian3.add(position, scratchFarCenter, scratchFarCenter);

    const planes: FrustumPlane[] = [];

    // Left plane
    Cartesian3.multiplyByScalar(scratchRight, left, scratchNormal);
    Cartesian3.add(scratchNearCenter, scratchNormal, scratchNormal);
    Cartesian3.subtract(scratchNormal, position, scratchNormal);
    Cartesian3.normalize(scratchNormal, scratchNormal);
    Cartesian3.cross(scratchNormal, up, scratchNormal);
    Cartesian3.normalize(scratchNormal, scratchNormal);
    planes.push(this.makePlane(scratchNormal, position));

    // Right plane
    Cartesian3.multiplyByScalar(scratchRight, right, scratchNormal);
    Cartesian3.add(scratchNearCenter, scratchNormal, scratchNormal);
    Cartesian3.subtract(scratchNormal, position, scratchNormal);
    Cartesian3.cross(up, scratchNormal, scratchNormal);
    Cartesian3.normalize(scratchNormal, scratchNormal);
    planes.push(this.makePlane(scratchNormal, position));

    // Bottom plane
    Cartesian3.multiplyByScalar(up, bottom, scratchNormal);
    Cartesian3.add(scratchNearCenter, scratchNormal, scratchNormal);
    Cartesian3.subtract(scratchNormal, position, scratchNormal);
    Cartesian3.cross(scratchRight, scratchNormal, scratchNormal);
    Cartesian3.normalize(scratchNormal, scratchNormal);
    planes.push(this.makePlane(scratchNormal, position));

    // Top plane
    Cartesian3.multiplyByScalar(up, top, scratchNormal);
    Cartesian3.add(scratchNearCenter, scratchNormal, scratchNormal);
    Cartesian3.subtract(scratchNormal, position, scratchNormal);
    Cartesian3.cross(scratchNormal, scratchRight, scratchNormal);
    Cartesian3.normalize(scratchNormal, scratchNormal);
    planes.push(this.makePlane(scratchNormal, position));

    // Near plane
    Cartesian3.normalize(direction, scratchNormal);
    planes.push(this.makePlane(scratchNormal, scratchNearCenter));

    // Far plane
    Cartesian3.multiplyByScalar(direction, -1.0, scratchNormal);
    planes.push(this.makePlane(scratchNormal, scratchFarCenter));

    return planes;
  }

  private makePlane(normal: Cartesian3, point: Cartesian3): FrustumPlane {
    return { x: normal.x, y: normal.y, z: normal.z, w: -Cartesian3.dot(normal, point) };
  }

  /** 取得或创建瓦片持久状态。 */
  private ensureState(key: number): TraversalTileState {
    let state = this.states.get(key);
    if (!state) {
      state = {
        key,
        lastFrameVisited: -1,
        used: false,
        usedLastFrame: false,
        active: false,
        wasActive: false,
        visible: false,
        wasVisible: false,
        inFrustum: false,
        isLeaf: false,
        refined: false,
        wasRefined: false,
        allChildrenReady: false,
        allChildrenLoaded: false,
        kicked: false,
        distance: 9_999_999_999.0,
        error: Infinity,
        priority: 0,
        rectangle: null,
        syntheticVolume: null,
        syntheticMinimumHeight: Number.NaN,
        syntheticMaximumHeight: Number.NaN,
      };
      this.states.set(key, state);
    }
    return state;
  }

  private stateOf(key: number): TraversalTileState {
    const state = this.states.get(key);
    if (state) return state;
    return this.ensureState(key);
  }

  /** 限制缓存大小：超过上限时清掉本帧未访问的瓦片状态。 */
  private sweepCache(touchedKeys: Set<number>): void {
    if (this.states.size <= this.maximumCachedStates) {
      return;
    }
    // Map 迭代器支持删除当前项，无需先展开成数组（避免一次大分配）。
    for (const key of this.states.keys()) {
      if (!touchedKeys.has(key)) {
        this.states.delete(key);
        this.accessorCache.delete(key);
      }
    }
  }
}
