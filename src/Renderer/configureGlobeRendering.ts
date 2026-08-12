import { Matrix4 } from '@orillusion/core';

/** Globe 渲染运行时配置。 */
export interface GlobeRenderingConfiguration {
  /** Orillusion 全局矩阵池容量；必须在 Engine3D.init 之前设置。 */
  matrixCapacity?: number;
}

/**
 * 在 Orillusion 初始化前收敛 Globe 场景的全局矩阵池容量。
 * Orillusion 会按 Matrix4.maxCount 创建 matrixBufferDst；默认五十万会让每个场景预留约 48 MB，
 * 并在 GPU 忙碌时被未完成的 mapAsync Promise 长时间持有。
 * @param configuration Globe 场景所需的矩阵容量配置。
 */
export function configureGlobeRendering(configuration: GlobeRenderingConfiguration = {}): void {
  const matrixCapacity = configuration.matrixCapacity ?? 16_384;
  if (!Number.isInteger(matrixCapacity) || matrixCapacity < 1_024) {
    throw new RangeError('matrixCapacity 必须是大于或等于 1024 的整数。');
  }
  if (Matrix4.dynamicMatrixBytes) {
    throw new Error('configureGlobeRendering 必须在 Engine3D.init 之前调用。');
  }
  Matrix4.maxCount = matrixCapacity;
}
