import { Color, Engine3D, MeshRenderer, Object3D, PointerEvent3D, Scene3D, SphereGeometry, UnLitMaterial, Vector2, Vector3, View3D } from '@orillusion/core';
import { Cartographic, Cartesian3, Ellipsoid, EllipsoidTerrainProvider, WebMapTileServiceImageryProvider } from '@cesium/engine';
import { configureGlobeRendering, Globe, GlobeComponent, GlobeControls, installRayPick, SceneRayPick, ThreeConventionCamera3D } from '../src/index.js';

/**
 * CPU 射线拾取坐标示例（ray-pick 包，ray 模式）：
 *  - installRayPick() 把 raycast 方法注入 MeshRenderer/SpriteRenderer 等核心
 *    渲染器原型（幂等，重复调用无副作用）；
 *  - SceneRayPick(view) 监听引擎输入系统，把拾取射线射向场景网格三角形
 *    （CPU 求交，逐三角形测试，结果按距离排序），并派发标准 PICK_* 事件；
 *  - 点击时 PICK_CLICK 的 data 携带 { worldPos, worldNormal, meshID, distance,
 *    faceIndex, face, uv, uv1, barycoord, normal, object }，worldPos 是世界空间
 *    交点（ECEF，与地形顶点同一参考系，RTE 下不再需要补偿相机坐标）；
 *  - 与 pixel 模式（GPU GBuffer 读回）的区别：ray 模式不依赖 useCompressGBuffer、
 *    不需要 view.enablePick/PickFire，也不产生 GPU 回读；代价是逐事件 CPU
 *    三角形求交（射线经过的可见瓦片越多越慢）。
 *
 * 前置条件：engine.setting.pick.mode = 'ray'（SceneRayPick.isRayMode 的开关；
 * fork 的类型声明只有 'pixel'|'bound'，按包 README 用窄化转换）。
 *
 * 控制器：1:1 移植的 3d-tiles-renderer GlobeControls（椭球拖拽/缩放/惯性/
 * near-far 调节），内部场景拾取同样走 ray-pick（Raycaster.intersectObject）。
 */

const infoPanel = document.createElement('div');
infoPanel.style.cssText = 'position:fixed;top:12px;right:12px;z-index:10;background:rgba(8,12,20,.82);color:#cfd8e3;font:12px/1.7 "SF Mono",Consolas,monospace;padding:10px 14px;border-radius:8px;border:1px solid rgba(120,160,220,.25);max-width:360px;white-space:pre;pointer-events:none';
document.body.appendChild(infoPanel);

let marker: Object3D | null = null;

/** 创建地表标记：红色小球，半径随相机高度缩放，保证任何视角可见。显式禁用 raycast → 不参与拾取。 */
function createMarker(engine: Engine3D, globe: Globe): Object3D {
  const object = new Object3D();
  const renderer = object.addComponent(MeshRenderer);
  renderer.geometry = new SphereGeometry(1, 24, 16);
  const material = new UnLitMaterial(engine.context3D);
  material.baseColor = new Color(1, 0.25, 0.2, 1);
  renderer.material = material;
  renderer.enable = false;
  // ray-pick 按组件 raycast 派发（installRayPick 注入到原型），实例级赋值
  // 覆盖为 no-op 即可让标记球不拦截指向地表的射线。
  (renderer as unknown as { raycast?: () => void }).raycast = () => {};
  globe.group.addChild(object);
  return object;
}

/** ray-pick 的 PICK_* 事件携带的拾取结果（SceneRayPick.hitData）。 */
interface PickData {
  /** 命中点世界坐标（ECEF，CPU 三角形求交，精确到面）。 */
  worldPos: Vector3;
  worldNormal: Vector3;
  /** 命中网格的矩阵池索引（对象 ID）。 */
  meshID: number;
  /** 射线起点到命中点的世界空间距离。 */
  distance: number;
  /** 命中的三角形索引。 */
  faceIndex: number;
  /** 命中的 Object3D。 */
  object: Object3D;
  uv?: Vector2;
  uv1?: Vector2;
  normal?: Vector3;
}

async function bootstrap(): Promise<void> {
  const mapToken = '39d358c825ec7e59142958656c0a6864';
  // 必须早于 Engine3D.init：避免 Orillusion 按默认五十万矩阵创建 48 MB 的全局矩阵缓冲。
  configureGlobeRendering({ matrixCapacity: 4_096 });
  // 注入 ray-pick（幂等；SceneRayPick / 控制器内部 Raycaster 依赖注入后的 raycast）。
  installRayPick();
  const engine = await Engine3D.init({
    setting: {
        useRTE: true,            // 开启相对相机渲染
        RTEScale: 1.0,           // RTE 坐标缩放系数，一般保持默认
        doublePrecision: true,   // 开启双精度矩阵
        render: {
            useLogDepth: true,   // 开启对数深度缓冲
            zPrePass: false,     // 关闭线性深度预通道：与 log 颜色深度编码不匹配会使遮挡失效 → 裙边可见
        },
        pick: {
            // ray 模式由外部包（ray-pick）提供；fork 的类型声明只到 pixel|bound，
            // 按包 README 用窄化转换。SceneRayPick.isRayMode 依此判断。
            mode: 'ray' as any,
        },
    },
});
  const scene = new Scene3D();
  const cameraObject = new Object3D();
  // three.js 约定相机：GlobeControls 按 three 数学操作 transform，viewMatrix 层还原 fork 的 +z 前向。
  const camera = cameraObject.addComponent(ThreeConventionCamera3D);
  camera.perspective(60, engine.aspect, 1, 100_000_000);
  // Cesium Camera.DEFAULT_VIEW_RECTANGLE 的中心约为经度 -82.5°、纬度 35°。
  const cesiumInitialPosition = Ellipsoid.WGS84.cartographicToCartesian(
    Cartographic.fromDegrees(-82.5, 35.0, 12_000_000),
  );
  const initialPosition = new Vector3(cesiumInitialPosition.x, cesiumInitialPosition.y, cesiumInitialPosition.z);
  camera.lookAt(initialPosition, Vector3.ZERO, new Vector3(0, 0, 1));
  // 1:1 移植的 3d-tiles-renderer GlobeControls。minDistance 沿用原版语义：
  // 相机到缩放点（地表）的最小距离，这里设为 100 m 允许放大到贴地高度。
  // 传入 scene：控制器内部拾取（ray-pick Raycaster）可命中地形网格三角形，
  // 而非只回退到椭球面（与 3d-tiles-renderer 的用法一致）。
  cameraObject.addComponent(GlobeControls, {
    camera,
    domElement: engine.context3D.canvas,
    scene,
    minDistance: 100,
    // 关闭阻尼惯性：拖拽/旋转松开后立即停止，不做残余旋转（原版 enableDamping
    // 会带球面惯性，松开后地球继续转一会）。
    enableDamping: false,
  });
  scene.addChild(cameraObject);

  const globeObject = new Object3D();
  globeObject.addComponent(GlobeComponent, {
    camera,
    terrainProvider: new EllipsoidTerrainProvider(),
    initialTiles: [{ x: 0, y: 0, level: 0 }, { x: 1, y: 0, level: 0 }],
    onReady: (globe: Globe) => {
      (window as Window & { __globe?: Globe }).__globe = globe;
      marker = createMarker(engine, globe);
      globe.addImageryProvider(new WebMapTileServiceImageryProvider({
        url: `https://{s}.tianditu.gov.cn/img_w/wmts?SERVICE=WMTS&REQUEST=GetTile&version=1.0.0&LAYER=img&tileMatrixSet=w&TileMatrix={TileMatrix}&TileRow={TileRow}&TileCol={TileCol}&style=default&tk=${mapToken}`,
        subdomains: ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7'],
        maximumLevel: 17,
        layer: 'tdtImgLayer',
        style: 'default',
        format: 'image/jpeg',
        tileMatrixSetID: 'GoogleMapsCompatible',
      }));
    },
  });
  scene.addChild(globeObject);

  const view = new View3D();
  view.scene = scene;
  view.camera = camera as unknown as import('@orillusion/core').Camera3D;
  engine.startRenderView(view);
  (window as Window & { __view?: View3D }).__view = view;

  // ---- 开启 ray-pick 指针事件（ray 模式：CPU 三角形求交） ----
  // 必须在 startRenderView 之后 start（SceneRayPick 需要 view.engine3D 已绑定）。
  let lastPickAt = 0;

  const onPick = (event: { data?: PickData }): void => {
    lastPickAt = performance.now();
    const data = event.data;
    const renderer = marker?.getComponent(MeshRenderer);
    if (!data || !marker) {
      if (renderer?.enable) renderer.enable = false;
      infoPanel.textContent = '未命中地球（射线指向太空）';
      return;
    }
    const worldPos = data.worldPos;
    // ray-pick 的 worldPos 是 CPU 求交的绝对 ECEF（世界矩阵 × 局部顶点），
    // RTE 渲染不改变对象世界矩阵，无需再加相机坐标。
    // 防御性校验：按椭球半径范围过滤一次，杜绝垃圾坐标落到标记上。
    const radius = Cartesian3.magnitude(new Cartesian3(worldPos.x, worldPos.y, worldPos.z));
    if (radius < Ellipsoid.WGS84.minimumRadius * 0.98 || radius > Ellipsoid.WGS84.maximumRadius * 1.02) {
      if (renderer?.enable) renderer.enable = false;
      infoPanel.textContent = '未命中地球（拾取坐标超出椭球表面范围）';
      return;
    }
    const cartographic = Cartographic.fromCartesian(
      new Cartesian3(worldPos.x, worldPos.y, worldPos.z),
      Ellipsoid.WGS84,
    );
    // 标记放于命中点（globe.group 无位移 → 世界坐标直接可用）。
    renderer!.enable = true;
    marker.transform.localPosition = new Vector3(worldPos.x, worldPos.y, worldPos.z);
    const cameraPosition = camera.object3D.transform.worldPosition;
    const cameraHeight = Cartographic.fromCartesian(
      new Cartesian3(cameraPosition.x, cameraPosition.y, cameraPosition.z),
      Ellipsoid.WGS84,
    ).height;
    const markerScale = Math.max(30_000, Math.min(300_000, cameraHeight * 0.02));
    marker.transform.localScale = new Vector3(markerScale, markerScale, markerScale);
    const lon = (cartographic.longitude * 180) / Math.PI;
    const lat = (cartographic.latitude * 180) / Math.PI;
    infoPanel.textContent = [
      '— 拾取结果（ray-pick CPU 射线）—',
      `经度  ${lon.toFixed(6)}°`,
      `纬度  ${lat.toFixed(6)}°`,
      `高度  ${cartographic.height.toFixed(1)} m`,
      `ECEF   ${worldPos.x.toFixed(0)}, ${worldPos.y.toFixed(0)}, ${worldPos.z.toFixed(0)}`,
      `meshID ${data.meshID}`,
      `distance ${data.distance.toFixed(0)} m`,
      `faceIndex ${data.faceIndex}`,
      `相机高度 ${(cameraHeight / 1000).toFixed(0)} km`,
    ].join('\n');
  };

  const scenePicker = new SceneRayPick(view).start();
  scenePicker.addEventListener(PointerEvent3D.PICK_CLICK, onPick, undefined);

  // 未命中反馈：ray 模式下 PICK_CLICK 只在按下与抬起命中同一对象时派发，
  // 点击太空没有任何 PICK_* 事件；借用引擎输入系统的 POINTER_CLICK
  // （SceneRayPick 的同名监听先注册先执行）判断本次点击是否产生了拾取结果。
  engine.inputSystem.addEventListener(PointerEvent3D.POINTER_CLICK, () => {
    if (performance.now() - lastPickAt > 120) {
      const renderer = marker?.getComponent(MeshRenderer);
      if (renderer?.enable) renderer.enable = false;
      infoPanel.textContent = '未命中地球（射线指向太空）';
    }
  }, undefined);

}

void bootstrap();
