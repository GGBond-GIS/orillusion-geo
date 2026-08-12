import { CResizeEvent, ComputeShader, Context3D, Reference, RenderTexture, Texture } from '@orillusion/core';
import type { Rectangle } from '@cesium/engine';

/** Cesium WebMercator 影像重投影参数。 */
export interface GlobeReprojectionOptions {
  /** 输出纹理宽度。 */
  width: number;
  /** 输出纹理高度。 */
  height: number;
  /** 输出纹理覆盖的地理经纬度范围。 */
  geographicRectangle: Rectangle;
  /** 源 WebMercator 瓦片的原生米制范围。 */
  webMercatorRectangle: Rectangle;
}

/**
 * 以 Orillusion ComputeShader 执行 Cesium ImageryLayer 的 WebMercator 到 Geographic 重投影。
 * 每个任务把 Cesium 计算出的瓦片范围固化为 shader 常量，避免绕过 Orillusion 的官方计算着色器提交链路。
 */
export class GlobeReprojectionCompute {
  private readonly context: Context3D;

  /**
   * 创建重投影计算器。
   * @param context Orillusion WebGPU 上下文。
   */
  public constructor(context: Context3D) { this.context = context; }

  /**
   * 将 WebMercator 源影像写入可按地理纬度采样的新纹理。
   * @param source Cesium 影像上传后的 Orillusion 纹理。
   * @param options 源、目标范围及输出尺寸。
   * @returns GPU 队列确认计算完成后返回的目标纹理。
   */
  public reproject(source: Texture, options: GlobeReprojectionOptions): Promise<RenderTexture> {
    // Compute storage、后续材质采样和 Orillusion 渲染图管理都需要对应 usage；
    // 缺少 RENDER_ATTACHMENT 会让引擎为纹理生成的 BindGroup 失效。
    const target = new RenderTexture(options.width, options.height, 'rgba8unorm', false, 0x01 | 0x02 | 0x04 | 0x08 | 0x10, 1, 0, false, false, this.context);
    const compute = new ComputeShader(createReprojectionShader(options));
    compute.setSamplerTexture('sourceTexture', source);
    compute.setStorageTexture('targetTexture', target);
    compute.workerSizeX = Math.ceil(options.width / 8);
    compute.workerSizeY = Math.ceil(options.height / 8);
    compute.workerSizeZ = 1;
    const command = this.context.gpuContext.beginCommandEncoder();
    let computePass: ReturnType<typeof command.beginComputePass> | undefined;
    try {
      computePass = command.beginComputePass();
      compute.compute(computePass);
      // Cesium ComputeCommand 只属于当前帧。Orillusion ComputeShader 会在首次 compute 时永久监听 resize，
      // 但其 destroy() 不会移除监听；瓦片纹理释放后 resize 会再次用失效纹理创建 BindGroup。
      this.detachResizeListener(compute);
      computePass.end();
      computePass = undefined;
      this.context.gpuContext.endCommandEncoder(command);
    } catch (error) {
      // Orillusion 的 computeCommand 在 compute() 抛错时不会结束 pass，会污染整个 CommandEncoder。
      // 此处保证 pass 成对结束，并丢弃未提交的 encoder，让真正的首个资源错误可以被单独处理。
      try { computePass?.end(); } catch { /* pass 已失效时无需再次处理 */ }
      this.detachResizeListener(compute);
      this.detachTextureReferences(compute, source, target);
      target.destroy(true);
      return Promise.reject(error);
    }
    return this.context.device.queue.onSubmittedWorkDone().then(() => {
      this.detachTextureReferences(compute, source, target);
      compute.destroy(true);
      return target;
    });
  }

  /**
   * 撤销 Orillusion ComputeShader 自动注册、但不会在 destroy 中清理的窗口尺寸监听。
   * @param compute 已完成当前 Cesium 重投影命令录制的计算着色器。
   */
  private detachResizeListener(compute: ComputeShader): void {
    type ResizeListener = { id: number; thisObject?: unknown };
    type ResizeDispatcher = Context3D & {
      listeners?: Record<string, ResizeListener[]>;
      removeEventListenerAt(id: number): boolean;
    };
    const dispatcher = this.context as ResizeDispatcher;
    const listeners = dispatcher.listeners?.[CResizeEvent.RESIZE];
    if (!listeners) return;
    for (const listener of [...listeners]) {
      if (listener.thisObject === compute) dispatcher.removeEventListenerAt(listener.id);
    }
  }

  /**
   * 清除 ComputeShader.genGroups 为源纹理和目标纹理增加的 Orillusion 引用。
   * @param compute 已完成提交的单帧计算命令。
   * @param source 当前重投影源纹理。
   * @param target 当前重投影目标纹理。
   */
  private detachTextureReferences(compute: ComputeShader, source: Texture, target: RenderTexture): void {
    const references = Reference.getInstance();
    references.detached(source, compute);
    references.detached(target, compute);
  }
}

/**
 * 生成单瓦片重投影 WGSL。Cesium 的 Rectangle 是 west、south、east、north 顺序。
 * @param options Cesium 骨架计算出的源和目标范围。
 * @returns 可直接交给 Orillusion ComputeShader 的 WGSL。
 */
function createReprojectionShader(options: GlobeReprojectionOptions): string {
  const geographic = options.geographicRectangle;
  const native = options.webMercatorRectangle;
  return /* wgsl */ `
@group(0) @binding(0) var sourceTexture: texture_2d<f32>;
@group(0) @binding(1) var sourceTextureSampler: sampler;
@group(0) @binding(2) var targetTexture: texture_storage_2d<rgba8unorm, write>;
const west = ${geographic.west};
const south = ${geographic.south};
const east = ${geographic.east};
const north = ${geographic.north};
const nativeSouth = ${native.south};
const nativeNorth = ${native.north};
const maximumRadius = 6378137.0;

@compute @workgroup_size(8, 8, 1)
fn CsMain(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = textureDimensions(targetTexture);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let uv = (vec2<f32>(id.xy) + vec2<f32>(0.5)) / vec2<f32>(size);
  let longitude = mix(west, east, uv.x);
  // WebGPU 外部图像 y=0 位于北侧；Orillusion 的纹理采样也保持该方向。
  let latitude = mix(south, north, uv.y);
  let nativeX = maximumRadius * longitude;
  let nativeY = maximumRadius * log(tan(0.7853981633974483 + latitude * 0.5));
  let sourceU = (nativeX - maximumRadius * west) / (maximumRadius * (east - west));
  let sourceV = (nativeY - nativeSouth) / (nativeNorth - nativeSouth);
  let color = textureSampleLevel(sourceTexture, sourceTextureSampler, vec2<f32>(sourceU, sourceV), 0.0);
  textureStore(targetTexture, vec2<i32>(id.xy), color);
}`;
}
