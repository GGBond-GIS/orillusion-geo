/** Cesium Worker 静态资源根路径。 */
const CESIUM_WORKER_BASE_URL = '/cesium/Source/';

/**
 * 在首次调用 TerrainData.createMesh 前配置 Cesium TaskProcessor 的 Worker 根路径。
 * @param baseUrl 包含 Source/Workers 的公开根路径，默认使用项目 public/cesium。
 */
export function configureCesiumWorkerRuntime(baseUrl = CESIUM_WORKER_BASE_URL): void {
  if (typeof window === 'undefined') return;
  const target = window as Window & { CESIUM_BASE_URL?: string };
  if (target.CESIUM_BASE_URL && target.CESIUM_BASE_URL !== baseUrl) {
    throw new Error(`CESIUM_BASE_URL 已被配置为 ${target.CESIUM_BASE_URL}，不能改为 ${baseUrl}。`);
  }
  target.CESIUM_BASE_URL = baseUrl;
}
