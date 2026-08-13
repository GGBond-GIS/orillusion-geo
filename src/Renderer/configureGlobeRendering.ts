import { GPUBufferBase, Matrix4 } from '@orillusion/core';

/** Globe 渲染运行时配置。 */
export interface GlobeRenderingConfiguration {
  /** Orillusion 全局矩阵池容量；必须在 Engine3D.init 之前设置。 */
  matrixCapacity?: number;
  /** Use queue.writeBuffer for per-frame uploads instead of an unbounded MAP_WRITE staging pool. */
  directBufferUploads?: boolean;
}

let directUploadInstalled = false;

/**
 * Orillusion's mapped staging pool allocates another full-size buffer whenever the GPU is more
 * than 20 frames behind. Globe LOD bursts can therefore turn temporary GPU pressure into an
 * allocation spiral. WebGPU queue.writeBuffer already owns and bounds its internal staging, so
 * use that path for CPU-authored buffers.
 */
function installDirectBufferUploads(): void {
  if (directUploadInstalled) return;
  directUploadInstalled = true;
  GPUBufferBase.prototype.mapAsyncWrite = function mapAsyncWrite(floatArray, len): void {
    const source = floatArray instanceof Float64Array ? new Float32Array(floatArray) : floatArray;
    if (len <= 0 || source.length === 0) return;
    const boundContext = this._boundCtx;
    if (!boundContext) {
      throw new Error('GPU buffer must be bound before upload.');
    }
    boundContext.device.queue.writeBuffer(this.buffer, 0, source.subarray(0, len));
  };
}

/**
 * 在 Orillusion 初始化前收敛 Globe 场景的全局矩阵池容量。
 * Orillusion 会按 Matrix4.maxCount 创建 matrixBufferDst；默认五十万会让每个场景预留约 48 MB，
 * 并在 GPU 忙碌时被未完成的 mapAsync Promise 长时间持有。
 * @param configuration Globe 场景所需的矩阵容量配置。
 */
export function configureGlobeRendering(configuration: GlobeRenderingConfiguration = {}): void {
  const matrixCapacity = configuration.matrixCapacity ?? 4_096;
  if (!Number.isInteger(matrixCapacity) || matrixCapacity < 1_024) {
    throw new RangeError('matrixCapacity 必须是大于或等于 1024 的整数。');
  }
  if (Matrix4.dynamicMatrixBytes) {
    throw new Error('configureGlobeRendering 必须在 Engine3D.init 之前调用。');
  }
  Matrix4.maxCount = matrixCapacity;
  if (configuration.directBufferUploads ?? true) installDirectBufferUploads();
}
