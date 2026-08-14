import {
  CameraType,
  ComponentBase,
  Context3D,
  CResizeEvent,
  Frustum,
  Matrix4,
  Quaternion,
  Ray,
  Rect,
  Vector3,
  View3D,
} from '@orillusion/core';
import type { Camera3D, ILight } from '@orillusion/core';
import { setRayFromCamera } from './controlsUtils.js';
import type { Ray as ControlsRay } from './Ray.js';

/**
 * three.js 约定相机（独立组件，不继承 Camera3D）。
 *
 * 背景：Orillusion（本 fork）相机前向为 +z，three.js 相机前向为 -z；
 * 3d-tiles-renderer 的 GlobeControls 移植代码按 three.js 约定直接操作相机
 * transform（-z 前向、Matrix4.lookAt 同款基向量），直接用在 fork 相机上会
 * 导致 tilt/对齐等数学反相（相机被翻转背对场景，渲染黑屏）。
 *
 * 本类按用户要求：数学与 three.js 一致（lookAt 同款基、控制器按 three 约定
 * 操作 transform），封装按 Orillusion 组件体系（继承 ComponentBase，经
 * addComponent 挂载）。注意：Globe（四叉树/瓦片选择）与渲染管线都按 fork
 * 相机约定（transform 前向 = +z）适配，因此本类让 transform 保持 fork 约定
 * （+z 指向目标），而控制器（GlobeControls）整体镜像为 fork 约定的数学
 * （见 EnvironmentControls/GlobeControls 中 7 处 _forward 引用的注释）。
 *
 * 视图矩阵 = world⁻¹；pvMatrix / 视锥剔除 / 拾取重建 / 射线反投影都经由
 * viewMatrix，自动一致，与 pixel 拾取标定一致。
 */
export class ThreeConventionCamera3D extends ComponentBase {
  /** 渲染主相机引用（与 Camera3D.mainCamera 对齐）。 */
  static mainCamera: ThreeConventionCamera3D;

  fov = 60;
  name = '';
  aspect = 1;
  near = 1;
  far = 5000;
  left = -100;
  right = 100;
  top = 100;
  bottom = -100;
  frustumSize = 0;
  frustumDepth = 0;
  viewPort = new Rect();
  frustum = new Frustum();
  sh = new Float32Array(36);
  isShadowCamera = false;
  shadowLight?: ILight;
  cullingMask = 0xffffffff;
  type = CameraType.perspective;
  lookTarget = new Vector3(0, 0, 0);
  /** 相机绑定的图形上下文（多引擎场景使用；本相机由示例显式指定 view.camera）。 */
  _boundCtx: Context3D | null = null;
  private _resizeListenerAttached = false;

  private _projectionMatrixInv = new Matrix4();
  private _projectionMatrix = new Matrix4();
  private _viewMatrix = new Matrix4();
  private _viewMatrixInv = new Matrix4();
  private _unprojection = new Matrix4();
  private _pvMatrixInv = new Matrix4();
  private _pvMatrix = new Matrix4();
  private _ray = new Ray();

  private _forkView = new Matrix4();

  // TAA jitter 占位（本相机不实现抖动投影，保持与 fork 管线 API 兼容）。
  private _jitterFrameIndex = 0;
  private _jitterX = 0;
  private _jitterY = 0;

  get projectionMatrix(): Matrix4 {
    return this._projectionMatrix;
  }

  get projectionMatrixInv(): Matrix4 {
    return this._projectionMatrixInv;
  }

  /**
   * 视图矩阵：fork 约定 transform（+z 前向，与 Globe/渲染管线一致），
   * 视图 = world⁻¹。渲染、视锥、拾取、射线反投影均经由本 getter。
   */
  get viewMatrix(): Matrix4 {
    this._forkView.copy(this.transform.worldMatrix).invert();
    return this._forkView;
  }

  get shadowViewMatrix(): Matrix4 {
    return this.viewMatrix;
  }

  get pvMatrix(): Matrix4 {
    return this._pvMatrix.multiplyMatrices(this._projectionMatrix, this.viewMatrix);
  }

  get pvMatrix2(): Matrix4 {
    this._viewMatrix.copy(this._projectionMatrix).multiply(this.transform.worldMatrix);
    return this._viewMatrix;
  }

  get pvMatrixInv(): Matrix4 {
    return this._pvMatrixInv.copy(this.pvMatrix).invert();
  }

  get vMatrixInv(): Matrix4 {
    return this._viewMatrixInv.copy(this.viewMatrix).invert();
  }

  get cameraToWorld(): Matrix4 {
    return this._unprojection.copy(this.projectionMatrixInv).multiply(this.vMatrixInv);
  }

  get ndcToView(): Matrix4 {
    return this._unprojection.copy(this.projectionMatrixInv);
  }

  get jitterFrameIndex(): number {
    return this._jitterFrameIndex;
  }

  get jitterX(): number {
    return this._jitterX;
  }

  get jitterY(): number {
    return this._jitterY;
  }

  override init(): void {
    super.init();
    ThreeConventionCamera3D.mainCamera = this;
    this.updateProjection();
  }

  override onEnable(view?: View3D): void {
    this._bindToContext(view?.engine3D?.context3D ?? this._boundCtx ?? this.transform.view3D?.engine3D?.context3D);
  }

  override onDisable(): void {
    this._unbindContext();
  }

  override onUpdate(): void {
    // 与 Camera3D 一致：每帧用 pvMatrix 刷新视锥（剔除用）。
    this.frustum.update(this.pvMatrix);
    this.frustum.updateBoundBox(this.pvMatrixInv);
  }

  updateProjection(): void {
    const ctx = this._boundCtx ?? this.transform.view3D?.engine3D?.context3D;
    if (ctx) {
      this._boundCtx = ctx;
      this.aspect = ctx.aspect;
      this.viewPort = new Rect(0, 0, ctx.presentationSize[0], ctx.presentationSize[1]);
    }
    if (this.type === CameraType.perspective) {
      this.perspective(this.fov, this.aspect, this.near, this.far);
    }
    this._projectionMatrixInv.copy(this._projectionMatrix).invert();
  }

  /** Mirror Camera3D's resize contract so custom projection never keeps a stale aspect ratio. */
  private _bindToContext(ctx?: Context3D | null): void {
    if (!ctx) return;
    if (this._boundCtx !== ctx) this._unbindContext();
    this._boundCtx = ctx;
    if (!this._resizeListenerAttached) {
      ctx.addEventListener(CResizeEvent.RESIZE, this.updateProjection, this);
      this._resizeListenerAttached = true;
    }
    this.updateProjection();
  }

  private _unbindContext(): void {
    if (this._boundCtx && this._resizeListenerAttached) {
      this._boundCtx.removeEventListener(CResizeEvent.RESIZE, this.updateProjection, this);
    }
    this._resizeListenerAttached = false;
  }

  /** 透视相机（fork Matrix4 同款 LH 约定：x 列取负、w = z_view）。 */
  perspective(fov: number, aspect: number, near: number, far: number): void {
    this.fov = fov;
    this.aspect = aspect;
    this.near = Math.max(near, 0.1);
    this.far = far;
    this.type = CameraType.perspective;
    const a = Math.tan((fov * Math.PI) / 360) * near;
    const b = a * aspect;
    this._projectionMatrix.frustum(-b, b, -a, a, near, far);
  }

  /**
   * 对齐 fork 相机数学：+z 指向目标（Matrix4.lookAt 同款，与 Globe 的
   * transform.forward 读取一致）。控制器整体按镜像后的数学操作 transform。
   */
  lookAt(pos: Vector3, target: Vector3, up = new Vector3(0, 0, 1)): void {
    const transform = this.transform;
    transform.localPosition = pos;
    // fork Matrix4.lookAt(eye, target, up) 生成视图矩阵，求逆得世界旋转。
    const basis = new Matrix4();
    basis.lookAt(pos, target, up);
    basis.invert();
    transform.localRotQuat = new Quaternion().setFromRotationMatrix(basis);
    this.lookTarget.copy(target);
  }

  enableJitterProjection(_value: boolean): void {
    // 本相机不实现 TAA 抖动投影（占位，保持与 fork 管线 API 兼容）。
  }

  getShadowBias(_depthTexSize: number): number {
    return 0;
  }

  getShadowWorldExtents(): number {
    return 0;
  }

  /**
   * 世界坐标 → 屏幕坐标（标准映射：clip = pvMatrix·p，NDC → 屏幕，y 向下）。
   * 供 EnvironmentControls 的 pivot 屏幕位置检查使用。
   */
  worldToScreenPoint(point: Vector3, target: Vector3 = new Vector3()): Vector3 {
    const halfW = this.viewPort.width / 2;
    const halfH = this.viewPort.height / 2;
    this.pvMatrix.perspectiveMultiplyPoint3(point, target);
    target.x = target.x * halfW + halfW;
    target.y = halfH - target.y * halfH;
    return target;
  }

  /**
   * 屏幕像素坐标（元素相对，CSS px，y 向下）→ 世界射线（origin = 相机位置，
   * direction 归一化）。与引擎 Camera3D.screenPointToRay 同签名同输入约定：
   * PickFire（bound 拾取）/ TransformController 等引擎路径按此调用。
   *
   * 注意引擎自带 Camera3D.screenPointToRay 在本 fork 中不可信（UnProjection
   * 矩阵乘法顺序为 invProj·world，顺序错误），因此这里直接复用已用 pixel 拾取
   * 逐点标定的 setRayFromCamera 数学（NDC y 翻转 + 平移清零视图先求逆），
   * bound 拾取射线与 GPU 拾取重建方向精确一致。
   *
   * 返回引擎 Ray（而非本仓库 Controls/Ray）：引擎 ColliderShape.rayPick 会
   * 对传入射线做 Ray.copy（读取内部 _dir/length 字段）再 applyMatrix/
   * intersectBox/intersectTriangle，只有引擎 Ray 的字段与方法齐备。
   */
  screenPointToRay(viewPortPosX: number, viewPortPosY: number): Ray {
    const ctx = this._boundCtx ?? this.transform.scene3D?.view?.engine3D?.context3D;
    const canvas = ctx?.canvas;
    // 与引擎 CameraUtil.UnProjection 同一约定：按 canvas 客户端尺寸（CSS px）
    // 换算 NDC；canvas 未就绪时退回 viewPort（设备 px，pixelRatio=1 时等价）。
    const width = canvas?.clientWidth || this.viewPort.width;
    const height = canvas?.clientHeight || this.viewPort.height;
    if (!width || !height) return this._ray;
    const ndcX = (viewPortPosX / width) * 2 - 1;
    const ndcY = 1 - (viewPortPosY / height) * 2;
    setRayFromCamera(this._ray as unknown as ControlsRay, { x: ndcX, y: ndcY }, this as unknown as Camera3D);
    // setRayFromCamera 只保证方向指向正确、不保证单位长度；引擎拾取路径的
    // 求交距离（pointAt/intersectTriangle 的 t）依赖归一化方向，与引擎
    // Camera3D.screenPointToRay 的 end.sub(start).normalize() 保持一致。
    this._ray.direction.normalize();
    return this._ray;
  }

  override destroy(force?: boolean): void {
    this._unbindContext();
    super.destroy(force);
  }
}
