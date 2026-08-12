import { Camera3D, ComponentBase, Quaternion, Vector3 } from '@orillusion/core';
import { Cartesian3, Ellipsoid, IntersectionTests, Ray as CesiumRay } from '@cesium/engine';

/** GlobeControls 初始化参数。 */
export interface GlobeControlsOptions {
  /** 受控的 Orillusion 相机。 */
  camera: Camera3D;
  /** 接收指针事件的画布。 */
  domElement: HTMLElement;
  /** 椭球中心，默认世界原点。 */
  target?: Vector3;
  /** 滚轮缩放速度。 */
  zoomSpeed?: number;
  /** 相机至椭球中心的最小距离。 */
  minDistance?: number;
  /** 相机至椭球中心的最大距离。 */
  maxDistance?: number;
  /** 惯性衰减时间，单位秒。 */
  dampingFactor?: number;
}

/**
 * 3d-tiles-renderer GlobeControls 的 Orillusion 移植版。
 * 直接复用 Cesium WGS84 椭球射线求交；拖拽通过两个椭球命中点构造四元数，
 * 保留原 GlobeControls 的球面旋转、惯性、缩放和地平线裁剪职责。
 */
export class GlobeControls extends ComponentBase {
  /** 椭球中心。 */
  public readonly target = new Vector3();
  /** 缩放速度。 */
  public zoomSpeed = 0.001;
  /** 最小相机距离。 */
  public minDistance = 6_378_200;
  /** 最大相机距离。 */
  public maxDistance = 100_000_000;
  /** 与 3d-tiles-renderer 一致的 near 平面余量。 */
  public nearMargin = 0.25;
  /** 与 3d-tiles-renderer 一致的 far 平面余量。 */
  public farMargin = 0;
  /** 惯性衰减时间。 */
  public dampingFactor = 0.12;
  private readonly ellipsoid = Ellipsoid.WGS84;
  private readonly globeInertia = Quaternion.identity();
  private readonly identityQuaternion = Quaternion.identity();
  private camera: Camera3D | null = null;
  private element: HTMLElement | null = null;
  private pivotPoint: Vector3 | null = null;
  private pointerId: number | null = null;
  private inertiaFactor = 0;
  private lastUpdateTime = 0;

  /**
   * 保存控制器配置。
   * @param options 相机、画布与距离约束。
   */
  public override init(options: GlobeControlsOptions): void {
    this.camera = options.camera;
    this.element = options.domElement;
    this.target.copy(options.target ?? Vector3.ZERO);
    this.zoomSpeed = options.zoomSpeed ?? this.zoomSpeed;
    this.minDistance = options.minDistance ?? this.minDistance;
    this.maxDistance = options.maxDistance ?? this.maxDistance;
    this.dampingFactor = options.dampingFactor ?? this.dampingFactor;
  }

  /** 注册指针、滚轮和上下文菜单事件。 */
  public override onEnable(): void {
    const element = this.element;
    if (!element) return;
    element.addEventListener('pointerdown', this.onPointerDown);
    element.addEventListener('pointermove', this.onPointerMove);
    element.addEventListener('pointerup', this.onPointerUp);
    element.addEventListener('pointercancel', this.onPointerUp);
    element.addEventListener('wheel', this.onWheel, { passive: false });
    element.addEventListener('contextmenu', this.preventContextMenu);
  }

  /** 注销控制器事件。 */
  public override onDisable(): void {
    const element = this.element;
    if (!element) return;
    element.removeEventListener('pointerdown', this.onPointerDown);
    element.removeEventListener('pointermove', this.onPointerMove);
    element.removeEventListener('pointerup', this.onPointerUp);
    element.removeEventListener('pointercancel', this.onPointerUp);
    element.removeEventListener('wheel', this.onWheel);
    element.removeEventListener('contextmenu', this.preventContextMenu);
  }

  /** 推进拖拽旋转惯性并更新地平线裁剪面。 */
  public override onUpdate(): void {
    const now = performance.now();
    const deltaTime = this.lastUpdateTime === 0 ? 0 : Math.min((now - this.lastUpdateTime) / 1000, 0.064);
    this.lastUpdateTime = now;
    if (this.inertiaFactor > 0 && deltaTime > 0) {
      const rotation = Quaternion.identity();
      rotation.slerp(this.identityQuaternion, this.globeInertia, Math.min(1, this.inertiaFactor * deltaTime));
      this.rotateAroundEllipsoid(rotation);
      this.inertiaFactor *= Math.pow(2, -deltaTime / this.dampingFactor);
      if (this.inertiaFactor < 0.001) this.inertiaFactor = 0;
    }
    this.adjustCameraClipPlanes();
  }

  /**
   * 以屏幕坐标为中心按指数比例缩放相机距离。
   * @param delta 滚轮位移。
   */
  public zoom(delta: number): void {
    const position = this.getCameraPosition();
    const offset = Vector3.sub(position, this.target);
    const distance = offset.length;
    const nextDistance = Math.max(this.minDistance, Math.min(this.maxDistance, distance * Math.exp(delta * this.zoomSpeed)));
    offset.multiplyScalar(nextDistance / distance);
    this.setCameraPosition(Vector3.add(this.target, offset));
    this.inertiaFactor = 0;
  }

  /**
   * 用 Cesium IntersectionTests 在 WGS84 椭球上取指针命中点。
   * @param event 浏览器指针事件。
   * @returns ECEF 命中点；射线未命中时为空。
   */
  private pickEllipsoid(event: PointerEvent): Vector3 | null {
    if (!this.camera || !this.element) return null;
    const ray = this.camera.screenPointToRay(event.clientX, event.clientY);
    const cesiumRay = new CesiumRay(
      new Cartesian3(ray.origin.x, ray.origin.y, ray.origin.z),
      new Cartesian3(ray.direction.x, ray.direction.y, ray.direction.z),
    );
    const interval = IntersectionTests.rayEllipsoid(cesiumRay, this.ellipsoid);
    if (!interval) return null;
    const hit = CesiumRay.getPoint(cesiumRay, Math.max(interval.start, 0), new Cartesian3());
    return new Vector3(hit.x, hit.y, hit.z);
  }

  /**
   * 将相机围绕椭球中心旋转，并以当前位置法线作为 up 方向。
   * @param rotation 本帧要应用的旋转四元数。
   */
  private rotateAroundEllipsoid(rotation: Quaternion): void {
    const offset = Vector3.sub(this.getCameraPosition(), this.target).applyQuaternion(rotation);
    this.setCameraPosition(Vector3.add(this.target, offset));
  }

  /** 根据当前高度计算 3d-tiles-renderer GlobeControls 的 near/far。 */
  private adjustCameraClipPlanes(): void {
    if (!this.camera) return;
    const distance = Vector3.sub(this.getCameraPosition(), this.target).length;
    const height = Math.max(0, distance - this.ellipsoid.maximumRadius);
    const horizon = Math.sqrt(height * (height + 2 * this.ellipsoid.maximumRadius));
    this.camera.near = Math.max(1, Math.min(1000, Math.max(1, height) * this.nearMargin));
    // 注意：只取地平线会把地球最远端（distance + radius）切掉，导致整个球体被视锥远平面剔除。
    // 与 Cesium Camera 一致，far 必须覆盖到地球远端：max(地平线, 相机到地球最远端)。
    const globeFarSide = distance + this.ellipsoid.maximumRadius;
    this.camera.far = Math.max(this.camera.near + 1, horizon + 0.1 + this.ellipsoid.maximumRadius * this.farMargin, globeFarSide);
  }

  /** 取得相机世界坐标。 */
  private getCameraPosition(): Vector3 {
    const position = this.getCameraObject().localPosition;
    return new Vector3(position.x, position.y, position.z);
  }

  /**
   * 设置相机位置并朝向椭球中心。
   * @param position 新的 ECEF 相机位置。
   */
  private setCameraPosition(position: Vector3): void {
    const radial = Vector3.sub(position, this.target).normalize();
    const northAxis = new Vector3(0, 0, 1);
    const radialNorth = Vector3.multiplyScalar(radial, Vector3.dot(northAxis, radial));
    let up = Vector3.sub(northAxis, radialNorth);
    if (up.length < 1e-6) up = new Vector3(0, 1, 0);
    up.normalize();
    this.camera?.lookAt(position, this.target, up);
  }

  /** 开始椭球拖拽。 */
  private onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !this.element) return;
    const pivot = this.pickEllipsoid(event);
    if (!pivot) return;
    this.pivotPoint = pivot;
    this.pointerId = event.pointerId;
    this.inertiaFactor = 0;
    this.element.setPointerCapture(event.pointerId);
  };

  /** 将两个椭球命中点之间的旋转应用到相机。 */
  private onPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointerId || !this.pivotPoint) return;
    const nextPoint = this.pickEllipsoid(event);
    if (!nextPoint) return;
    const from = Vector3.sub(nextPoint, this.target).normalize();
    const to = Vector3.sub(this.pivotPoint, this.target).normalize();
    const rotation = new Quaternion().setFromUnitVectors(from, to);
    this.rotateAroundEllipsoid(rotation);
    this.globeInertia.set(rotation.x, rotation.y, rotation.z, rotation.w);
    this.inertiaFactor = 1;
  };

  /** 结束拖拽并保持上一帧旋转惯性。 */
  private onPointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointerId || !this.element) return;
    this.element.releasePointerCapture(event.pointerId);
    this.pointerId = null;
    this.pivotPoint = null;
  };

  /** 处理滚轮缩放。 */
  private onWheel = (event: WheelEvent): void => { event.preventDefault(); this.zoom(event.deltaY); };
  /** 禁止右键菜单打断控制。 */
  private preventContextMenu = (event: Event): void => event.preventDefault();
  /** 获取受控相机实体。 */
  private getCameraObject() { if (!this.camera) throw new Error('GlobeControls 尚未初始化相机。'); return this.camera.object3D; }
}
