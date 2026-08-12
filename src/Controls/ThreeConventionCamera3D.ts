import { CameraType, ComponentBase, Context3D, Frustum, Matrix4, Quaternion, Rect, Vector3, View3D } from '@orillusion/core';
import type { ILight } from '@orillusion/core';

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

  private _projectionMatrixInv = new Matrix4();
  private _projectionMatrix = new Matrix4();
  private _viewMatrix = new Matrix4();
  private _viewMatrixInv = new Matrix4();
  private _unprojection = new Matrix4();
  private _pvMatrixInv = new Matrix4();
  private _pvMatrix = new Matrix4();

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
    const ctx = view?.engine3D?.context3D ?? this._boundCtx;
    if (ctx) {
      this._boundCtx = ctx;
      const c = ctx.canvas;
      this.viewPort = new Rect(0, 0, c.width, c.height);
    }
  }

  override onUpdate(): void {
    // 与 Camera3D 一致：每帧用 pvMatrix 刷新视锥（剔除用）。
    this.frustum.update(this.pvMatrix);
    this.frustum.updateBoundBox(this.pvMatrixInv);
  }

  updateProjection(): void {
    if (this.type === CameraType.perspective) {
      this.perspective(this.fov, this.aspect, this.near, this.far);
    }
    this._projectionMatrixInv.copy(this._projectionMatrix).invert();
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

  override destroy(force?: boolean): void {
    super.destroy(force);
  }
}
