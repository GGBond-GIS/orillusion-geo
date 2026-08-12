import { Camera3D, ColliderComponent, Color, ComponentBase, Matrix4, MeshRenderer, Object3D, PlaneGeometry, Quaternion, Ray as EngineRay, UnLitMaterial, Vector2, Vector3 } from '@orillusion/core';
import { PointerTracker } from './PointerTracker.js';
import { Plane } from './Plane.js';
import { Ray } from './Ray.js';
import { adjustedPointerToCoords, clamp, decomposeMatrix4, makeRotateAroundPoint, mapLinear, RAD2DEG, setRayFromCamera } from './controlsUtils.js';

export const NONE = 0;
export const DRAG = 1;
export const ROTATE = 2;
export const ZOOM = 3;
export const WAITING = 4;
export const FREE_ROTATE = 5;

const DRAG_PLANE_THRESHOLD = 0.05;
const DRAG_UP_THRESHOLD = 0.025;

let _rotMatrix!: Matrix4;
// Matrix4 依赖 Engine3D.init 之后的全局矩阵池，模块级创建会在 init 前崩溃；
// 所有 scratch 矩阵延迟到首次使用时创建。
function ensureScratchMatrices(): void {
  if (_rotMatrix) return;
  _rotMatrix = new Matrix4();
  _invMatrix = new Matrix4();
  _cameraMatrix = new Matrix4();
}

let _invMatrix!: Matrix4;
const _delta = new Vector3();
const _vec = new Vector3();
const _pos = new Vector3();
const _center = new Vector3();
const _forward = new Vector3();
const _right = new Vector3();
const _targetRight = new Vector3();
const _rotationAxis = new Vector3();
const _quaternion = new Quaternion();
const _plane = new Plane();
const _localUp = new Vector3();
const _identityQuat = new Quaternion();
const _ray = new Ray();
const _flightDir = new Vector3();
let _cameraMatrix!: Matrix4;
const _engineRay = new EngineRay(new Vector3(), new Vector3());

const _pointer = new Vector2();
const _screenCenter = new Vector2();
const _prevPointer = new Vector2();
const _deltaPointer = new Vector2();
const _centerPoint = new Vector2();
const _startCenterPoint = new Vector2();

const _changeEvent = { type: 'change' };
const _startEvent = { type: 'start' };
const _endEvent = { type: 'end' };

/** EnvironmentControls 初始化参数（原版构造函数 (scene, camera, domElement) 的 ECS 等价物）。 */
export interface EnvironmentControlsOptions {
  camera: Camera3D;
  domElement: HTMLElement;
  /** 可选：three.js 约定的相机骨架（见 cameraRig）。 */
  rig?: Object3D;
  scene?: Object3D;
  minDistance?: number;
  maxDistance?: number;
  rotationSpeed?: number;
  minAltitude?: number;
  maxAltitude?: number;
  zoomSpeed?: number;
  minZoom?: number;
  maxZoom?: number;
  useFallbackPlane?: boolean;
  fallbackPlane?: Plane;
  enableDamping?: boolean;
  dampingFactor?: number;
  enableFlight?: boolean;
  flightSpeed?: number;
  flightSpeedMultiplier?: number;
  autoAdjustCameraRotation?: boolean;
  scaleZoomOrientationAtEdges?: boolean;
  enabled?: boolean;
}

/**
 * EnvironmentControls 的 Orillusion 移植，1:1 复刻自 3d-tiles-renderer
 * `src/three/renderer/controls/EnvironmentControls.js`（0.5.1）。
 *
 * 与原版的差异（均为有意为之）：
 *  - 去掉相机体积碰撞：`cameraRadius` / `adjustHeight` / `_getPointBelowCamera`
 *    以及 update() / adjustCamera() 里的“下方射线命中则推高相机”逻辑；
 *  - 透视相机专用（Orillusion Camera3D 无 ortho 的 zoom/top/bottom 语义）；
 *  - 场景射线由引擎 ColliderComponent（MeshColliderShape）提供，`scene` 缺省
 *    为 null 时仅用椭球面（EllipsoidTerrainProvider 的地形就是椭球面）；
 *  - 相机矩阵操作通过 Object3D.transform 的 local* 属性完成（Orillusion
 *    数学库与 three.js 对齐，worldMatrix 读取时自动从 local 重算）。
 */
export class EnvironmentControls extends ComponentBase {
  public isEnvironmentControls = true;

  public domElement: HTMLElement | null = null;
  public camera: Camera3D | null = null;
  public scene: Object3D | null = null;

  // settings
  private _enabled = true;
  public rotationSpeed = 1;
  public minAltitude = 0;
  // 上拖最多与地面平行（π/2）。原版 3d-tiles 默认 0.45π（地平线下 9°），
  // 会让贴地/地平线视角的拖拽与缩放被夹取弹回（用户要求放宽）。
  public maxAltitude = 0.5 * Math.PI;
  public minDistance = 10;
  public maxDistance = Infinity;
  public minZoom = 0;
  public maxZoom = Infinity;
  public zoomSpeed = 1;
  public enableDamping = false;
  public dampingFactor = 0.15;
  public fallbackPlane = new Plane(new Vector3(0, 1, 0), 0);
  public useFallbackPlane = true;
  public enableFlight = false;
  public flightSpeed = 10;
  public flightSpeedMultiplier = 4;

  // settings for GlobeControls
  public scaleZoomOrientationAtEdges = false;
  public autoAdjustCameraRotation = true;

  // internal state
  public state = NONE;
  public pointerTracker = new PointerTracker();
  public needsUpdate = false;

  public pivotPoint = new Vector3();
  public pivotMesh: Object3D | null = null;

  // used for zoom
  public zoomDirectionSet = false;
  public zoomPointSet = false;
  public zoomDirection = new Vector3();
  public zoomPoint = new Vector3();
  public zoomDelta = 0;

  // fields used for inertia
  public rotationInertiaPivot = new Vector3();
  public rotationInertia = new Vector2();
  public dragInertia = new Vector3();
  /** 用于计算惯性停止阈值的相机目标距离。 */
  public inertiaTargetDistance = Infinity;
  /** 用户交互时相机未移动的帧数。 */
  public inertiaStableFrames = 0;

  public up = new Vector3(0, 1, 0);
  private _lastTime = performance.now();
  private _keysDown = new Set<string>();
  private _detachCallback: (() => void) | null = null;
  private _upInitialized = false;
  private _lastUsedState = NONE;
  private _zoomPointWasSet = false;
  private readonly _listeners: Record<string, Array<(event: { type: string }) => void>> = {};

  // ---- ECS 生命周期 ----

  public override init(options: EnvironmentControlsOptions): void {
    this.camera = options.camera;
    this.domElement = options.domElement;
    if (options.rig !== undefined) this.cameraRig = options.rig;
    if (options.scene !== undefined) this.scene = options.scene;
    if (options.minDistance !== undefined) this.minDistance = options.minDistance;
    if (options.maxDistance !== undefined) this.maxDistance = options.maxDistance;
    if (options.rotationSpeed !== undefined) this.rotationSpeed = options.rotationSpeed;
    if (options.minAltitude !== undefined) this.minAltitude = options.minAltitude;
    if (options.maxAltitude !== undefined) this.maxAltitude = options.maxAltitude;
    if (options.zoomSpeed !== undefined) this.zoomSpeed = options.zoomSpeed;
    if (options.minZoom !== undefined) this.minZoom = options.minZoom;
    if (options.maxZoom !== undefined) this.maxZoom = options.maxZoom;
    if (options.useFallbackPlane !== undefined) this.useFallbackPlane = options.useFallbackPlane;
    if (options.fallbackPlane !== undefined) this.fallbackPlane = options.fallbackPlane;
    if (options.enableDamping !== undefined) this.enableDamping = options.enableDamping;
    if (options.dampingFactor !== undefined) this.dampingFactor = options.dampingFactor;
    if (options.enableFlight !== undefined) this.enableFlight = options.enableFlight;
    if (options.flightSpeed !== undefined) this.flightSpeed = options.flightSpeed;
    if (options.flightSpeedMultiplier !== undefined) this.flightSpeedMultiplier = options.flightSpeedMultiplier;
    if (options.autoAdjustCameraRotation !== undefined) this.autoAdjustCameraRotation = options.autoAdjustCameraRotation;
    if (options.scaleZoomOrientationAtEdges !== undefined) this.scaleZoomOrientationAtEdges = options.scaleZoomOrientationAtEdges;
    if (options.enabled !== undefined) this.enabled = options.enabled;

    // 等价于原版构造函数里的 init 段。
    if (this.domElement && !this._detachCallback) this.attach(this.domElement);
    if (this.camera) this.setCamera(this.camera);
    if (this.scene) this.setScene(this.scene);
  }

  public override onEnable(): void {
    // 与 3d-tiles-renderer 的用法一致：挂载后无需额外动作，update 由 onUpdate 驱动。
  }

  public override onUpdate(): void {
    this.update();
  }

  public override beforeDestroy(): void {
    this.dispose();
  }

  // ---- 事件（原版 EventDispatcher 的最小等价物） ----

  public addEventListener(type: string, callback: (event: { type: string }) => void): void {
    (this._listeners[type] ??= []).push(callback);
  }

  public removeEventListener(type: string, callback: (event: { type: string }) => void): void {
    const list = this._listeners[type];
    if (!list) return;
    const index = list.indexOf(callback);
    if (index >= 0) list.splice(index, 1);
  }

  public dispatchEvent(event: { type: string }): void {
    const list = this._listeners[event.type];
    if (!list) return;
    for (const callback of [...list]) callback(event);
  }

  // ---- 公开 API ----

  public get enabled(): boolean {
    return this._enabled;
  }

  public set enabled(value: boolean) {
    if (value !== this.enabled) {
      this._enabled = value;
      this.resetState();
      this.pointerTracker.reset();
      if (!this.enabled) {
        this.dragInertia.set(0, 0, 0);
        this.rotationInertia.set(0, 0);
      }
    }
  }

  public setScene(scene: Object3D): void {
    this.scene = scene;
  }

  public setCamera(camera: Camera3D): void {
    this.camera = camera;
    this._upInitialized = false;
    this.zoomDirectionSet = false;
    this.zoomPointSet = false;
    this.needsUpdate = true;
    this.resetState();
  }

  public attach(domElement: HTMLElement): void {
    ensureScratchMatrices();
    // 以 _detachCallback 作为“已挂载”标志（init 会先赋 domElement 再调 attach）。
    if (this._detachCallback) {
      throw new Error('EnvironmentControls: Controls already attached to element');
    }

    this.domElement = domElement;
    this.pointerTracker.domElement = domElement;
    domElement.style.touchAction = 'none';

    // 确保元素可接收键盘焦点。
    if (!domElement.hasAttribute('tabindex')) {
      domElement.tabIndex = -1;
    }

    const contextMenuCallback = (event: Event): void => {
      if (!this.enabled) return;
      event.preventDefault();
    };

    const pointerdownCallback = (event: PointerEvent): void => {
      const {
        camera,
        up,
        pointerTracker,
        pivotPoint,
        enabled,
        enableFlight,
        _keysDown,
      } = this;

      if (!this.enabled || !camera) return;
      event.preventDefault();
      domElement.focus();

      pointerTracker.addPointer(event);
      this.needsUpdate = true;

      // 触摸指针数量过多时重置状态。
      if (pointerTracker.isPointerTouch()) {
        this.setPivotMeshVisible(false);
        if (pointerTracker.getPointerCount() === 0) {
          domElement.setPointerCapture(event.pointerId);
        } else if (pointerTracker.getPointerCount() > 2) {
          this.resetState();
          return;
        }
      }

      // 缩放与旋转的“指针”基于中心点。
      pointerTracker.getCenterPoint(_pointer);
      adjustedPointerToCoords(_pointer, domElement, _pointer);
      setRayFromCamera(_ray, _pointer, camera);

      // 用拖拽平面限制拖拽距离，防止过大的拖拽角。
      const dot = Math.abs(_ray.direction.dot(up));
      if (dot < DRAG_PLANE_THRESHOLD || dot < DRAG_UP_THRESHOLD) {
        return;
      }

      // 飞行模式下按住任意飞行键 + 点击 → 自由视角旋转。
      const anyFlightKey =
        _keysDown.has('w') || _keysDown.has('s') || _keysDown.has('a') || _keysDown.has('d') ||
        _keysDown.has('q') || _keysDown.has('e') ||
        _keysDown.has('arrowup') || _keysDown.has('arrowdown') ||
        _keysDown.has('arrowleft') || _keysDown.has('arrowright') ||
        _keysDown.has('shift');

      if (
        enableFlight && anyFlightKey &&
        !pointerTracker.isPointerTouch() &&
        (pointerTracker.isRightClicked() || pointerTracker.isLeftClicked())
      ) {
        pivotPoint.copy(this.getCameraPosition());
        this.setState(FREE_ROTATE);
        return;
      }

      // 求命中点。
      const hit = this._raycast(_ray);
      if (hit) {
        // 双指 / 右键 / shift+左键 → 旋转。
        if (
          pointerTracker.getPointerCount() === 2 ||
          pointerTracker.isRightClicked() ||
          (pointerTracker.isLeftClicked() && event.shiftKey)
        ) {
          // 绕点旋转的绕点 = 屏幕中心点（相机视线与椭球/场景的交点，即
          // GlobeControls.getPivotPoint 的中心逻辑），而不是鼠标按下点——
          // 否则在非屏幕中心处按下时，轨道绕屏幕边缘的点转，视角会闪动/漂移；
          // 中心点配合 _alignCameraUp/_clampRotation 的固定点补偿，旋转全程
          // 把屏幕中心锁死在视野中央（Cesium target 同款手感）。
          setRayFromCamera(_ray, _screenCenter, camera);
          const centerHit = this._raycast(_ray);
          const rotatePoint = centerHit ? centerHit.point : hit.point;
          pivotPoint.copy(rotatePoint);
          this.placePivotMesh(rotatePoint, pointerTracker.isPointerTouch() ? false : enabled);
          this.setState(pointerTracker.isPointerTouch() ? WAITING : ROTATE);
        } else if (pointerTracker.isLeftClicked()) {
          pivotPoint.copy(hit.point);
          this.placePivotMesh(hit.point, false);
          this.setState(DRAG);
        }
      }
    };

    let _pointerMoveQueued = false;
    const pointermoveCallback = (event: PointerEvent): void => {
      const { pointerTracker } = this;
      if (!this.enabled) return;
      event.preventDefault();

      // 指针移动时重新推导缩放方向与缩放点。
      this.zoomDirectionSet = false;
      this.zoomPointSet = false;

      if (this.state !== NONE) {
        this.needsUpdate = true;
      }

      pointerTracker.setHoverEvent(event);
      if (!pointerTracker.updatePointer(event)) return;

      if (pointerTracker.isPointerTouch() && pointerTracker.getPointerCount() === 2) {
        // 排队处理，确保所有指针都已更新。
        if (!_pointerMoveQueued) {
          _pointerMoveQueued = true;
          queueMicrotask(() => {
            _pointerMoveQueued = false;

            pointerTracker.getCenterPoint(_centerPoint);

            // 检测缩放转换。
            const startDist = pointerTracker.getStartTouchPointerDistance();
            const pointerDist = pointerTracker.getTouchPointerDistance();
            const separateDelta = pointerDist - startDist;
            if (this.state === NONE || this.state === WAITING) {
              pointerTracker.getCenterPoint(_centerPoint);
              pointerTracker.getStartCenterPoint(_startCenterPoint);

              const dragThreshold = 2.0 * window.devicePixelRatio;
              const parallelDelta = _centerPoint.distanceTo(_startCenterPoint);
              if (Math.abs(separateDelta) > dragThreshold || parallelDelta > dragThreshold) {
                if (Math.abs(separateDelta) > parallelDelta) {
                  this.setState(ZOOM);
                  this.zoomDirectionSet = false;
                } else {
                  this.setState(ROTATE);
                }
              }
            }
            if (this.state === ZOOM) {
              const previousDist = pointerTracker.getPreviousTouchPointerDistance();
              this.zoomDelta += pointerDist - previousDist;
              this.setPivotMeshVisible(false);
            } else if (this.state === ROTATE) {
              this.setPivotMeshVisible(this.enabled);
            }
          });
        }
      }
      this.dispatchEvent(_changeEvent);
    };

    const pointerupCallback = (event: PointerEvent): void => {
      const { pointerTracker } = this;
      if (!this.enabled || pointerTracker.getPointerCount() === 0) return;

      pointerTracker.deletePointer(event);

      if (pointerTracker.getPointerType() === 'touch' && pointerTracker.getPointerCount() === 0) {
        domElement.releasePointerCapture(event.pointerId);
      }

      this.resetState();
      this.needsUpdate = true;
    };

    const wheelCallback = (event: WheelEvent): void => {
      if (!this.enabled) return;
      event.preventDefault();

      const { pointerTracker } = this;
      pointerTracker.setHoverEvent(event);
      pointerTracker.updatePointer(event as unknown as PointerEvent);

      this.dispatchEvent(_startEvent);

      let delta: number;
      switch (event.deltaMode) {
        case 2: delta = event.deltaY * 800; break; // Pages
        case 1: delta = event.deltaY * 40; break; // Lines
        default: delta = event.deltaY; break; // Pixels
      }

      // 用 LOG 缩放滚轮增量以跨平台归一化。
      const deltaSign = Math.sign(delta);
      const normalizedDelta = Math.abs(delta);
      this.zoomDelta -= 0.25 * deltaSign * normalizedDelta;
      this.needsUpdate = true;

      this._lastUsedState = ZOOM;
      this.dispatchEvent(_endEvent);
    };

    const pointerleaveCallback = (): void => {
      if (!this.enabled) return;
      this.resetState();
    };

    domElement.addEventListener('contextmenu', contextMenuCallback);
    domElement.addEventListener('pointerdown', pointerdownCallback);
    domElement.addEventListener('wheel', wheelCallback, { passive: false });

    // 在根节点注册移动事件，拖出其他元素时也能继续拖拽。
    const rootNode = domElement.getRootNode() as Document | ShadowRoot;
    rootNode.addEventListener('pointermove', pointermoveCallback as EventListener);
    rootNode.addEventListener('pointerup', pointerupCallback as EventListener);
    rootNode.addEventListener('pointerleave', pointerleaveCallback as EventListener);

    const keydownCallback = (event: KeyboardEvent): void => {
      const { _keysDown, state } = this;
      _keysDown.add(event.key.toLowerCase());

      const anyFlightKey =
        _keysDown.has('w') || _keysDown.has('s') || _keysDown.has('a') || _keysDown.has('d') ||
        _keysDown.has('q') || _keysDown.has('e') ||
        _keysDown.has('arrowup') || _keysDown.has('arrowdown') ||
        _keysDown.has('arrowleft') || _keysDown.has('arrowright');

      // 按下飞行键时重置当前动作（FREE_ROTATE 除外）。
      if (anyFlightKey && state !== FREE_ROTATE) {
        this.resetState();
      }
    };

    const keyupCallback = (event: KeyboardEvent): void => {
      this._keysDown.delete(event.key.toLowerCase());
    };

    const blurCallback = (): void => {
      this._keysDown.clear();
    };

    domElement.addEventListener('keydown', keydownCallback);
    window.addEventListener('keyup', keyupCallback);
    window.addEventListener('blur', blurCallback);

    this._detachCallback = () => {
      domElement.removeEventListener('contextmenu', contextMenuCallback);
      domElement.removeEventListener('pointerdown', pointerdownCallback);
      domElement.removeEventListener('wheel', wheelCallback);

      rootNode.removeEventListener('pointermove', pointermoveCallback as EventListener);
      rootNode.removeEventListener('pointerup', pointerupCallback as EventListener);
      rootNode.removeEventListener('pointerleave', pointerleaveCallback as EventListener);

      domElement.removeEventListener('keydown', keydownCallback);
      window.removeEventListener('keyup', keyupCallback);
      window.removeEventListener('blur', blurCallback);
    };
  }

  public detach(): void {
    this.domElement = null;
    if (this._detachCallback) {
      this._detachCallback();
      this._detachCallback = null;
      this.pointerTracker.reset();
    }
  }

  /** 世界空间某点的本地 up 方向。子类可覆写（如椭球法线）。 */
  public getUpDirection(_point: Vector3, target: Vector3): void {
    target.copy(this.up);
  }

  /** 相机当前位置的 up 方向。 */
  public getCameraUpDirection(target: Vector3): void {
    this.getUpDirection(this.getCameraPosition(), target);
  }

  /** 当前拖拽/旋转枢轴点；无有效枢轴时返回 null。 */
  public getPivotPoint(target: Vector3): Vector3 | null {
    ensureScratchMatrices();
    let result: Vector3 | null = null;

    // 取最后一次交互的点作为焦点。
    if (this._lastUsedState === ZOOM) {
      if (this._zoomPointWasSet) {
        result = target.copy(this.zoomPoint);
      }
    } else if (this._lastUsedState === ROTATE || this._lastUsedState === DRAG) {
      result = target.copy(this.pivotPoint);
    }

    // 最后使用的点若在相机视野之外则跳过。
    const { camera } = this;
    if (result !== null && camera) {
      const domElement = this.domElement;
      if (domElement) {
        camera.worldToScreenPoint(result, _vec);
        if (_vec.x < 0 || _vec.x > domElement.clientWidth || _vec.y < 0 || _vec.y > domElement.clientHeight) {
          result = null;
        }
      }
    }

    // 无结果或射线命中更近时，回退到屏幕中心射线命中点。
    if (camera) {
      setRayFromCamera(_ray, _screenCenter, camera);
      const hit = this._raycast(_ray);
      if (hit) {
        if (result === null || hit.distance < result.distanceTo(_ray.origin)) {
          result = target.copy(hit.point);
        }
      }
    }

    return result;
  }

  public resetState(): void {
    if (this.state !== NONE) {
      this.dispatchEvent(_endEvent);
    }
    this.state = NONE;
    this.pivotMesh?.removeFromParent();
    this.setPivotMeshVisible(this.enabled);
    this.pointerTracker.reset();
  }

  public setState(state: number = this.state, fireEvent = true): void {
    if (this.state === state) return;

    if (this.state === NONE && fireEvent) {
      this.dispatchEvent(_startEvent);
    }
    this.setPivotMeshVisible(this.enabled);
    this.dragInertia.set(0, 0, 0);
    this.rotationInertia.set(0, 0);
    this.inertiaStableFrames = 0;
    this.state = state;

    if (state !== NONE && state !== WAITING) {
      this._lastUsedState = state;
    }
  }

  public update(deltaTime: number = Math.min(this._getDeltaTime(), 64 / 1000)): void {
    ensureScratchMatrices();
    if (!this.enabled || !this.camera || deltaTime === 0) return;

    const {
      pivotPoint,
      state,
      autoAdjustCameraRotation,
    } = this;

    // 相机世界矩阵读取时自动从 local 重算（Orillusion Transform 语义）。

    // 立即设置 up 向量，供后续函数使用。
    this.getCameraUpDirection(_localUp);
    if (!this._upInitialized) {
      this._upInitialized = true;
      this.up.copy(_localUp);
    }

    // 场景动画/变化时每帧重推导缩放点。
    this.zoomPointSet = false;

    // 更新动作。
    const inertiaNeedsUpdate = this._inertiaNeedsUpdate();
    const adjustCameraRotation = this.needsUpdate || inertiaNeedsUpdate;
    if (this.needsUpdate || inertiaNeedsUpdate) {
      const zoomDelta = this.zoomDelta;

      this._updateZoom();
      this._updatePosition(deltaTime);
      this._updateRotation(deltaTime);

      if (state === DRAG || state === ROTATE || state === FREE_ROTATE) {
        _forward.set(0, 0, 1).transformDirection(this.getCameraWorldMatrix());
        this.inertiaTargetDistance = _vec.copy(pivotPoint).sub(this.getCameraPosition()).dot(_forward);
      } else if (state === NONE) {
        this._updateInertia(deltaTime);
      }

      if (state !== NONE || zoomDelta !== 0 || inertiaNeedsUpdate) {
        this.dispatchEvent(_changeEvent);
      }

      this.needsUpdate = false;
    }

    const didFly = this._updateFlight(deltaTime);
    if (didFly) {
      this.dragInertia.set(0, 0, 0);
      this.rotationInertia.set(0, 0);
      this.dispatchEvent(_changeEvent);
    }

    // 根据相机移动后的位置更新 up 方向。
    this.getCameraUpDirection(_localUp);
    this._setFrame(_localUp);

    if (this.pivotMesh?.parent) {
      const mesh = this.pivotMesh;
      mesh.transform.lookAt(this.getCameraPosition(), mesh.transform.worldPosition, this.up);
    }

    this.pointerTracker.updateFrame();

    // rig 模式下相机作为 rig 子对象且自身 local 固定不变，fork 的
    // updateChildTransform 只在子对象 localChange 时重算 world 矩阵，
    // 相机 world 会停留在陈旧位置导致渲染错位/黑屏——每帧强制同步。
    if (this.cameraRig) this.camera!.object3D.transform.updateWorldMatrix(true);

    if ((adjustCameraRotation && autoAdjustCameraRotation) || didFly) {
      this.getCameraUpDirection(_localUp);
      this._alignCameraUp(_localUp, 1);
      this.getCameraUpDirection(_localUp);
      this._clampRotation(_localUp);
    }
  }

  /**
   * 调整相机满足高度/距离约束。原版在此做相机高度碰撞调整
   * （cameraRadius / _getPointBelowCamera），本移植去掉了碰撞，
   * 该方法保留为子类覆写点（GlobeControls 用于 near/far 裁剪面）。
   */
  public adjustCamera(_camera: Camera3D): void {
    // 相机体积碰撞已按需求移除，此方法为空。
  }

  public dispose(): void {
    this.detach();
  }

  // ---- 私有实现 ----

  protected _getDeltaTime(): number {
    const current = performance.now();
    const delta = current - this._lastTime;
    this._lastTime = current;
    return delta * 1e-3;
  }

  /**
   * 相机骨架（可选）：Orillusion 相机前向为 +z，与 three.js（-z）相反。
   * 传入一个"还原成 three.js 约定"的外层 Object3D（相机作为其子对象带 180°
   * 内旋），控制器按 three.js 约定操作该骨架；缺省时直接操作相机对象本身。
   * 射线/投影数学始终使用相机自身（fork 渲染约定的标定不变）。
   */
  public cameraRig: Object3D | null = null;

  protected getCameraPosition(): Vector3 {
    return this.getCameraTransform().localPosition;
  }

  protected getCameraWorldMatrix(): Matrix4 {
    return this.getCameraTransform().worldMatrix;
  }

  protected getCameraTransform() {
    return this.cameraRig ? this.cameraRig.transform : this.camera!.object3D.transform;
  }

  /** 把模块级 _cameraMatrix 分解后写回相机 transform（等价于 three 的 decompose + updateMatrixWorld）。 */
  protected applyCameraMatrix(matrix: Matrix4): void {
    ensureScratchMatrices();
    const transform = this.camera!.object3D.transform;
    decomposeMatrix4(matrix, _pos, _quaternion, _vec);
    transform.localPosition = _pos;
    transform.localRotQuat = _quaternion;
    transform.localScale = _vec;
    transform.notifyLocalChange();
    transform.updateWorldMatrix();
  }

  private _pivotRenderer: MeshRenderer | null = null;

  /** 控制枢轴指示器的显隐（Object3D 无 enable，通过 MeshRenderer 控制）。 */
  protected setPivotMeshVisible(visible: boolean): void {
    if (this._pivotRenderer) this._pivotRenderer.enable = visible;
  }

  /** 枢轴指示器（原版 PivotPointMesh 的简化等价物：面向相机的半透明圆片）。 */
  private placePivotMesh(point: Vector3, visible: boolean): void {
    const scene = this.scene;
    if (!scene) return;
    if (!this.pivotMesh) {
      const context = this.camera?.object3D.transform.view3D?.engine3D?.context3D;
      if (!context) return;
      const object = new Object3D();
      object.name = 'GlobeControls Pivot';
      const renderer = object.addComponent(MeshRenderer);
      renderer.geometry = new PlaneGeometry(1, 1);
      const material = new UnLitMaterial(context);
      material.baseColor = new Color(1, 1, 1, 0.55);
      material.transparent = true;
      material.doubleSide = true;
      renderer.material = material;
      object.transform.localScale = new Vector3(0.25, 0.25, 0.25);
      this.pivotMesh = object;
      this._pivotRenderer = renderer;
    }
    this.pivotMesh.transform.localPosition = point;
    this.setPivotMeshVisible(visible);
    scene.addChild(this.pivotMesh);
  }

  protected _updateInertia(deltaTime: number): void {
    ensureScratchMatrices();
    const {
      rotationInertia,
      pivotPoint,
      dragInertia,
      enableDamping,
      dampingFactor,
      minDistance,
      inertiaTargetDistance,
    } = this;

    const camera = this.camera!;
    if (!this.enableDamping || this.inertiaStableFrames > 1) {
      dragInertia.set(0, 0, 0);
      rotationInertia.set(0, 0);
      return;
    }

    // 帧率无关的阻尼衰减（Freya Holmer）。
    const factor = Math.pow(2, -deltaTime / dampingFactor);
    const stableDistance = Math.max(camera.near, minDistance, inertiaTargetDistance);
    const resolution = 2 * 1e3;
    const pixelWidth = 2 / resolution;
    const pixelThreshold = 0.25 * pixelWidth;

    // 缩放残余旋转运动。
    if (rotationInertia.lengthSq() > 0) {
      setRayFromCamera(_ray, _vec.set(0, 0, -1), camera);
      _invMatrix.copy(this.getCameraWorldMatrix()).invert();
      _ray.applyMatrix4(_invMatrix);
      _ray.direction.normalize();
      _ray.recast(-_ray.direction.dot(_ray.origin)).at(stableDistance / _ray.direction.z, _vec);
      _vec.applyMatrix4(this.getCameraWorldMatrix());

      setRayFromCamera(_ray, _delta.set(pixelThreshold, pixelThreshold, -1), camera);
      _invMatrix.copy(this.getCameraWorldMatrix()).invert();
      _ray.applyMatrix4(_invMatrix);
      _ray.direction.normalize();
      _ray.recast(-_ray.direction.dot(_ray.origin)).at(stableDistance / _ray.direction.z, _delta);
      _delta.applyMatrix4(this.getCameraWorldMatrix());

      // 计算隐含角度。
      _vec.sub(pivotPoint).normalize();
      _delta.sub(pivotPoint).normalize();

      // 计算旋转阈值。
      const threshold = _vec.angleTo(_delta) / deltaTime;
      rotationInertia.multiplyScalar(factor);
      if (rotationInertia.lengthSq() < threshold ** 2 || !enableDamping) {
        rotationInertia.set(0, 0);
      }
    }

    // 缩放残余平移运动。
    if (dragInertia.lengthSq() > 0) {
      setRayFromCamera(_ray, _vec.set(0, 0, -1), camera);
      _invMatrix.copy(this.getCameraWorldMatrix()).invert();
      _ray.applyMatrix4(_invMatrix);
      _ray.direction.normalize();
      _ray.recast(-_ray.direction.dot(_ray.origin)).at(stableDistance / _ray.direction.z, _vec);
      _vec.applyMatrix4(this.getCameraWorldMatrix());

      setRayFromCamera(_ray, _delta.set(pixelThreshold, pixelThreshold, -1), camera);
      _invMatrix.copy(this.getCameraWorldMatrix()).invert();
      _ray.applyMatrix4(_invMatrix);
      _ray.direction.normalize();
      _ray.recast(-_ray.direction.dot(_ray.origin)).at(stableDistance / _ray.direction.z, _delta);
      _delta.applyMatrix4(this.getCameraWorldMatrix());

      // 计算移动阈值。
      const threshold = _vec.distanceTo(_delta) / deltaTime;
      dragInertia.multiplyScalar(factor);
      if (dragInertia.lengthSq() < threshold ** 2 || !enableDamping) {
        dragInertia.set(0, 0, 0);
      }
    }

    // 应用惯性变化。
    if (rotationInertia.lengthSq() > 0) {
      this._applyRotation(rotationInertia.x * deltaTime, rotationInertia.y * deltaTime, pivotPoint);
    }

    if (dragInertia.lengthSq() > 0) {
      this.getCameraPosition().addScaledVector(dragInertia, deltaTime);
      this.getCameraTransform().notifyLocalChange();
      this.getCameraTransform().updateWorldMatrix();
    }
  }

  protected _inertiaNeedsUpdate(): boolean {
    const { rotationInertia, dragInertia } = this;
    return rotationInertia.lengthSq() !== 0 || dragInertia.lengthSq() !== 0;
  }

  protected _getFlightSpeedScale(): number {
    return 1;
  }

  protected _updateFlight(deltaTime: number): boolean {
    ensureScratchMatrices();
    const {
      enableFlight,
      flightSpeed,
      flightSpeedMultiplier,
      _keysDown,
    } = this;

    if (!enableFlight) return false;

    // 取按键状态。
    const forward = _keysDown.has('w') || _keysDown.has('arrowup');
    const back = _keysDown.has('s') || _keysDown.has('arrowdown');
    const left = _keysDown.has('a') || _keysDown.has('arrowleft');
    const right = _keysDown.has('d') || _keysDown.has('arrowright');
    const up = _keysDown.has('q');
    const down = _keysDown.has('e');

    // 计算速度。
    const mult = _keysDown.has('shift') ? flightSpeedMultiplier : 1;
    const speed = mult * flightSpeed * this._getFlightSpeedScale() * deltaTime;

    // 计算方向。
    _flightDir.set(
      (right ? 1 : 0) - (left ? 1 : 0),
      (up ? 1 : 0) - (down ? 1 : 0),
      (back ? 1 : 0) - (forward ? 1 : 0),
    );

    // 无飞行方向时提前退出。
    if (_flightDir.lengthSq() === 0) return false;

    // 相对相机方向飞行。
    _flightDir.normalize().transformDirection(this.getCameraWorldMatrix());

    this.getCameraPosition().addScaledVector(_flightDir, speed);
    this.getCameraTransform().notifyLocalChange();
    this.getCameraTransform().updateWorldMatrix();

    return true;
  }

  protected _updateZoom(): void {
    ensureScratchMatrices();
    const {
      zoomPoint,
      zoomDirection,
      minDistance,
      maxDistance,
      pointerTracker,
      zoomSpeed,
      state,
    } = this;

    let scale = this.zoomDelta;
    this.zoomDelta = 0;

    // 取最新悬停/触摸点。
    if (!pointerTracker.getLatestPoint(_pointer) || (scale === 0 && state !== ZOOM)) return;

    // 重置动量。
    this.rotationInertia.set(0, 0);
    this.dragInertia.set(0, 0, 0);

    // 初始化缩放方向。
    this._updateZoomDirection();

    // 跟踪将要使用的缩放方向。
    const finalZoomDirection = _vec.copy(zoomDirection);

    if (this.zoomPointSet || this._updateZoomPoint()) {
      const dist = zoomPoint.distanceTo(this.getCameraPosition());

      // 根据剩余距离缩放缩放量。
      if (scale < 0) {
        const remainingDistance = Math.min(0, dist - maxDistance);
        scale = scale * dist * zoomSpeed * 0.0025;
        scale = Math.max(scale, remainingDistance);
      } else {
        const remainingDistance = Math.max(0, dist - minDistance);
        scale = scale * Math.max(dist - minDistance, 0) * zoomSpeed * 0.0025;
        scale = Math.min(scale, remainingDistance);
      }

      this.getCameraPosition().addScaledVector(zoomDirection, scale);
      this.getCameraTransform().notifyLocalChange();
      this.getCameraTransform().updateWorldMatrix();
    } else {
      // 没有命中任何东西时按缩放方向直接移动（原版的"按地面距离缩放"分支
      // 依赖 _getPointBelowCamera 相机碰撞逻辑，已随碰撞一并移除）。
      this.getCameraPosition().addScaledVector(finalZoomDirection, scale);
      this.getCameraTransform().notifyLocalChange();
      this.getCameraTransform().updateWorldMatrix();
    }
  }

  protected _updateZoomDirection(): void {
    ensureScratchMatrices();
    if (this.zoomDirectionSet) return;

    const { domElement, zoomDirection, pointerTracker } = this;
    const camera = this.camera;
    if (!domElement || !camera) return;
    pointerTracker.getLatestPoint(_pointer);
    adjustedPointerToCoords(_pointer, domElement, _pointer);
    setRayFromCamera(_ray, _pointer, camera);
    zoomDirection.copy(_ray.direction).normalize();
    this.zoomDirectionSet = true;
  }

  /** 基于缩放方向更新被缩放到的点。 */
  protected _updateZoomPoint(): boolean {
    ensureScratchMatrices();
    const {
      zoomDirectionSet,
      zoomDirection,
      zoomPoint,
    } = this;

    this._zoomPointWasSet = false;

    if (!zoomDirectionSet || !this.camera) return false;

    _ray.origin.copy(this.getCameraPosition());
    _ray.direction.copy(zoomDirection);

    // 求命中点。
    const hit = this._raycast(_ray);
    if (hit) {
      zoomPoint.copy(hit.point);
      this.zoomPointSet = true;
      this._zoomPointWasSet = true;
      return true;
    }

    return false;
  }

  // 更新拖拽动作。
  protected _updatePosition(deltaTime: number): void {
    ensureScratchMatrices();
    const {
      pivotPoint,
      up,
      pointerTracker,
      state,
      dragInertia,
    } = this;
    const camera = this.camera!;
    const domElement = this.domElement!;

    if (state === DRAG) {
      // 取指针与平面。
      pointerTracker.getCenterPoint(_pointer);
      adjustedPointerToCoords(_pointer, domElement, _pointer);

      _plane.setFromNormalAndCoplanarPoint(up, pivotPoint);
      setRayFromCamera(_ray, _pointer, camera);

      // 拖拽角过大时把射线方向压回平面法线附近的合理角度。
      if (Math.abs(_ray.direction.dot(up)) < DRAG_PLANE_THRESHOLD) {
        const angle = Math.acos(DRAG_PLANE_THRESHOLD);
        _rotationAxis.crossVectors(_ray.direction, up).normalize();
        _ray.direction.copy(up).applyAxisAngle(_rotationAxis, angle).multiplyScalar(-1);
      }

      // 拖到地球边缘附近时防止环绕导致意外旋转。
      this.getUpDirection(pivotPoint, _localUp);
      if (Math.abs(_ray.direction.dot(_localUp)) < DRAG_UP_THRESHOLD) {
        const angle = Math.acos(DRAG_UP_THRESHOLD);
        _rotationAxis.crossVectors(_ray.direction, _localUp).normalize();
        _ray.direction.copy(_localUp).applyAxisAngle(_rotationAxis, angle).multiplyScalar(-1);
      }

      // 求平面上应拖到的点。
      const intersect = _ray.intersectPlane(_plane.normal, _plane.constant, _vec);
      if (intersect) {
        _delta.subVectors(pivotPoint, _vec);
        this.getCameraPosition().add(_delta);
        this.getCameraTransform().notifyLocalChange();
        this.getCameraTransform().updateWorldMatrix();

        // 更新拖拽惯性。
        _delta.multiplyScalar(1 / deltaTime);
        if (pointerTracker.getMoveDistance() / deltaTime < 2 * window.devicePixelRatio) {
          this.inertiaStableFrames++;
        } else {
          dragInertia.copy(_delta);
          this.inertiaStableFrames = 0;
        }
      }
    }
  }

  protected _updateRotation(deltaTime: number): void {
    ensureScratchMatrices();
    const {
      pivotPoint,
      pointerTracker,
      state,
      rotationInertia,
    } = this;

    if (state === ROTATE || state === FREE_ROTATE) {
      // FREE_ROTATE 时枢轴跟随相机（第一人称环视）。
      if (state === FREE_ROTATE) {
        pivotPoint.copy(this.getCameraPosition());
      }

      // 取旋转量并按元素高度归一化。
      pointerTracker.getCenterPoint(_pointer);
      pointerTracker.getPreviousCenterPoint(_prevPointer);
      _deltaPointer.subVectors(_pointer, _prevPointer).multiplyScalar((2 * Math.PI) / this.domElement!.clientHeight);

      this._applyRotation(_deltaPointer.x, _deltaPointer.y, pivotPoint);

      // 更新旋转惯性。
      _deltaPointer.multiplyScalar(1 / deltaTime);
      if (pointerTracker.getMoveDistance() / deltaTime < 2 * window.devicePixelRatio) {
        this.inertiaStableFrames++;
      } else {
        rotationInertia.copy(_deltaPointer);
        this.inertiaStableFrames = 0;
      }
    }
  }

  protected _applyRotation(x: number, y: number, pivotPoint: Vector3): void {
    ensureScratchMatrices();
    if (x === 0 && y === 0) return;

    const {
      minAltitude,
      maxAltitude,
      rotationSpeed,
    } = this;

    const azimuth = -x * rotationSpeed;
    let altitude = y * rotationSpeed;

    // 计算当前角度并夹取。
    _forward.set(0, 0, -1).transformDirection(this.getCameraWorldMatrix());
    // fork 相机基向量（worldMatrix 列）：forward=+z、backward=-z、+x 列 =
    // cross(up,forward)；three 的 +x 列 = fork 的 -x 列（同一物理相机、不同标签）。
    // 角度符号与高度旋转轴必须用 fork 的 -x（= three 的 +x 物理方向），与原版
    // three 的 set(1,0,0) 一一对应；用 fork +x 时地平线视角会算出负角度 → 误触发
    // minAltitude 夹取，把相机直接拽回正俯视（实测：地平线视图首个滚轮事件即 90°→0°）。
    _right.set(-1, 0, 0).transformDirection(this.getCameraWorldMatrix());
    this.getUpDirection(pivotPoint, _localUp);

    // 相对俯视视角的有符号角度。
    let angle: number;
    if (_localUp.dot(_forward) > 1 - 1e-10) {
      angle = 0;
    } else {
      _vec.crossVectors(_localUp, _forward).normalize();
      const sign = Math.sign(_vec.dot(_right));
      angle = sign * _localUp.angleTo(_forward);
    }

    // 把旋转夹取到给定限制内。
    if (altitude > 0) {
      altitude = Math.min(angle - minAltitude, altitude);
      altitude = Math.max(0, altitude);
    } else {
      altitude = Math.max(angle - maxAltitude, altitude);
      altitude = Math.min(0, altitude);
    }

    // 绕 up 轴旋转。
    // ⚠️ fork 的 Quaternion.setFromAxisAngle(axis, angle) 是角度制（minified:
    // `setFromAxisAngle(e,t){t*=Math.PI/180;...}`），而 applyAxisAngle 是弧度制；
    // three.js 移植代码传弧度必须 ×RAD2DEG，否则旋转量被缩小 57 倍（右键旋转偏弱）。
    _quaternion.setFromAxisAngle(_localUp, azimuth * RAD2DEG);
    makeRotateAroundPoint(pivotPoint, _quaternion, _rotMatrix);
    _cameraMatrix.copy(this.getCameraWorldMatrix()).premultiply(_rotMatrix);
    this.applyCameraMatrix(_cameraMatrix);

    // 取高度旋转轴并旋转（同为 fork -x，见上）。
    _right.set(-1, 0, 0).transformDirection(this.getCameraWorldMatrix());
    _quaternion.setFromAxisAngle(_right, -altitude * RAD2DEG);
    makeRotateAroundPoint(pivotPoint, _quaternion, _rotMatrix);
    _cameraMatrix.copy(this.getCameraWorldMatrix()).premultiply(_rotMatrix);
    this.applyCameraMatrix(_cameraMatrix);
  }

  // 为当前瓦片集表面设置 up 轴。
  protected _setFrame(newUp: Vector3): void {
    ensureScratchMatrices();
    const {
      up,
      zoomPoint,
      zoomDirectionSet,
      zoomPointSet,
      scaleZoomOrientationAtEdges,
    } = this;

    // 缩放时绕缩放点重新定向。
    if (zoomDirectionSet && (zoomPointSet || this._updateZoomPoint())) {
      // 计算需要旋转的量。
      _quaternion.setFromUnitVectors(up, newUp);

      if (scaleZoomOrientationAtEdges) {
        this.getUpDirection(zoomPoint, _vec);
        let amt = Math.max(_vec.dot(up) - 0.6, 0) / 0.4;
        amt = mapLinear(amt, 0, 0.5, 0, 1);
        amt = Math.min(amt, 1);

        // 缩放值（原版在此对 ortho 相机乘 0.1；本移植仅透视）。
        _quaternion.slerp(_quaternion, _identityQuat, 1.0 - amt);
      }

      // 绕被缩放到的点旋转相机位置。
      makeRotateAroundPoint(zoomPoint, _quaternion, _rotMatrix);
      _cameraMatrix.copy(this.getCameraWorldMatrix()).premultiply(_rotMatrix);
      this.applyCameraMatrix(_cameraMatrix);

      // 更新旋转后重新推导缩放方向以对齐坐标帧。
      this.zoomDirectionSet = false;
      this._updateZoomDirection();
    }

    up.copy(newUp);
  }

  /** 场景射线（可选，经 ColliderComponent 网格求交）与回退平面。 */
  protected _raycast(ray: Ray): { point: Vector3; distance: number } | null {
    ensureScratchMatrices();
    const { useFallbackPlane, fallbackPlane } = this;

    const result = this._raycastScene(ray);
    if (result) return result;

    if (useFallbackPlane) {
      const point = ray.intersectPlane(fallbackPlane.normal, fallbackPlane.constant, _vec);
      if (point) {
        return { point: _vec.clone(), distance: ray.origin.distanceTo(_vec) };
      }
    }

    return null;
  }

  private _raycastScene(ray: Ray): { point: Vector3; distance: number } | null {
    const root = this.scene;
    if (!root) return null;

    const colliders = root.getComponentsInChild(ColliderComponent);
    let best: { point: Vector3; distance: number } | null = null;
    for (const collider of colliders) {
      _engineRay.origin.copy(ray.origin);
      _engineRay.direction.copy(ray.direction);
      const hit = collider.rayPick(_engineRay);
      if (!hit || !hit.intersectPoint) continue;
      const distance = hit.distance ?? ray.origin.distanceTo(hit.intersectPoint);
      if (best === null || distance < best.distance) {
        best = { point: hit.intersectPoint, distance };
      }
    }
    return best;
  }

  // 把相机 up 对齐到给定方向。
  protected _alignCameraUp(up: Vector3, alpha = 1): void {
    ensureScratchMatrices();
    const { state, pivotPoint, zoomPoint, zoomPointSet } = this;

    _forward.set(0, 0, 1).transformDirection(this.getCameraWorldMatrix());
    // fork 相机的 +x 列 = cross(up, forward)（lookAt 同款），与 targetRight 恒等；
    // 原版 three 的 -x 列才是这个方向（three 的 +x = cross(up, -forward)），
    // 移植时须用 +1，否则对齐会把相机翻转 180°。
    _right.set(1, 0, 0).transformDirection(this.getCameraWorldMatrix());

    // 相机正对该方向时不要更新 up。
    let multiplier = mapLinear(1 - Math.abs(_forward.dot(up)), 0, 0.2, 0, 1);
    multiplier = clamp(multiplier, 0, 1);
    alpha *= multiplier;

    // 计算右向量的目标方向。
    _targetRight.crossVectors(up, _forward);
    _targetRight.lerp(_targetRight, _right, 1 - alpha);
    _targetRight.normalize();

    // 调整相机变换。
    _quaternion.setFromUnitVectors(_right, _targetRight);

    // 计算活动点。
    let fixedPoint: Vector3 | null = null;
    if (state === DRAG || state === ROTATE || state === FREE_ROTATE) {
      fixedPoint = _pos.copy(pivotPoint);
    } else if (zoomPointSet) {
      fixedPoint = _pos.copy(zoomPoint);
    }

    // 平移相机以保持固定点不动。仅在右键旋转（ROTATE/FREE_ROTATE）期间启用：
    // 左键拖拽与滚轮缩放沿用基线行为（补偿不生效），避免改动拖拽/缩放手感。
    // ⚠️ 生效时按原版 three 顺序：用**旧**世界矩阵求逆把固定点变换到相机局部，
    // 再应用旋转并重算世界矩阵，最后用**新**世界矩阵正乘回世界求差值补位移。
    // （in-place premultiply 不置脏、updateWorldMatrix 按脏标记跳过，须强制同步。）
    const keepFixed = state === ROTATE || state === FREE_ROTATE;
    if (fixedPoint && keepFixed) {
      this.getCameraTransform().updateWorldMatrix(true);
      _invMatrix.copy(this.getCameraWorldMatrix()).invert();
      _vec.copy(fixedPoint).applyMatrix4(_invMatrix);
    }

    this.getCameraTransform().localRotQuat.premultiply(_quaternion);
    this.getCameraTransform().notifyLocalChange();
    this.getCameraTransform().updateWorldMatrix();

    if (fixedPoint && keepFixed) {
      _vec.applyMatrix4(this.getCameraWorldMatrix());
      _center.subVectors(fixedPoint, _vec);
      this.getCameraPosition().add(_center);
    }

    this.getCameraTransform().notifyLocalChange();
    this.getCameraTransform().updateWorldMatrix();
  }

  // 把旋转夹取到给定 up 向量。
  protected _clampRotation(up: Vector3): void {
    ensureScratchMatrices();
    const { minAltitude, maxAltitude, state, pivotPoint, zoomPoint, zoomPointSet } = this;

    this.getCameraTransform().updateWorldMatrix();

    // 计算当前角度并夹取。
    _forward.set(0, 0, -1).transformDirection(this.getCameraWorldMatrix());
    // fork 相机的 +x 列 = cross(up, forward) = -three 的 +x；夹取的符号
    // 用 -x（= three 的 +x），否则贴地时 signed angle 变负触发 minAltitude
    // 夹取，把相机 +z 强行转到 up 方向 → 相机翻转背对地球。
    _right.set(-1, 0, 0).transformDirection(this.getCameraWorldMatrix());

    // 相对俯视视角的有符号角度。
    let angle: number;
    if (up.dot(_forward) > 1 - 1e-10) {
      angle = 0;
    } else {
      _vec.crossVectors(up, _forward);
      const sign = Math.sign(_vec.dot(_right));
      angle = sign * up.angleTo(_forward);
    }

    // 计算目标角度。
    let targetAngle: number;
    if (angle > maxAltitude) {
      targetAngle = maxAltitude;
    } else if (angle < minAltitude) {
      targetAngle = minAltitude;
    } else {
      return;
    }

    // 构造旋转基。
    // 注：本方法按用户要求还原为基线行为——setFromAxisAngle 不补 RAD2DEG，
    // 夹取量被 fork 的角度制缩小 57 倍，实际几乎不生效（左键拖拽/滚轮缩放
    // 沿用基线手感）。右键旋转的限位由 _applyRotation 的增量夹取承担。
    _forward.copy(up);
    _quaternion.setFromAxisAngle(_right, targetAngle);
    _forward.applyQuaternion(_quaternion).normalize();
    _vec.crossVectors(_forward, _right).normalize();

    _rotMatrix.makeBasis(_right, _vec, _forward);
    this.getCameraTransform().localRotQuat.setFromRotationMatrix(_rotMatrix);

    // 计算活动点。
    let fixedPoint: Vector3 | null = null;
    if (state === DRAG || state === ROTATE || state === FREE_ROTATE) {
      fixedPoint = _pos.copy(pivotPoint);
    } else if (zoomPointSet) {
      fixedPoint = _pos.copy(zoomPoint);
    }

    // 平移相机以保持固定点不动（基线：补偿为弱夹取下的近似空操作，保留原样）。
    if (fixedPoint) {
      _invMatrix.copy(this.getCameraWorldMatrix()).invert();
      _vec.copy(fixedPoint).applyMatrix4(_invMatrix);
      _vec.applyMatrix4(this.getCameraWorldMatrix());
      _center.subVectors(fixedPoint, _vec);
      this.getCameraPosition().add(_center);
    }

    this.getCameraTransform().notifyLocalChange();
    this.getCameraTransform().updateWorldMatrix();
  }
}
