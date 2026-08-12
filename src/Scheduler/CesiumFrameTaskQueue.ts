// @ts-expect-error Cesium 的 defer 随 engine 源码发布，但未从包入口公开导出。
import defer from '@cesium/engine/Source/Core/defer.js';

/** 分帧任务执行结果。 */
export interface FrameTaskQueueStatistics {
  /** 尚未执行的任务数量。 */
  pending: number;
  /** 已执行的任务总数。 */
  completed: number;
}

interface DeferredTask {
  execute: () => void;
  resolve: () => void;
  reject: (reason?: unknown) => void;
}

/**
 * 对齐 Cesium QuadtreePrimitive.processTileLoadQueue 的时间片任务队列。
 * 每帧至少执行一个任务，随后只在截止时间之前继续，避免一次 Promise 回调批量提交 GPU 工作。
 */
export class CesiumFrameTaskQueue {
  private readonly tasks: DeferredTask[] = [];
  private completedValue = 0;
  /** 每帧允许使用的主线程时间片，单位为毫秒。 */
  public timeSliceMilliseconds: number;

  /**
   * 创建分帧任务队列。
   * @param timeSliceMilliseconds 每帧允许使用的主线程时间片，单位为毫秒。
   */
  public constructor(timeSliceMilliseconds = 5.0) { this.timeSliceMilliseconds = timeSliceMilliseconds; }

  /**
   * 把一个同步提交步骤加入队列，异步资源请求本身仍由 Cesium provider 管理。
   * @param execute 要在后续帧执行的纹理、重投影或 ECS 提交步骤。
   * @returns 任务完成时兑现的 Cesium deferred promise。
   */
  public enqueue(execute: () => void): Promise<void> {
    const deferred = defer();
    this.tasks.push({ execute, resolve: deferred.resolve, reject: deferred.reject });
    return deferred.promise;
  }

  /**
   * 按 Cesium 的规则消费当前帧时间片；即使单个任务超过预算也保证至少推进一个。
   * @param maximumTasks 当前帧任务数量上限，用于限制昂贵 GPU 提交。
   * @returns 本帧实际执行的任务数量。
   */
  public process(maximumTasks = Number.POSITIVE_INFINITY): number {
    const endTime = performance.now() + this.timeSliceMilliseconds;
    let processed = 0;
    while (this.tasks.length > 0 && processed < maximumTasks && (processed === 0 || performance.now() < endTime)) {
      const task = this.tasks.shift() as DeferredTask;
      try {
        task.execute();
        task.resolve();
      } catch (error) {
        task.reject(error);
      }
      processed += 1;
      this.completedValue += 1;
    }
    return processed;
  }

  /** 清空尚未执行的任务，供 Globe 销毁时断开闭包引用。 */
  public clear(): void { this.tasks.length = 0; }

  /** 返回队列稳定性测试所需的计数。 */
  public get statistics(): FrameTaskQueueStatistics {
    return { pending: this.tasks.length, completed: this.completedValue };
  }
}
