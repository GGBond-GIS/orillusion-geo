/**
 * 控件交互调试日志工具(默认关闭,正常模式零开销)。
 *
 * 通过 EnvironmentControlsOptions.debug 开启:
 * - `steps` 记录每一步交互的量与相机状态(滚轮/缩放/拖拽/旋转/按下/状态切换)
 * - `zoomSource` 记录缩放方向重算时的指针来源(排查“方向陈旧”)
 * - `blackScreen` 黑屏检测:相机朝向偏离地球时打印告警
 *
 * 关闭(debug 未开启)时 controls 上的 debugLog 为 null,所有调用点用可选链
 * `this.debugLog?.xxx(...)` 短路,字符串与数学计算完全不会执行。
 */
export interface DebugLogOptions {
  /** 交互步进日志:down/up/state/wheel/zoom/zoomFar/drag/rot。 */
  steps?: boolean;
  /** 缩放方向重算来源(指针/hover/pointerPositions)。 */
  zoomSource?: boolean;
  /** 黑屏检测:朝向偏离地球(fwd < 0.3)且在地表外时打印告警。 */
  blackScreen?: boolean;
}

const DEFAULT_OPTIONS: Required<DebugLogOptions> = {
  steps: true,
  zoomSource: true,
  blackScreen: true,
};

/** 命中点换算 uv(等距柱状映射:u = 经度/2π + 0.5, v = 0.5 - 纬度/π)。 */
export function uvOf(p: { x: number; y: number; z: number }): string {
  const r = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
  if (r < 1e3) return '(none)';
  const lat = Math.asin(Math.max(-1, Math.min(1, p.z / r)));
  const lon = Math.atan2(p.y, p.x);
  return `(${((lon / (2 * Math.PI)) + 0.5).toFixed(3)},${(0.5 - lat / Math.PI).toFixed(3)})`;
}

/** 相机朝向与地心方向的夹角余弦(1 = 正对地心,0 = 垂直,负值 = 背对)。 */
export function fwdDotEarth(pos: { x: number; y: number; z: number }, forward: { x: number; y: number; z: number }): number {
  const len = Math.sqrt(pos.x * pos.x + pos.y * pos.y + pos.z * pos.z);
  if (len < 1e-6) return 1;
  return (-pos.x * forward.x - pos.y * forward.y - pos.z * forward.z) / len;
}

export class ControlsDebug {
  readonly options: Required<DebugLogOptions>;

  constructor(options: DebugLogOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /** 输出一行调试日志。 */
  private log(line: string): void {
    // eslint-disable-next-line no-console
    console.log(line);
  }

  /** 交互步进日志(滚轮/缩放/拖拽/旋转/按下/状态切换)。参数为惰性求值。 */
  steps(fn: () => string): void {
    if (this.options.steps) this.log(fn());
  }

  /** 缩放方向重算来源。参数为惰性求值。 */
  zoomSource(fn: () => string): void {
    if (this.options.zoomSource) this.log(fn());
  }

  /**
   * 黑屏检测:相机朝向偏离地球(与地心方向夹角余弦 < threshold)且仍在
   * 地表外时打印告警。用于捕捉“相机一帧翻转背对地球”的瞬间。
   *
   * @param pos 相机世界位置(ECEF)
   * @param forward 相机前向(世界,单位向量)
   * @param minDist 低于该距地心距离(近似地表内)不告警
   * @param threshold fwd 低于该值视为偏离地球(默认 0.3 ≈ 72°)
   */
  checkBlackScreen(pos: { x: number; y: number; z: number }, forward: { x: number; y: number; z: number }, minDist = 6.5e6, threshold = 0.3): void {
    if (!this.options.blackScreen) return;
    const len = Math.sqrt(pos.x * pos.x + pos.y * pos.y + pos.z * pos.z);
    if (len < minDist) return;
    const fwd = fwdDotEarth(pos, forward);
    if (fwd < threshold) {
      this.log(
        `[CTRL] BLACKSCREEN fwd=${fwd.toFixed(3)} dist=${(len / 1000).toFixed(0)}km` +
          ` pos=(${pos.x.toFixed(0)},${pos.y.toFixed(0)},${pos.z.toFixed(0)})` +
          ` fwdDir=(${forward.x.toFixed(3)},${forward.y.toFixed(3)},${forward.z.toFixed(3)})`,
      );
    }
  }
}
