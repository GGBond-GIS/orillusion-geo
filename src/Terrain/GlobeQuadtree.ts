import { Cartesian3, Cartographic, type BoundingSphere, type Rectangle, type TerrainProvider, type TilingScheme } from '@cesium/engine';
// @ts-expect-error Cesium 将 Globe 使用的 EllipsoidalOccluder 保留在 Source 内部，运行时代码随 engine 包发布。
import EllipsoidalOccluder from '@cesium/engine/Source/Core/EllipsoidalOccluder.js';
import type { Camera3D } from '@orillusion/core';
import type { TerrainTileKey } from './TerrainTileState.js';

/**
 * 对齐 Cesium TileSelectionResult：记录瓦片上一帧被选择的结果。
 * KICK 位叠加在 RENDERED/REFINED 之上；originalResult() 剥离 KICK 位。
 */
const SelectionResult = {
  NONE: 0,
  CULLED: 1,
  RENDERED: 2,
  REFINED: 3,
  RENDERED_AND_KICKED: 6,
  REFINED_AND_KICKED: 7,
  CULLED_BUT_NEEDED: 9,
} as const;

/** 剥离 KICK/CULLED_BUT_NEEDED 叠加位，得到原始选择结果。 */
function originalResult(value: number): number {
  return value & 3;
}

/** 是否被 KICK（RENDERED_AND_KICKED / REFINED_AND_KICKED）。 */
function wasKicked(value: number): boolean {
  return value >= SelectionResult.RENDERED_AND_KICKED;
}

/** 叠加 KICK 位。 */
function kick(value: number): number {
  return value | 4;
}

/** 与 Cesium Intersect 一致的球体-平面求交结果。 */
const Intersect = { OUTSIDE: -1, INTERSECTING: 0, INSIDE: 1 } as const;

/** 与 Cesium Visibility 一致的瓦片可见性。 */
const Visibility = { NONE: 0, PARTIAL: 1, FULL: 2 } as const;

/** 一个视锥平面：ax + by + cz + d = 0。 */
interface FrustumPlane {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Globe 提供的瓦片状态访问器，对应 Cesium QuadtreeTile / GlobeSurfaceTile 的只读面。 */
export interface GlobeTileAccessor {
  /** 对齐 Cesium tile.renderable：地形网格与影像都就绪，本帧可真实绘制。 */
  isFullyRenderable(tile: TerrainTileKey): boolean;
  /** 对齐 Cesium tile.state === DONE：地形与影像全部完成加载。 */
  isCompletelyLoaded(tile: TerrainTileKey): boolean;
  /** 对齐 Cesium canRenderWithoutLosingDetail：渲染该瓦片不会丢失上一帧可见的细节。 */
  canRenderWithoutLosingDetail(tile: TerrainTileKey): boolean;
  /** 对齐 Cesium tile.needsLoading：该瓦片还需要加载。 */
  needsLoading(tile: TerrainTileKey): boolean;
  /** 对齐 Cesium surfaceTile.terrainData !== undefined。 */
  hasTerrainData(tile: TerrainTileKey): boolean;
  /** 对齐 Cesium tile.upsampledFromParent：地形上采样且影像全部失败。 */
  isUpsampledFromParent(tile: TerrainTileKey): boolean;
  /** 对齐 Cesium tileBoundingRegion.boundingVolume：真实地形包围体，未就绪回退父级，再无则 undefined。 */
  getBoundingVolume(tile: TerrainTileKey): BoundingSphere | undefined;
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
  /** 本帧渲染列表（可能包含尚未就绪的瓦片，由 Globe 回退到最近可渲染祖先）。 */
  renderList: TerrainTileKey[];
  /** 高优先级加载队列：阻止细化的瓦片。 */
  loadQueueHigh: TerrainTileKey[];
  /** 中优先级加载队列：可渲染但需要加载、后代超限后提升的父瓦片、相机所在瓦片。 */
  loadQueueMedium: TerrainTileKey[];
  /** 低优先级加载队列：preloadAncestors / preloadSiblings。 */
  loadQueueLow: TerrainTileKey[];
  /** 本帧访问过的所有瓦片键（含剔除），用于 replacement queue 保活。 */
  touchedKeys: Set<string>;
  /** 相机所在、仅需加载地形的瓦片（CULLED_BUT_NEEDED）。 */
  culledButNeededKeys: Set<string>;
}

/** 遍历期间一棵子树的就绪汇总，对齐 Cesium TraversalDetails。 */
class TraversalDetails {
  public allAreRenderable = true;
  public anyWereRenderedLastFrame = false;
  public notYetRenderableCount = 0;

  public static combine(details: TraversalDetails[]): TraversalDetails {
    const result = new TraversalDetails();
    result.allAreRenderable = details.every(item => item.allAreRenderable);
    result.anyWereRenderedLastFrame = details.some(item => item.anyWereRenderedLastFrame);
    result.notYetRenderableCount = details.reduce((sum, item) => sum + item.notYetRenderableCount, 0);
    return result;
  }
}

/** 瓦片在四叉树内的持久状态：上一帧选择结果、本帧距离与加载优先级、瓦片矩形缓存。 */
interface TraversalTileState {
  key: string;
  result: number;
  resultFrame: number;
  distance: number;
  priority: number;
  rectangle: Rectangle | null;
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
  completelyLoaded: boolean;
  canRender: boolean;
  needsLoading: boolean;
  hasTerrainData: boolean;
  upsampled: boolean;
  volume: BoundingSphere | undefined;
}

/** 单帧遍历上下文。 */
interface TraversalContext {
  frameNumber: number;
  accessor: GlobeTileAccessor;
  renderList: TerrainTileKey[];
  loadQueueHigh: TerrainTileKey[];
  loadQueueMedium: TerrainTileKey[];
  loadQueueLow: TerrainTileKey[];
  touchedKeys: Set<string>;
  culledButNeededKeys: Set<string>;
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

  private readonly states = new Map<string, TraversalTileState>();
  private readonly accessorCache = new Map<string, AccessorCacheEntry>();
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
      touchedKeys: new Set<string>(),
      culledButNeededKeys: new Set<string>(),
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

    for (const root of roots) {
      const key = this.tileKey(root);
      ctx.touchedKeys.add(key);
      if (!this.accessorOf(root, ctx).fullyRenderable) {
        // 根瓦片还不可渲染：直接高优先级加载，让地球尽快出现。
        const state = this.ensureState(root);
        this.queueTileLoad(ctx, ctx.loadQueueHigh, root, state);
      } else {
        this.visitIfVisible(root, ctx, false, new TraversalDetails());
      }
    }

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
  public wasRenderedLastFrame(key: string, frameNumber: number): boolean {
    const state = this.states.get(key);
    if (!state || state.resultFrame !== frameNumber - 1) return false;
    return originalResult(state.result) === SelectionResult.RENDERED;
  }

  /**
   * 查询某瓦片上一帧是否被细化（REFINED 或 REFINED_AND_KICKED）。
   * 供 Globe 实现 canRenderWithoutLosingDetail 的后代遍历使用。
   */
  public wasRefinedLastFrame(key: string, frameNumber: number): boolean {
    const state = this.states.get(key);
    if (!state || state.resultFrame !== frameNumber - 1) return false;
    return originalResult(state.result) === SelectionResult.REFINED;
  }

  /** 生成内部瓦片键。 */
  public tileKey(tile: TerrainTileKey): string {
    return `${tile.level}/${tile.x}/${tile.y}`;
  }

  /** 取父瓦片键，根瓦片返回 null。 */
  public parentKey(key: string): string | null {
    const [levelText, xText, yText] = key.split('/');
    const level = Number(levelText);
    if (level === 0) return null;
    return `${level - 1}/${Math.floor(Number(xText) / 2)}/${Math.floor(Number(yText) / 2)}`;
  }

  /** 供 Globe 在瓦片被淘汰时清理四叉树缓存。 */
  public invalidate(key: string): void {
    this.states.delete(key);
    this.accessorCache.delete(key);
  }

  /** 对齐 Cesium QuadtreePrimitive.visitTile。 */
  private visitTile(tile: TerrainTileKey, ancestorMeetsSse: boolean, details: TraversalDetails, ctx: TraversalContext): void {
    const key = this.tileKey(tile);
    const state = this.ensureState(tile);
    ctx.touchedKeys.add(key);
    this.debugCounts.visited += 1;

    const meetsSse = this.screenSpaceError(tile, state) < this.maximumScreenSpaceError;
    const lastFrameResult = state.resultFrame === ctx.frameNumber - 1 ? state.result : SelectionResult.NONE;
    const cachedAccessor = this.accessorOf(tile, ctx);

    if (meetsSse || ancestorMeetsSse) {
      // 该瓦片（或其祖先）是本帧想渲染的。是否真正渲染取决于：
      // 1. 上一帧渲染过（或被 KICK）；2. 上一帧被剔除或未访问；3. 完全加载完成；4. 渲染它不会丢失细节。
      const oneRenderedLastFrame = originalResult(lastFrameResult) === SelectionResult.RENDERED;
      const twoCulledOrNotVisited =
        originalResult(lastFrameResult) === SelectionResult.CULLED ||
        lastFrameResult === SelectionResult.NONE;
      const threeCompletelyLoaded = cachedAccessor.completelyLoaded;
      let renderable = oneRenderedLastFrame || twoCulledOrNotVisited || threeCompletelyLoaded;
      if (!renderable) {
        renderable = cachedAccessor.canRender;
      }

      if (renderable) {
        // 只有该瓦片（而非其祖先）满足 SSE 时才加载它。
        if (meetsSse) {
          this.queueTileLoad(ctx, ctx.loadQueueMedium, tile, state);
        }
        this.addTileToRenderList(ctx, tile);
        details.allAreRenderable = cachedAccessor.fullyRenderable;
        details.anyWereRenderedLastFrame = lastFrameResult === SelectionResult.RENDERED;
        details.notYetRenderableCount = cachedAccessor.fullyRenderable ? 0 : 1;
        state.result = SelectionResult.RENDERED;
        state.resultFrame = ctx.frameNumber;
        return;
      }

      // 否则不能渲染本瓦片（会丢失上一帧可见的细节）：
      // 继续遍历后代，保持上一帧渲染的后代继续渲染，并为新出现的后代渲染“填充”。
      ancestorMeetsSse = true;
      if (meetsSse) {
        this.queueTileLoad(ctx, ctx.loadQueueHigh, tile, state);
      }
    }

    if (this.canRefine(tile, ctx)) {
      // 对齐 Cesium：四个子瓦片全部参与 allAreUpsampled 判断与 near-to-far 访问，
      // 可见性测试在 visitIfVisible 内部完成。
      const childLevel = tile.level + 1;
      const childX = tile.x * 2;
      const childY = tile.y * 2;
      const children: TerrainTileKey[] = [
        { x: childX, y: childY, level: childLevel },
        { x: childX + 1, y: childY, level: childLevel },
        { x: childX, y: childY + 1, level: childLevel },
        { x: childX + 1, y: childY + 1, level: childLevel },
      ];
      const allAreUpsampled = children.every(child => this.accessorOf(child, ctx).upsampled);

      if (allAreUpsampled) {
        // 四个子瓦片都只是父级上采样，渲染它们没有意义：渲染本瓦片。
        this.addTileToRenderList(ctx, tile);
        this.queueTileLoad(ctx, ctx.loadQueueMedium, tile, state);
        // 保活子瓦片，避免它们被卸载后忘记自己是 upsampled。
        for (const child of children) ctx.touchedKeys.add(this.tileKey(child));
        details.allAreRenderable = cachedAccessor.fullyRenderable;
        details.anyWereRenderedLastFrame = lastFrameResult === SelectionResult.RENDERED;
        details.notYetRenderableCount = cachedAccessor.fullyRenderable ? 0 : 1;
        state.result = SelectionResult.RENDERED;
        state.resultFrame = ctx.frameNumber;
        return;
      }

      // SSE 不满足，细化。
      state.result = SelectionResult.REFINED;
      state.resultFrame = ctx.frameNumber;

      const firstRenderedDescendantIndex = ctx.renderList.length;
      const loadIndexLow = ctx.loadQueueLow.length;
      const loadIndexMedium = ctx.loadQueueMedium.length;
      const loadIndexHigh = ctx.loadQueueHigh.length;

      this.visitVisibleChildrenNearToFar(children, ctx, ancestorMeetsSse, details);

      if (firstRenderedDescendantIndex !== ctx.renderList.length) {
        const allAreRenderable = details.allAreRenderable;
        const anyWereRenderedLastFrame = details.anyWereRenderedLastFrame;
        const notYetRenderableCount = details.notYetRenderableCount;
        let queuedForLoad = false;

        if (!allAreRenderable && !anyWereRenderedLastFrame) {
          // 后代还没有全部就绪且上一帧没有渲染它们：把后代踢出渲染列表，改渲染本瓦片。
          // 被踢的后代及其中间祖先标记为 KICKED，下一帧仍按“上一帧渲染过”处理，保持细节。
          for (let index = firstRenderedDescendantIndex; index < ctx.renderList.length; index += 1) {
            let workKey: string | null = this.tileKey(ctx.renderList[index]);
            while (workKey !== null && !wasKicked(this.states.get(workKey)?.result ?? SelectionResult.NONE) && workKey !== key) {
              const workState = this.states.get(workKey);
              if (workState) workState.result = kick(workState.result);
              workKey = this.parentKey(workKey);
            }
          }
          ctx.renderList.length = firstRenderedDescendantIndex;
          this.addTileToRenderList(ctx, tile);
          state.result = SelectionResult.RENDERED;
          state.resultFrame = ctx.frameNumber;

          const wasRenderedLastFrame = lastFrameResult === SelectionResult.RENDERED;
          if (!wasRenderedLastFrame && notYetRenderableCount > this.loadingDescendantLimit) {
            // 等待的后代太多：放弃加载后代，改为加载本瓦片（medium 优先级），直到本瓦片可渲染。
            ctx.loadQueueLow.length = loadIndexLow;
            ctx.loadQueueMedium.length = loadIndexMedium;
            ctx.loadQueueHigh.length = loadIndexHigh;
            this.queueTileLoad(ctx, ctx.loadQueueMedium, tile, state);
            details.notYetRenderableCount = cachedAccessor.fullyRenderable ? 0 : 1;
            queuedForLoad = true;
          }

          details.allAreRenderable = cachedAccessor.fullyRenderable;
          details.anyWereRenderedLastFrame = wasRenderedLastFrame;
        }

        if (this.preloadAncestors && !queuedForLoad) {
          this.queueTileLoad(ctx, ctx.loadQueueLow, tile, state);
        }
      }
      return;
    }

    // 无法细化（没有子瓦片可用性数据）：本瓦片是细化阻塞者，渲染并高优先级加载。
    state.result = SelectionResult.RENDERED;
    state.resultFrame = ctx.frameNumber;
    this.addTileToRenderList(ctx, tile);
    this.queueTileLoad(ctx, ctx.loadQueueHigh, tile, state);
    details.allAreRenderable = cachedAccessor.fullyRenderable;
    details.anyWereRenderedLastFrame = lastFrameResult === SelectionResult.RENDERED;
    details.notYetRenderableCount = cachedAccessor.fullyRenderable ? 0 : 1;
  }

  /** 取得或计算瓦片矩形（缓存于瓦片状态，避免每帧多次分配 Cesium Rectangle）。 */
  private rectangleOf(tile: TerrainTileKey): Rectangle {
    const state = this.ensureState(tile);
    if (!state.rectangle) {
      state.rectangle = this.tilingScheme.tileXYToRectangle(tile.x, tile.y, tile.level);
    }
    return state.rectangle;
  }

  /**
   * 取得或创建瓦片本帧的 accessor 结果缓存（每帧每瓦片只计算一次）。
   */
  private accessorOf(tile: TerrainTileKey, ctx: TraversalContext): AccessorCacheEntry {
    const key = this.tileKey(tile);
    const cached = this.accessorCache.get(key);
    if (cached && cached.frame === ctx.frameNumber) {
      return cached;
    }
    const entry: AccessorCacheEntry = {
      frame: ctx.frameNumber,
      fullyRenderable: ctx.accessor.isFullyRenderable(tile),
      completelyLoaded: ctx.accessor.isCompletelyLoaded(tile),
      canRender: ctx.accessor.canRenderWithoutLosingDetail(tile),
      needsLoading: ctx.accessor.needsLoading(tile),
      hasTerrainData: ctx.accessor.hasTerrainData(tile),
      upsampled: ctx.accessor.isUpsampledFromParent(tile),
      volume: ctx.accessor.getBoundingVolume(tile),
    };
    this.accessorCache.set(key, entry);
    return entry;
  }

  /** 对齐 Cesium visitVisibleChildrenNearToFar：按相机所在象限 near-to-far 访问四个子瓦片。 */
  private visitVisibleChildrenNearToFar(
    children: TerrainTileKey[],
    ctx: TraversalContext,
    ancestorMeetsSse: boolean,
    details: TraversalDetails,
  ): void {
    // children 顺序固定为 [southwest, southeast, northwest, northeast]。
    const southwest = children[0];
    const rectangle = this.rectangleOf(southwest);
    let order: number[];
    if (this.cameraCartographic.longitude < rectangle.east) {
      if (this.cameraCartographic.latitude < rectangle.north) {
        order = [0, 1, 2, 3]; // 相机在西南象限
      } else {
        order = [2, 0, 3, 1]; // 西北
      }
    } else if (this.cameraCartographic.latitude < rectangle.north) {
      order = [1, 0, 3, 2]; // 东南
    } else {
      order = [3, 2, 1, 0]; // 东北
    }

    const quadDetails: TraversalDetails[] = this.acquireDetails(4);
    for (let index = 0; index < order.length; index += 1) {
      this.visitIfVisible(children[order[index]], ctx, ancestorMeetsSse, quadDetails[index]);
    }
    const combined = TraversalDetails.combine(quadDetails);
    this.releaseDetails(quadDetails);
    details.allAreRenderable = combined.allAreRenderable;
    details.anyWereRenderedLastFrame = combined.anyWereRenderedLastFrame;
    details.notYetRenderableCount = combined.notYetRenderableCount;
  }

  /** 对齐 Cesium visitIfVisible。 */
  private visitIfVisible(tile: TerrainTileKey, ctx: TraversalContext, ancestorMeetsSse: boolean, details: TraversalDetails): void {
    if (this.computeTileVisibility(tile, ctx) !== Visibility.NONE) {
      this.visitTile(tile, ancestorMeetsSse, details, ctx);
      return;
    }

    const key = this.tileKey(tile);
    ctx.touchedKeys.add(key);
    const state = this.ensureState(tile);
    details.allAreRenderable = true;
    details.anyWereRenderedLastFrame = false;
    details.notYetRenderableCount = 0;

    if (this.containsNeededPosition(tile)) {
      // 相机位置所在瓦片：只加载地形（medium 优先级），对相机高度/参考系有影响。
      if (this.accessorOf(tile, ctx).needsLoading) {
        this.queueTileLoad(ctx, ctx.loadQueueMedium, tile, state);
      }
      state.result = SelectionResult.CULLED_BUT_NEEDED;
      ctx.culledButNeededKeys.add(key);
    } else if (this.preloadSiblings || tile.level === 0) {
      // 剔除的 level zero 瓦片与 preloadSiblings 瓦片低优先级加载。
      this.queueTileLoad(ctx, ctx.loadQueueLow, tile, state);
      state.result = SelectionResult.CULLED;
    } else {
      state.result = SelectionResult.CULLED;
    }
    state.resultFrame = ctx.frameNumber;
  }

  /**
   * 对齐 Cesium GlobeSurfaceTileProvider.computeTileVisibility：
   * 雾剔除 → 视锥剔除 → 椭球地平线剔除；并缓存本帧瓦片距离。
   */
  private computeTileVisibility(tile: TerrainTileKey, ctx: TraversalContext): number {
    const state = this.ensureState(tile);
    // 对齐 Cesium computeDistanceToTile：包围体来自本瓦片或祖先地形（含高度）；
    // 完全找不到高度数据时使用 9999999999 哨兵距离——SSE 趋近于 0（加载并渲染而不细化），
    // 且会被雾剔除，避免没有包围体时无限细化。
    const cachedAccessor = this.accessorOf(tile, ctx);
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
    if (!this.isVisibleFromCamera(tile)) {
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
  private canRefine(tile: TerrainTileKey, ctx: TraversalContext): boolean {
    if (tile.level >= this.maximumLevel) {
      return false;
    }
    if (this.accessorOf(tile, ctx).hasTerrainData) {
      return true;
    }
    const child = { x: tile.x * 2, y: tile.y * 2, level: tile.level + 1 };
    const childAvailable = (this.terrainProvider as { getTileDataAvailable?(x: number, y: number, level: number): boolean | undefined })
      .getTileDataAvailable?.(child.x, child.y, child.level);
    return childAvailable !== undefined;
  }

  /** 对齐 Cesium QuadtreePrimitive.queueTileLoad：只入队需要加载的瓦片并计算优先级。 */
  private queueTileLoad(ctx: TraversalContext, queue: TerrainTileKey[], tile: TerrainTileKey, state: TraversalTileState): void {
    if (!this.accessorOf(tile, ctx).needsLoading) {
      return;
    }
    state.priority = this.computeTileLoadPriority(tile, state, ctx);
    queue.push(tile);
  }

  /** 对齐 Cesium GlobeSurfaceTileProvider.computeTileLoadPriority：(1 - dot(tileDir, cameraDir)) * distance。 */
  private computeTileLoadPriority(tile: TerrainTileKey, state: TraversalTileState, ctx: TraversalContext): number {
    const sphere = this.accessorOf(tile, ctx).volume;
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
  private screenSpaceError(tile: TerrainTileKey, state: TraversalTileState): number {
    const maxGeometricError = this.terrainProvider.getLevelMaximumGeometricError(tile.level);
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
  private containsNeededPosition(tile: TerrainTileKey): boolean {
    const rectangle = this.rectangleOf(tile);
    return (
      this.cameraCartographic.longitude >= rectangle.west &&
      this.cameraCartographic.longitude <= rectangle.east &&
      this.cameraCartographic.latitude >= rectangle.south &&
      this.cameraCartographic.latitude <= rectangle.north
    );
  }

  /** 椭球地平线可见性测试，避免细化相机背面的半球。 */
  private isVisibleFromCamera(tile: TerrainTileKey): boolean {
    if (Cartesian3.magnitude(this.cameraPosition) <= this.tilingScheme.ellipsoid.maximumRadius) return true;
    this.occluder.cameraPosition = this.cameraPosition;
    const rectangle = this.rectangleOf(tile);
    const cullingPoint = this.occluder.computeHorizonCullingPointFromRectangle(rectangle, this.tilingScheme.ellipsoid);
    return !cullingPoint || this.occluder.isScaledSpacePointVisible(cullingPoint);
  }

  /** 取瓦片矩形中心经纬度。 */
  private rectangleCenter(tile: TerrainTileKey): Cartographic {
    const rectangle = this.rectangleOf(tile);
    return Cartographic.fromRadians(
      (rectangle.west + rectangle.east) * 0.5,
      (rectangle.south + rectangle.north) * 0.5,
      0,
    );
  }

  private readonly detailsPool: TraversalDetails[] = [];

  private acquireDetails(count: number): TraversalDetails[] {
    const details: TraversalDetails[] = [];
    for (let index = 0; index < count; index += 1) {
      details.push(this.detailsPool.pop() ?? new TraversalDetails());
    }
    return details;
  }

  private releaseDetails(details: TraversalDetails[]): void {
    for (const item of details) {
      item.allAreRenderable = true;
      item.anyWereRenderedLastFrame = false;
      item.notYetRenderableCount = 0;
      this.detailsPool.push(item);
    }
  }

  /** level zero 瓦片列表。 */
  private levelZeroTiles(): TerrainTileKey[] {
    const roots: TerrainTileKey[] = [];
    const rootsX = this.tilingScheme.getNumberOfXTilesAtLevel(0);
    const rootsY = this.tilingScheme.getNumberOfYTilesAtLevel(0);
    for (let y = 0; y < rootsY; y += 1) {
      for (let x = 0; x < rootsX; x += 1) {
        roots.push({ x, y, level: 0 });
      }
    }
    return roots;
  }

  /** 添加瓦片到渲染列表。 */
  private addTileToRenderList(ctx: TraversalContext, tile: TerrainTileKey): void {
    ctx.renderList.push(tile);
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
  private ensureState(tile: TerrainTileKey): TraversalTileState {
    const key = this.tileKey(tile);
    let state = this.states.get(key);
    if (!state) {
      state = { key, result: SelectionResult.NONE, resultFrame: -1, distance: 9_999_999_999.0, priority: 0, rectangle: null };
      this.states.set(key, state);
    }
    return state;
  }

  private stateOf(tile: TerrainTileKey): TraversalTileState {
    const state = this.states.get(this.tileKey(tile));
    if (state) return state;
    return this.ensureState(tile);
  }

  /** 限制缓存大小：超过上限时清掉本帧未访问的瓦片状态。 */
  private sweepCache(touchedKeys: Set<string>): void {
    if (this.states.size <= this.maximumCachedStates) {
      return;
    }
    for (const key of [...this.states.keys()]) {
      if (!touchedKeys.has(key)) {
        this.states.delete(key);
        this.accessorCache.delete(key);
      }
    }
  }
}
