import { Vector2 } from '@orillusion/core';

const _vec = new Vector2();
const _vec2 = new Vector2();

/**
 * 多指针跟踪器，1:1 移植自 3d-tiles-renderer 的
 * `src/three/renderer/controls/PointerTracker.js`（Orillusion 数学库与 three.js 对齐）。
 */
export class PointerTracker {
  public domElement: HTMLElement | null = null;
  public buttons = 0;
  public pointerType: string | null = null;
  public pointerOrder: number[] = [];
  public previousPositions: Record<number, Vector2> = {};
  public pointerPositions: Record<number, Vector2> = {};
  public startPositions: Record<number, Vector2> = {};
  public pointerSetThisFrame: Record<number, boolean> = {};
  public hoverPosition = new Vector2();
  public hoverSet = false;

  public reset(): void {
    this.buttons = 0;
    this.pointerType = null;
    this.pointerOrder = [];
    this.previousPositions = {};
    this.pointerPositions = {};
    this.startPositions = {};
    this.pointerSetThisFrame = {};
    this.hoverPosition = new Vector2();
    this.hoverSet = false;
  }

  /** 每帧把当前指针位置滚入上一帧位置。 */
  public updateFrame(): void {
    const { previousPositions, pointerPositions } = this;
    for (const id in pointerPositions) {
      previousPositions[Number(id)].copy(pointerPositions[Number(id)]);
    }
  }

  public setHoverEvent(event: PointerEvent | WheelEvent): void {
    if ((event as PointerEvent).pointerType === 'mouse' || event.type === 'wheel') {
      this.getAdjustedPointer(event, this.hoverPosition);
      this.hoverSet = true;
    }
  }

  public getLatestPoint(target: Vector2): Vector2 | null {
    if (this.pointerType !== null) {
      this.getCenterPoint(target);
      return target;
    } else if (this.hoverSet) {
      target.copy(this.hoverPosition);
      return target;
    } else {
      return null;
    }
  }

  /** 取事件相对目标元素的像素坐标。 */
  public getAdjustedPointer(event: PointerEvent | WheelEvent, target: Vector2): Vector2 {
    const domRef = this.domElement ?? (event.target as HTMLElement);
    const rect = domRef.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    target.set(x, y);
    return target;
  }

  public addPointer(event: PointerEvent): void {
    const id = event.pointerId;
    const position = new Vector2();
    this.getAdjustedPointer(event, position);
    this.pointerOrder.push(id);
    this.pointerPositions[id] = position;
    this.previousPositions[id] = position.clone();
    this.startPositions[id] = position.clone();

    if (this.getPointerCount() === 1) {
      this.pointerType = event.pointerType;
      this.buttons = event.buttons;
    }
  }

  public updatePointer(event: PointerEvent): boolean {
    const id = event.pointerId;
    if (!(id in this.pointerPositions)) return false;
    this.getAdjustedPointer(event, this.pointerPositions[id]);
    return true;
  }

  public deletePointer(event: PointerEvent): void {
    const id = event.pointerId;
    const { pointerOrder } = this;
    pointerOrder.splice(pointerOrder.indexOf(id), 1);
    delete this.pointerPositions[id];
    delete this.previousPositions[id];
    delete this.startPositions[id];

    if (this.getPointerCount() === 0) {
      this.buttons = 0;
      this.pointerType = null;
    }
  }

  public getPointerCount(): number {
    return this.pointerOrder.length;
  }

  public getCenterPoint(target: Vector2, pointerPositions: Record<number, Vector2> = this.pointerPositions): Vector2 | null {
    const { pointerOrder } = this;
    if (this.getPointerCount() === 1 || this.getPointerType() === 'mouse') {
      const id = pointerOrder[0];
      target.copy(pointerPositions[id]);
      return target;
    } else if (this.getPointerCount() === 2) {
      const id0 = pointerOrder[0];
      const id1 = pointerOrder[1];
      const p0 = pointerPositions[id0];
      const p1 = pointerPositions[id1];
      target.addVectors(p0, p1).multiplyScalar(0.5);
      return target;
    }
    return null;
  }

  public getPreviousCenterPoint(target: Vector2): Vector2 | null {
    return this.getCenterPoint(target, this.previousPositions);
  }

  public getStartCenterPoint(target: Vector2): Vector2 | null {
    return this.getCenterPoint(target, this.startPositions);
  }

  public getMoveDistance(): number {
    this.getCenterPoint(_vec);
    this.getPreviousCenterPoint(_vec2);
    return _vec.sub(_vec2).length();
  }

  public getTouchPointerDistance(pointerPositions: Record<number, Vector2> = this.pointerPositions): number {
    if (this.getPointerCount() <= 1 || this.getPointerType() === 'mouse') return 0;
    const { pointerOrder } = this;
    const id0 = pointerOrder[0];
    const id1 = pointerOrder[1];
    return pointerPositions[id0].distanceTo(pointerPositions[id1]);
  }

  public getPreviousTouchPointerDistance(): number {
    return this.getTouchPointerDistance(this.previousPositions);
  }

  public getStartTouchPointerDistance(): number {
    return this.getTouchPointerDistance(this.startPositions);
  }

  public getPointerType(): string | null {
    return this.pointerType;
  }

  public isPointerTouch(): boolean {
    return this.getPointerType() === 'touch';
  }

  public getPointerButtons(): number {
    return this.buttons;
  }

  public isLeftClicked(): boolean {
    return Boolean(this.buttons & 1);
  }

  public isRightClicked(): boolean {
    return Boolean(this.buttons & 2);
  }
}
