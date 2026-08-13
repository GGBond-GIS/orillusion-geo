import { Camera3D, Matrix4, Object3D, Quaternion, Vector2, Vector3 } from '@orillusion/core';
import { Ellipsoid, WGS84_ELLIPSOID } from '../Math/Ellipsoid.js';
import { DRAG, EnvironmentControls, FREE_ROTATE, NONE, ZOOM, type EnvironmentControlsOptions } from './EnvironmentControls.js';
import { fwdDotEarth, uvOf } from './controlsDebug.js';
import { Ray } from './Ray.js';
import { adjustedPointerToCoords, clamp, lerp, makeRotateAroundPoint, mapLinear, RAD2DEG, setRayFromCamera } from './controlsUtils.js';

let _invMatrix!: Matrix4;
// Matrix4 依赖 Engine3D.init 之后的全局矩阵池，模块级创建会在 init 前崩溃；
// 所有 scratch 矩阵延迟到首次使用时创建。
function ensureScratchMatrices(): void {
  if (_invMatrix) return;
  _invMatrix = new Matrix4();
  _rotMatrix = new Matrix4();
  _cameraMatrixLocal = new Matrix4();
}

let _rotMatrix!: Matrix4;
const _pos = new Vector3();
const _vec = new Vector3();
const _center = new Vector3();
const _forward = new Vector3();
const _targetRight = new Vector3();
const _globalUp = new Vector3();
const _quaternion = new Quaternion();
const _zoomPointUp = new Vector3();
const _toCenter = new Vector3();
const _ray = new Ray();
const _ellipsoid = new Ellipsoid();
const _pointer = new Vector2();
/** 黑屏检测用的相机前向暂存(仅 debug 开启时使用)。 */
const _debugForward = new Vector3();
/** adjustCamera 用的经纬度暂存（getPositionToCartographic 返回弧度）。 */
const _latLon: { lon: number; lat: number; height: number } = { lon: 0, lat: 0, height: 0 };
/** adjustCamera 计算地平线距离时的最低海拔（与原版一致，避免贴地时 far 过近）。 */
const MIN_ELEVATION = 2550;
let _cameraMatrixLocal!: Matrix4;
/** GlobeControls 初始化参数（EnvironmentControls 参数 + Globe 专有参数）。 */
export interface GlobeControlsOptions extends EnvironmentControlsOptions {
  /** 近平面余量占椭球半径的比例（原版默认 0.25）。 */
  nearMargin?: number;
  /** 远平面余量占椭球半径的比例（原版默认 0）。 */
  farMargin?: number;
  /** 正交缩放上限（透视相机不使用，保留原版字段）。 */
  maxZoom?: number;
  /** 椭球模型，默认 WGS84 克隆。 */
  ellipsoid?: Ellipsoid;
  /** 其世界矩阵定义椭球坐标系的组；默认内部新建的单位组（球心在原点）。 */
  ellipsoidGroup?: Object3D;
}

/**
 * GlobeControls 的 Orillusion 移植，1:1 复刻自 3d-tiles-renderer
 * `src/three/renderer/controls/GlobeControls.js`（0.5.1，继承 EnvironmentControls）。
 *
 * 提供椭球感知的旋转、球面惯性、自动 near/far 裁剪面调节、缩放倾斜与
 * 北极对齐；相机体积碰撞（cameraRadius / adjustHeight）按需求移除。
 */
export class GlobeControls extends EnvironmentControls {
  public isGlobeControls = true;

  private _dragMode = 0;
  private _rotationMode = 0;
  public override maxZoom = 0.01;

  /** 近平面距离的缓冲比例。 */
  public nearMargin = 0.25;
  /** 远平面距离的缓冲比例。 */
  public farMargin = 0;
  public override useFallbackPlane = false;
  public override autoAdjustCameraRotation = false;

  /** 累积的球面旋转惯性四元数，球面惯性激活时每帧应用。 */
  public globeInertia = new Quaternion();
  /** 当前球面旋转惯性的强度，随时间衰减到零。 */
  public globeInertiaFactor = 0;

  /** 用于表面交互与 up 方向计算的椭球模型。 */
  public ellipsoid: Ellipsoid = WGS84_ELLIPSOID.clone();
  /** 其世界矩阵定义椭球坐标系的组。 */
  public ellipsoidGroup = new Object3D();
  private _ellipsoidFrameInverse = new Matrix4();

  /** 椭球坐标系的 world 矩阵。 */
  public get ellipsoidFrame(): Matrix4 {
    this.ellipsoidGroup.transform.updateWorldMatrix();
    return this.ellipsoidGroup.transform.worldMatrix;
  }

  /** 椭球坐标系 world 矩阵的逆。 */
  public get ellipsoidFrameInverse(): Matrix4 {
    return this._ellipsoidFrameInverse.copy(this.ellipsoidFrame).invert();
  }

  /** 设置椭球模型与其场景组（原版 setEllipsoid）。 */
  public setEllipsoid(ellipsoid?: Ellipsoid, ellipsoidGroup?: Object3D): void {
    this.ellipsoid = ellipsoid ?? WGS84_ELLIPSOID.clone();
    this.ellipsoidGroup = ellipsoidGroup ?? new Object3D();
  }

  public override init(options: GlobeControlsOptions): void {
    super.init(options);
    if (options.nearMargin !== undefined) this.nearMargin = options.nearMargin;
    if (options.farMargin !== undefined) this.farMargin = options.farMargin;
    if (options.maxZoom !== undefined) this.maxZoom = options.maxZoom;
    if (options.ellipsoid !== undefined || options.ellipsoidGroup !== undefined) {
      this.setEllipsoid(options.ellipsoid, options.ellipsoidGroup);
    }
  }

  /** 枢轴点：优先椭球面估计，场景命中更近时用场景命中点。 */
  public override getPivotPoint(target: Vector3): Vector3 | null {
    ensureScratchMatrices();
    const { ellipsoidFrame, ellipsoidFrameInverse, ellipsoid } = this;

    // 取相机值。
    _forward.set(0, 0, 1).transformDirection(this.getCameraWorldMatrix());

    // 在椭球局部坐标系中设置射线。
    _ray.origin.copy(this.getCameraPosition());
    _ray.direction.copy(_forward);
    _ray.applyMatrix4(ellipsoidFrameInverse);

    // 取估计最近点。
    ellipsoid.closestPointToRayEstimate(_ray, _vec).applyMatrix4(ellipsoidFrame);

    // 未提供枢轴或该点更近时使用最近点。
    if (
      super.getPivotPoint(target) === null ||
      _pos.subVectors(target, _ray.origin).dot(_ray.direction) > _pos.subVectors(_vec, _ray.origin).dot(_ray.direction)
    ) {
      target.copy(_vec);
    }

    return target;
  }

  /** 相机指向椭球中心的向量。 */
  public getVectorToCenter(target: Vector3): Vector3 {
    const { ellipsoidFrame } = this;
    return target.setFromMatrixPosition(ellipsoidFrame).sub(this.getCameraPosition());
  }

  /** 相机到椭球中心的距离。 */
  public getDistanceToCenter(): number {
    return this.getVectorToCenter(_vec).length;
  }

  /** 世界空间某点的本地 up 方向（WGS84 椭球法线）。 */
  public override getUpDirection(point: Vector3, target: Vector3): void {
    const { ellipsoidFrame, ellipsoidFrameInverse, ellipsoid } = this;
    _vec.copy(point).applyMatrix4(ellipsoidFrameInverse);
    ellipsoid.getPositionToNormal(_vec, target);
    target.transformDirection(ellipsoidFrame);
  }

  public override getCameraUpDirection(target: Vector3): void {
    this.getUpDirection(this.getCameraPosition(), target);
  }

  public override update(deltaTime: number = Math.min(this._getDeltaTime(), 64 / 1000)): void {
    ensureScratchMatrices();
    if (!this.enabled || !this.camera || deltaTime === 0) return;

    const { camera } = this;

    // 调试:黑屏检测(相机朝向偏离地球时告警)。关闭 debug 时 debugLog 为
    // null,此分支完全不执行,不产生任何数学计算。
    if (this.debugLog) {
      const pos = this.getCameraPosition();
      const f = _debugForward.set(0, 0, 1).transformDirection(this.getCameraWorldMatrix());
      this.debugLog.checkBlackScreen(pos, f);
    }

    // 过渡阈值之外时，移动相机过程中切换重定向行为。
    if (this._isNearControls()) {
      this.scaleZoomOrientationAtEdges = this.zoomDelta < 0;
    } else {
      if (this.state !== NONE && this._dragMode !== 1 && this._rotationMode !== 1) {
        this.setPivotMeshVisible(false);
      }
      this.scaleZoomOrientationAtEdges = false;
    }

    const adjustCameraRotation = this.needsUpdate || this._inertiaNeedsUpdate();

    // 基础控制更新。
    super.update(deltaTime);

    // 更新相机裁剪面。
    this.adjustCamera(camera);

    // 相机更新后对齐相机 up 向量。
    if (adjustCameraRotation && (this._isNearControls() || this.state === FREE_ROTATE)) {
      this.getCameraUpDirection(_globalUp);
      this._alignCameraUp(_globalUp, 1);
      this.getCameraUpDirection(_globalUp);
      this._clampRotation(_globalUp);
    }
  }

  /**
   * 更新相机 near/far 裁剪面（3d-tiles 原版自适应逻辑，透视分支）：
   *  - near：距地表 25% 半径余量内从 1 插值到 1000——高空避免近平面过近造成
   *    瓦片间 z-fight，贴地时贴近地表；
   *  - far：取地平线距离——近距时 far≈500km，比固定 1e8 的 log 深度精度好约
   *    200 倍（log 编码只依赖 far），裙边/缝隙 z-fight 大幅减少。
   * 曾因 fork 的 zPrePass 线性深度 vs 颜色通道 log frag_depth 编码不匹配导致
   * 近距片段被全拒（黑屏）而改用固定裁剪面；示例现以 zPrePass=false 运行
   * （颜色通道自写自比 log 深度），动态 near/far 恢复生效。
   */
  public override adjustCamera(camera: Camera3D): void {
    ensureScratchMatrices();
    super.adjustCamera(camera);

    const { ellipsoidFrame, ellipsoidFrameInverse, ellipsoid, nearMargin, farMargin } = this;
    const maxRadius = this._getMaxWorldRadius();
    const distanceToCenter = _vec.setFromMatrixPosition(ellipsoidFrame).sub(this.getCameraPosition()).length;
    const margin = nearMargin * maxRadius;
    const alpha = clamp((distanceToCenter - maxRadius) / margin, 0, 1);
    const minNear = lerp(1, 1000, alpha);
    camera.near = Math.max(minNear, distanceToCenter - maxRadius - margin);

    _pos.copy(this.getCameraPosition()).applyMatrix4(ellipsoidFrameInverse);
    ellipsoid.getPositionToCartographic(_pos, _latLon);
    const elevation = Math.max(ellipsoid.getPositionElevation(_pos), MIN_ELEVATION);
    // getPositionToCartographic 返回弧度，calculateHorizonDistance 要求度。
    const horizonDistance = ellipsoid.calculateHorizonDistance(_latLon.lat * RAD2DEG, elevation);
    camera.far = horizonDistance + 0.1 + maxRadius * farMargin;
    camera.updateProjection();
  }

  // 重置“卡住”的拖拽模式。
  public override setState(state: number = this.state, fireEvent = true): void {
    super.setState(state, fireEvent);
    this._dragMode = 0;
    this._rotationMode = 0;
  }

  public override _updateInertia(deltaTime: number): void {
    ensureScratchMatrices();
    super._updateInertia(deltaTime);

    const {
      globeInertia,
      enableDamping,
      dampingFactor,
      minDistance,
      inertiaTargetDistance,
      ellipsoidFrame,
    } = this;

    const camera = this.camera!;
    if (!this.enableDamping || this.inertiaStableFrames > 1) {
      this.globeInertiaFactor = 0;
      this.globeInertia.set(0, 0, 0, 1);
      return;
    }

    const factor = Math.pow(2, -deltaTime / dampingFactor);
    const stableDistance = Math.max(camera.near, minDistance, inertiaTargetDistance);
    const resolution = 2 * 1e3;
    const pixelWidth = 2 / resolution;
    const pixelThreshold = 0.25 * pixelWidth;

    _center.setFromMatrixPosition(ellipsoidFrame);

    if (this.globeInertiaFactor !== 0) {
      // 在虚拟分辨率下计算相隔 1 像素的两个屏幕点，投影到世界空间，
      // 以便在增量约为 1 像素时停止。
      setRayFromCamera(_ray, _vec.set(0, 0, -1), camera);
      _invMatrix.copy(this.getCameraWorldMatrix()).invert();
      _ray.applyMatrix4(_invMatrix);
      _ray.direction.normalize();
      _ray.recast(-_ray.direction.dot(_ray.origin)).at(stableDistance / _ray.direction.z, _vec);
      _vec.applyMatrix4(this.getCameraWorldMatrix());

      setRayFromCamera(_ray, _pos.set(pixelThreshold, pixelThreshold, -1), camera);
      _invMatrix.copy(this.getCameraWorldMatrix()).invert();
      _ray.applyMatrix4(_invMatrix);
      _ray.direction.normalize();
      _ray.recast(-_ray.direction.dot(_ray.origin)).at(stableDistance / _ray.direction.z, _pos);
      _pos.applyMatrix4(this.getCameraWorldMatrix());

      // 计算隐含角度。
      _vec.sub(_center).normalize();
      _pos.sub(_center).normalize();

      this.globeInertiaFactor *= factor;
      const threshold = _vec.angleTo(_pos) / deltaTime;
      const globeAngle = 2 * Math.acos(globeInertia.w) * this.globeInertiaFactor;
      if (globeAngle < threshold || !enableDamping) {
        this.globeInertiaFactor = 0;
        globeInertia.set(0, 0, 0, 1);
      }
    }

    if (this.globeInertiaFactor !== 0) {
      // 若 xyz 非零而 w 为一，则确保 w 不是一以便继续动画。
      if (globeInertia.w === 1 && (globeInertia.x !== 0 || globeInertia.y !== 0 || globeInertia.z !== 0)) {
        globeInertia.w = Math.min(globeInertia.w, 1 - 1e-9);
      }

      // 构造旋转矩阵。
      _center.setFromMatrixPosition(ellipsoidFrame);
      _quaternion.set(0, 0, 0, 1);
      _quaternion.slerp(Quaternion.identity(), globeInertia, this.globeInertiaFactor * deltaTime);
      makeRotateAroundPoint(_center, _quaternion, _rotMatrix);

      // 应用旋转。
      this.applyCameraMatrixFrom(_rotMatrix);
    }
  }

  public override _inertiaNeedsUpdate(): boolean {
    return super._inertiaNeedsUpdate() || this.globeInertiaFactor !== 0;
  }

  public override _getFlightSpeedScale(): number {
    // 速度随高度等比缩放，任何距离下手感一致；1000 m 下限防止贴地时移动过慢。
    const altitude = this.getDistanceToCenter() - this._getMaxWorldRadius();
    return 2 * Math.max(altitude, 1000);
  }

  public override _updateFlight(deltaTime: number): boolean {
    ensureScratchMatrices();
    const didFly = super._updateFlight(deltaTime);
    if (didFly) {
      // 防止飞过“地球过小”的距离，与鼠标缩放一致。
      const maxDistance = this._getMaxPerspectiveDistance();
      const distToCenter = this.getDistanceToCenter();
      if (distToCenter > maxDistance) {
        this.getVectorToCenter(_vec).normalize();
        this.getCameraPosition().addScaledVector(_vec, distToCenter - maxDistance);
        this.getCameraTransform().notifyLocalChange();
        this.getCameraTransform().updateWorldMatrix();
      }

      // 近控制区之外（高空/太空视角）时，轻推相机保持地球居中、地平线水平，
      // 与同距离滚轮缩放行为一致。alpha 从过渡阈值处的 0 线性增长到 maxDistance 处满值。
      if (!this._isNearControls()) {
        const distanceAlpha = clamp(
          mapLinear(this.getDistanceToCenter(), this._getPerspectiveTransitionDistance(), maxDistance, 0, 1),
          0, 1,
        );
        this._tiltTowardsCenter(0.02 * distanceAlpha);
        this._alignCameraUpToNorth(0.01 * distanceAlpha);
      }
    }
    return didFly;
  }

  // 拖拽：在椭球局部球面上旋转相机。
  public override _updatePosition(deltaTime: number): void {
    ensureScratchMatrices();
    if (this.state === DRAG) {
      // 保存拖拽模式状态，便于在 update 中更新枢轴指示器。
      if (this._dragMode === 0) {
        this._dragMode = this._isNearControls() ? 1 : -1;
      }

      const {
        pointerTracker,
        pivotPoint,
        ellipsoidFrame,
        ellipsoidFrameInverse,
      } = this;
      const camera = this.camera!;
      const domElement = this.domElement!;

      // 复用缓存变量。
      const pivotDir = _pos;
      const newPivotDir = _targetRight;

      // 取指针与射线。
      pointerTracker.getCenterPoint(_pointer);
      adjustedPointerToCoords(_pointer, domElement, _pointer);
      setRayFromCamera(_ray, _pointer, camera);

      // 变换到椭球坐标系。
      _ray.applyMatrix4(ellipsoidFrameInverse);

      // 构造与地球等半径的球，使拖拽位置与初次点击一致。
      const pivotRadius = _vec.copy(pivotPoint).applyMatrix4(ellipsoidFrameInverse).length;
      _ellipsoid.radius.setScalar(pivotRadius);

      // 拖出球面时结束操作并沿惯性继续。
      if (!_ellipsoid.intersectRay(_ray, _vec)) {
        this.resetState();
        this._updateInertia(deltaTime);
        return;
      }

      _vec.applyMatrix4(ellipsoidFrame);

      // 取两点方向。
      _center.setFromMatrixPosition(ellipsoidFrame);
      pivotDir.subVectors(pivotPoint, _center).normalize();
      newPivotDir.subVectors(_vec, _center).normalize();

      // 构造旋转。
      _quaternion.setFromUnitVectors(newPivotDir, pivotDir);
      makeRotateAroundPoint(_center, _quaternion, _rotMatrix);

      // 应用旋转。
      this.applyCameraMatrixFrom(_rotMatrix);

      // 调试:左键拖拽步进量(四元数/枢轴/相机位置)。惰性求值,关闭时零开销。
      this.debugLog?.steps(() => {
        const pos = this.getCameraPosition();
        const q = _quaternion;
        return (
          `[CTRL] drag q=(${q.x.toFixed(3)},${q.y.toFixed(3)},${q.z.toFixed(3)},${q.w.toFixed(3)})` +
          ` pivot=(${pivotPoint.x.toFixed(0)},${pivotPoint.y.toFixed(0)},${pivotPoint.z.toFixed(0)})` +
          ` pos=(${pos.x.toFixed(0)},${pos.y.toFixed(0)},${pos.z.toFixed(0)})`
        );
      });

      if (pointerTracker.getMoveDistance() / deltaTime < 2 * window.devicePixelRatio) {
        this.inertiaStableFrames++;
      } else {
        this.globeInertia.copy(_quaternion);
        this.globeInertiaFactor = 1 / deltaTime;
        this.inertiaStableFrames = 0;
      }
    }
  }

  // 过渡区之外禁用旋转。
  public override _updateRotation(deltaTime: number): void {
    // FREE_ROTATE 无论距离地球远近都允许。
    if (this.state === FREE_ROTATE) {
      super._updateRotation(deltaTime);
      return;
    }

    if (this._rotationMode === 1 || this._isNearControls()) {
      this._rotationMode = 1;
      super._updateRotation(deltaTime);
    } else {
      this.setPivotMeshVisible(false);
      this._rotationMode = -1;
    }
  }

  public override _updateZoom(): void {
    ensureScratchMatrices();
    const { zoomDelta, zoomSpeed, zoomPoint, state } = this;

    if (state !== ZOOM && zoomDelta === 0) return;

    // 重置动量。
    this.rotationInertia.set(0, 0);
    this.dragInertia.set(0, 0, 0);
    this.globeInertia.set(0, 0, 0, 1);
    this.globeInertiaFactor = 0;

    // 根据缩放强度缩放倾斜过渡。
    const deltaAlpha = clamp(mapLinear(Math.abs(zoomDelta), 0, 20, 0, 1), 0, 1);

    if (this._isNearControls() || zoomDelta > 0) {
      this._updateZoomDirection();

      // 缩放时向行星中心倾斜相机，避免从地平线拉远时地球旋转。
      if (zoomDelta < 0 && (this.zoomPointSet || this._updateZoomPoint())) {
        // 取前向向量与指向椭球中心的向量。
        _forward.set(0, 0, 1).transformDirection(this.getCameraWorldMatrix()).normalize();
        _toCenter.copy(this.up).multiplyScalar(-1);

        // 根据鼠标相对地平线的位置与当前倾斜度计算倾斜量 alpha。
        this.getUpDirection(zoomPoint, _zoomPointUp);
        const upAlpha = clamp(mapLinear(-_zoomPointUp.dot(_toCenter), 1, 0.95, 0, 1), 0, 1);
        const forwardAlpha = 1 - _forward.dot(_toCenter);
        const cameraAlpha = 1; // 原版 ortho 相机为 0.05，本移植仅透视。
        const adjustedDeltaAlpha = clamp(deltaAlpha * 3, 0, 1);

        // 应用缩放。
        const alpha = Math.min(upAlpha * forwardAlpha * cameraAlpha * adjustedDeltaAlpha, 0.1);
        _toCenter.lerpVectors(_forward, _toCenter, alpha).normalize();

        // 执行旋转。
        _quaternion.setFromUnitVectors(_forward, _toCenter);
        makeRotateAroundPoint(zoomPoint, _quaternion, _rotMatrix);
        this.applyCameraMatrixFrom(_rotMatrix);

        // 更新缩放方向。
        this.zoomDirection.subVectors(zoomPoint, this.getCameraPosition()).normalize();
      }

      super._updateZoom();
    } else {
      // 缩放时让相机对准地球。
      const transitionDistance = this._getPerspectiveTransitionDistance();
      const maxDistance = this._getMaxPerspectiveDistance();
      const distanceAlpha = mapLinear(this.getDistanceToCenter(), transitionDistance, maxDistance, 0, 1);
      this._tiltTowardsCenter(lerp(0, 0.4, distanceAlpha * deltaAlpha));
      this._alignCameraUpToNorth(lerp(0, 0.2, distanceAlpha * deltaAlpha));

      // 判空：指针射线未命中地球（指向太空/地平线外）时不移动相机——高空
      // 拉远时地球在画面中占比很小，没拾取到就不该继续缩放。
      this._updateZoomDirection();
      if (this.zoomPointSet || this._updateZoomPoint()) {
        // 以与环境控制类似的方式计算缩放，保证缩放速度可比。
        const dist = this.getDistanceToCenter() - this._getMaxWorldRadius();
        const scale = zoomDelta * dist * zoomSpeed * 0.0025;
        // zoom-out 下限：不超过 maxDistance；zoom-in 上限：不越过地表
        // （minDistance 余量）。防快速滚动/动量缩放一帧把相机甩过地球。
        const surfaceDist = this.getDistanceToCenter() - this._getMaxWorldRadius() - this.minDistance;
        const clampedScale = Math.max(
          Math.min(scale, surfaceDist),
          Math.min(this.getDistanceToCenter() - maxDistance, 0),
        );

        // 直接沿球心方向缩放。
        this.getVectorToCenter(_vec).normalize();
        this.getCameraPosition().addScaledVector(_vec, clampedScale);
        this.getCameraTransform().notifyLocalChange();
        this.getCameraTransform().updateWorldMatrix();

        // 调试:远区分支缩放步进量。惰性求值,关闭时零开销。
        this.debugLog?.steps(() => {
          const pos = this.getCameraPosition();
          const f = new Vector3(0, 0, 1).transformDirection(this.getCameraWorldMatrix());
          return (
            `[CTRL] zoomFar scale=${clampedScale.toFixed(0)} hit=(${zoomPoint.x.toFixed(0)},${zoomPoint.y.toFixed(0)},${zoomPoint.z.toFixed(0)})` +
            ` uv=${uvOf(zoomPoint)} fwd=${fwdDotEarth(pos, f).toFixed(3)}` +
            ` pos=(${pos.x.toFixed(0)},${pos.y.toFixed(0)},${pos.z.toFixed(0)})`
          );
        });
      } else {
        // 调试:远区分支未命中(判空,不移动)。
        this.debugLog?.steps(() => '[CTRL] zoomFar noHit (不移动)');
      }

      this.zoomDelta = 0;
    }
  }

  // 倾斜相机对齐北极。
  private _alignCameraUpToNorth(alpha: number): void {
    const { ellipsoidFrame } = this;
    _globalUp.set(0, 0, 1).transformDirection(ellipsoidFrame);
    this._alignCameraUp(_globalUp, alpha);
  }

  // 倾斜相机看向地球中心。
  private _tiltTowardsCenter(alpha: number): void {
    ensureScratchMatrices();
    const { ellipsoidFrame } = this;

    _forward.set(0, 0, 1).transformDirection(this.getCameraWorldMatrix()).normalize();
    _vec.setFromMatrixPosition(ellipsoidFrame).sub(this.getCameraPosition()).normalize();
    _vec.lerp(_vec, _forward, 1 - alpha);
    _vec.normalize();

    _quaternion.setFromUnitVectors(_forward, _vec);
    this.getCameraTransform().localRotQuat.premultiply(_quaternion);
    this.getCameraTransform().notifyLocalChange();
    this.getCameraTransform().updateWorldMatrix();
  }

  // 透视相机基于地球尺寸与 fov 的过渡距离。
  private _getPerspectiveTransitionDistance(): number {
    ensureScratchMatrices();
    const camera = this.camera!;
    // 最小 fov 覆盖椭球的 65% 时进入近控制区。
    const ellipsoidRadius = this._getMaxWorldRadius();
    const fovHoriz = 2 * Math.atan(Math.tan((camera.fov * Math.PI / 180) * 0.5) * camera.aspect);
    const distVert = ellipsoidRadius / Math.tan((camera.fov * Math.PI / 180) * 0.5);
    const distHoriz = ellipsoidRadius / Math.tan(fovHoriz * 0.5);
    return Math.max(distVert, distHoriz);
  }

  // 透视相机基于地球尺寸与 fov 的最大距离。
  private _getMaxPerspectiveDistance(): number {
    ensureScratchMatrices();
    const camera = this.camera!;
    // 允许拉远到椭球占最大 fov 一半大小。
    const ellipsoidRadius = this._getMaxWorldRadius();
    const fovHoriz = 2 * Math.atan(Math.tan((camera.fov * Math.PI / 180) * 0.5) * camera.aspect);
    const distVert = ellipsoidRadius / Math.tan((camera.fov * Math.PI / 180) * 0.5);
    const distHoriz = ellipsoidRadius / Math.tan(fovHoriz * 0.5);
    return 2 * Math.max(distVert, distHoriz);
  }

  private _isNearControls(): boolean {
    return this.getDistanceToCenter() < this._getPerspectiveTransitionDistance();
  }

  public override _raycast(ray: Ray): { point: Vector3; distance: number } | null {
    ensureScratchMatrices();
    const result = super._raycast(ray);
    if (result === null) {
      // 场景未命中时回退到椭球相交。
      const { ellipsoid, ellipsoidFrame, ellipsoidFrameInverse } = this;
      _ray.copy(ray).applyMatrix4(ellipsoidFrameInverse);

      const point = ellipsoid.intersectRay(_ray, _vec);
      if (point !== null) {
        point.applyMatrix4(ellipsoidFrame);
        return { point: point.clone(), distance: point.distanceTo(ray.origin) };
      }
      return null;
    }
    return result;
  }

  private _getMaxWorldRadius(): number {
    ensureScratchMatrices();
    const { ellipsoid, ellipsoidFrame } = this;
    return Math.max(ellipsoid.radius.x, ellipsoid.radius.y, ellipsoid.radius.z) * ellipsoidFrame.getMaxScaleOnAxis();
  }

  /** 世界矩阵左乘旋转矩阵后分解回写相机（等价于原版 matrixWorld.premultiply + decompose）。 */
  private applyCameraMatrixFrom(rotMatrix: Matrix4): void {
    ensureScratchMatrices();
    _cameraMatrixLocal.copy(this.getCameraWorldMatrix()).premultiply(rotMatrix);
    this.applyCameraMatrix(_cameraMatrixLocal);
  }
}
