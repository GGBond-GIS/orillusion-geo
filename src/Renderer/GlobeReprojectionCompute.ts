import { Context3D, RenderTexture, Texture } from '@orillusion/core';
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

/** 单次重投影任务。 */
export interface GlobeReprojectionTask {
  /** 源 WebMercator 影像纹理。 */
  source: Texture;
  /** 重投影参数。 */
  options: GlobeReprojectionOptions;
  /** 成功后返回目标地理纹理。 */
  resolve(texture: RenderTexture): void;
  /** 失败时回调。 */
  reject(error: unknown): void;
}

/** 每任务 uniform 大小（8 个 f32 = 32 字节，对齐 uniform 缓冲 16 字节约束）。 */
const taskUniformBytes = 32;
/** WebGPU 要求 uniform 绑定的 buffer 偏移按 256 字节对齐，故每任务步长取 256。 */
const taskUniformStride = 256;

// 项目 tsconfig 未引入 @webgpu/types，此处仅声明用到的 WebGPU 全局（运行时不产生任何代码）。
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };

/**
 * 以 Orillusion 设备执行 Cesium ImageryLayer 的 WebMercator 到 Geographic 重投影。
 * 对齐 Cesium 的实现方式：ReprojectWebMercator 是**一个**共享 shader 程序，
 * 每个影像通过 uniform 提供矩形参数；全部重投影作为 ComputeCommand 追加到
 * 帧的 compute pass 内按序执行。
 *
 * 这里 reprojectBatch 把本帧全部任务录制成一个 CommandEncoder / 一个 compute pass，
 * 只提交一次并等待一次 onSubmittedWorkDone；shader module 与 pipeline 只编译一次
 * （首次批处理时惰性创建），之后每帧只有 N 个轻量 bind group 与 N 次 dispatch，
 * 避免“每任务一个 WGSL 常量 shader → 每帧几十次 shader 编译”导致的主线程卡顿。
 */
export class GlobeReprojectionCompute {
  private readonly context: Context3D;
  /** 上一次批处理是否仍在等待 GPU 完成；忙碌时跳过本帧新批次（对齐 Cesium 帧内命令队列）。 */
  public isBusy = false;
  /** 共享 compute pipeline（GPUComputePipeline，@webgpu/types 未安装故用 any）。 */
  private pipeline: any = null;

  /**
   * 创建重投影计算器。
   * @param context Orillusion WebGPU 上下文。
   */
  public constructor(context: Context3D) { this.context = context; }

  /**
   * 批量执行重投影：一个 CommandEncoder 内录制全部任务后统一提交。
   * @param tasks 本帧待执行的重投影任务。
   * @returns 全部任务已提交并等待 GPU 完成。
   */
  public reprojectBatch(tasks: GlobeReprojectionTask[]): Promise<void> {
    if (tasks.length === 0) {
      return Promise.resolve();
    }
    this.isBusy = true;
    const device = this.context.device;
    const command = this.context.gpuContext.beginCommandEncoder();
    let computePass: ReturnType<typeof command.beginComputePass> | undefined;
    const targets: RenderTexture[] = [];
    let paramsBuffer: any = null;

    try {
      const pipeline = this.ensurePipeline();
      const layout = pipeline.getBindGroupLayout(0);
      computePass = command.beginComputePass();
      computePass.setPipeline(pipeline);

      // 每任务 8 个 f32：west、south、east、north、nativeSouth、nativeNorth、pad、pad。
      // 缓冲按 256 字节/任务步长分配，数据写入各自槽位（bind group 偏移按 256 对齐）。
      const count = tasks.length;
      const params = new Float32Array(count * (taskUniformStride / 4));
      for (let index = 0; index < count; index += 1) {
        const options = tasks[index].options;
        const base = index * (taskUniformStride / 4);
        params[base] = options.geographicRectangle.west;
        params[base + 1] = options.geographicRectangle.south;
        params[base + 2] = options.geographicRectangle.east;
        params[base + 3] = options.geographicRectangle.north;
        params[base + 4] = options.webMercatorRectangle.south;
        params[base + 5] = options.webMercatorRectangle.north;
      }
      paramsBuffer = device.createBuffer({ size: count * taskUniformStride, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(paramsBuffer, 0, params);

      for (let index = 0; index < count; index += 1) {
        const task = tasks[index];
        const target = new RenderTexture(task.options.width, task.options.height, 'rgba8unorm', false, 0x01 | 0x02 | 0x04 | 0x08 | 0x10, 1, 0, false, false, this.context);
        targets.push(target);
        // 使用源纹理自带的 sampler（filtering，与源纹理的 mipmap 配置一致），
        // 避免自建 sampler 与纹理视图的 maxLod 校验不匹配。
        const group = device.createBindGroup({
          layout,
          entries: [
            { binding: 0, resource: task.source.gpuSampler },
            { binding: 1, resource: task.source.getGPUView() },
            { binding: 2, resource: target.getGPUView() },
            { binding: 3, resource: { buffer: paramsBuffer, offset: index * taskUniformStride, size: taskUniformBytes } },
          ],
        });
        computePass.setBindGroup(0, group);
        computePass.dispatchWorkgroups(
          Math.ceil(task.options.width / 8),
          Math.ceil(task.options.height / 8),
          1,
        );
      }
      computePass.end();
      computePass = undefined;
      this.context.gpuContext.endCommandEncoder(command);
    } catch (error) {
      try { computePass?.end(); } catch { /* pass 已失效时无需再次处理 */ }
      paramsBuffer?.destroy();
      for (const target of targets) target.destroy(true);
      for (const task of tasks) task.reject(error);
      this.isBusy = false;
      return Promise.reject(error);
    }

    return device.queue.onSubmittedWorkDone().then(() => {
      this.isBusy = false;
      paramsBuffer?.destroy();
      for (let index = 0; index < tasks.length; index += 1) {
        tasks[index].resolve(targets[index]);
      }
    }).catch((error: unknown) => {
      this.isBusy = false;
      paramsBuffer?.destroy();
      for (const target of targets) target.destroy(true);
      for (const task of tasks) task.reject(error);
    });
  }

  /** 惰性创建共享 compute pipeline（只编译一次）。 */
  private ensurePipeline(): any {
    if (this.pipeline) {
      return this.pipeline;
    }
    const device = this.context.device;
    const module = device.createShaderModule({ code: createReprojectionShader() });
    this.pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'CsMain' } });
    return this.pipeline;
  }
}

/**
 * 生成共享重投影 WGSL：矩形参数来自 group(0) binding(3) 的 uniform 结构，
 * 全部任务复用同一个 shader module 与 pipeline（对齐 Cesium ReprojectWebMercatorVS/FS）。
 */
function createReprojectionShader(): string {
  return /* wgsl */ `
struct ReprojectParams {
  west: f32,
  south: f32,
  east: f32,
  north: f32,
  nativeSouth: f32,
  nativeNorth: f32,
  _pad0: f32,
  _pad1: f32,
}

@group(0) @binding(0) var sourceTextureSampler: sampler;
@group(0) @binding(1) var sourceTexture: texture_2d<f32>;
@group(0) @binding(2) var targetTexture: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var<uniform> params: ReprojectParams;
const maximumRadius = 6378137.0;

@compute @workgroup_size(8, 8, 1)
fn CsMain(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = textureDimensions(targetTexture);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let uv = (vec2<f32>(id.xy) + vec2<f32>(0.5)) / vec2<f32>(size);
  let longitude = mix(params.west, params.east, uv.x);
  // WebGPU 外部图像 y=0 位于北侧；Orillusion 的纹理采样也保持该方向。
  let latitude = mix(params.south, params.north, uv.y);
  let nativeX = maximumRadius * longitude;
  let nativeY = maximumRadius * log(tan(0.7853981633974483 + latitude * 0.5));
  let sourceU = (nativeX - maximumRadius * params.west) / (maximumRadius * (params.east - params.west));
  let sourceV = (nativeY - params.nativeSouth) / (params.nativeNorth - params.nativeSouth);
  let color = textureSampleLevel(sourceTexture, sourceTextureSampler, vec2<f32>(sourceU, sourceV), 0.0);
  textureStore(targetTexture, vec2<i32>(id.xy), color);
}`;
}
