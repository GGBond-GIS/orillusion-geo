import { Color, Engine3D, MeshRenderer, Object3D, PointerEvent3D, Scene3D, SphereGeometry, UnLitMaterial, Vector2, Vector3, View3D } from '@orillusion/core';
import { Cartographic, Cartesian3, Ellipsoid, EllipsoidTerrainProvider, WebMapTileServiceImageryProvider } from '@cesium/engine';
import { configureGlobeRendering, Globe, GlobeComponent, GlobeControls, ThreeConventionCamera3D } from '../src/index.js';

/**
 * GPU 拾取坐标示例（Orillusion 官方 gpupick 管线，pixel 模式）：
 *  - 引擎每帧的 COLOR pass 把场景不透明网格同时写入 color 与 compress GBuffer
 *    （rgba32float）；压缩 GBuffer 的 w 通道按 r22g8 编码 (modelIndex, metallic)，
 *    modelIndex 即对象世界矩阵池索引（Common_frag.modelIndex → packNHMDGBuffer）；
 *  - 地形瓦片挂 ColliderComponent（Globe 内置，见 Globe.createTerrainObject），
 *    组件 start() 时把 worldMatrix.index → collider 注册进 pickFire.mouseEnableMap；
 *  - 点击时 PickFire 启动 Picker_cs 计算着色器，textureLoad 鼠标 UV 处的 GBuffer texel，
 *    解码出 meshID 与命中点世界坐标（ECEF，与地形顶点同一参考系）并派发
 *    PointerEvent3D.PICK_CLICK，data.worldPos 即命中点世界坐标；
 *  - 前置条件：useLogDepth = true（ECEF 大尺度场景必需，否则非 log-depth 的
 *    位置重建数值病态）与 useCompressGBuffer = true（上游 pixel 模式依赖压缩
 *    GBuffer 携带对象 ID）、pick.mode = 'pixel' 都必须在 startRenderView 之前设置；
 *    pixel 模式还会自动挂 FXAA。
 *
 * 与 bound 模式（CPU 屏幕射线 vs Collider 包围体）的区别：
 *  - 精度到像素，不依赖 Camera3D.screenPointToRay，也不需要射线-网格求交；
 *  - 读回的是上一帧的渲染结果（GBuffer 与相机姿态滞后一帧，官方管线固有行为）；
 *  - 背景像素（太空）解码为 meshID = 0 —— 本场景矩阵 0 属于相机对象（无 Collider，
 *    矩阵索引在 Object3D 创建时按序分配），查询不到拾取对象，因此点击太空不会派发
 *    PICK_CLICK，示例通过引擎输入系统补一个未命中提示。
 *
 * 控制器：1:1 移植的 3d-tiles-renderer GlobeControls（椭球拖拽/缩放/惯性/
 * near-far 调节），内部自带射线数学，无需再修补 Camera3D.screenPointToRay。
 */

const infoPanel = document.createElement('div');
infoPanel.style.cssText = 'position:fixed;top:12px;right:12px;z-index:10;background:rgba(8,12,20,.82);color:#cfd8e3;font:12px/1.7 "SF Mono",Consolas,monospace;padding:10px 14px;border-radius:8px;border:1px solid rgba(120,160,220,.25);max-width:360px;white-space:pre;pointer-events:none';
document.body.appendChild(infoPanel);

let marker: Object3D | null = null;

/** 创建地表标记：红色小球，半径随相机高度缩放，保证任何视角可见。无 Collider → 不参与拾取。 */
function createMarker(engine: Engine3D, globe: Globe): Object3D {
  const object = new Object3D();
  const renderer = object.addComponent(MeshRenderer);
  renderer.geometry = new SphereGeometry(1, 24, 16);
  const material = new UnLitMaterial(engine.context3D);
  material.baseColor = new Color(1, 0.25, 0.2, 1);
  renderer.material = material;
  renderer.enable = false;
  globe.group.addChild(object);
  return object;
}

/** Orillusion PICK_* 事件携带的拾取结果（pixel 模式，PickFire.getPickInfo）。 */
interface PickData {
  /** 命中点世界坐标（ECEF，由 GBuffer 深度 + 相机矩阵重建）。 */
  worldPos: Vector3;
  worldNormal: Vector3;
  /** 命中点屏幕像素坐标（Picker_cs 原样写回 globalUniform.mouseX/Y）。 */
  screenUv: Vector2;
  /** 命中网格的矩阵池索引（对象 ID；背景像素解码为 0）。 */
  meshID: number;
}

async function bootstrap(): Promise<void> {
  const mapToken = '39d358c825ec7e59142958656c0a6864';
  // 必须早于 Engine3D.init：避免 Orillusion 按默认五十万矩阵创建 48 MB 的全局矩阵缓冲。
  configureGlobeRendering({ matrixCapacity: 16_384 });
  const engine = await Engine3D.init({
    setting: {
        useRTE: true,            // 开启相对相机渲染
        RTEScale: 1.0,           // RTE 坐标缩放系数，一般保持默认
        doublePrecision: true,   // 开启双精度矩阵
        render: {
            useLogDepth: true,   // 开启对数深度缓冲
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
  cameraObject.addComponent(GlobeControls, {
    camera,
    domElement: engine.context3D.canvas,
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

  // ---- 开启 Orillusion 官方 GPU 拾取（pixel 模式：逐像素 GBuffer 读回） ----
  // 必须在 startRenderView 之前设置：PickFire.start / 渲染任务按当时 mode 初始化。
  // useLogDepth 不是拾取开关，但必须开：near=1 / far=1e8 时地球表面全部挤在
  // NDC z≈1 附近，非 log-depth 路径的 getWorldPosition(gBuffer.x, uv) 反投影
  // 数值病态（w→0），解码出的世界坐标是垃圾值；log-depth 路径（GBufferStand 的
  // inverseLog2Depth + 近平面射线重建，Picker_cs 同步切换）是数值稳健的。
  engine.setting.render.useLogDepth = true;
  engine.setting.render.useCompressGBuffer = true;
  engine.setting.pick.mode = 'pixel';

  const view = new View3D();
  view.scene = scene;
  view.camera = camera as unknown as import('@orillusion/core').Camera3D;
  engine.startRenderView(view);
  // mode==='pixel' 时渲染任务已自动开启拾取（并挂 FXAA）；显式再开一次是幂等的，
  // 与官方 gpupick 示例的写法保持一致。
  view.enablePick = true;
  (window as Window & { __view?: View3D }).__view = view;

  let lastPickAt = 0;

  const onPick = (event: { data?: PickData }): void => {
    lastPickAt = performance.now();
    const data = event.data;
    const renderer = marker?.getComponent(MeshRenderer);
    if (!data || !marker || data.meshID < 0) {
      if (renderer?.enable) renderer.enable = false;
      infoPanel.textContent = '未命中地球（射线指向太空）';
      return;
    }
    const worldPos = data.worldPos;
    // 防御性校验：pixel 拾取读回的是上一帧 GBuffer，背景像素（太空）解码为 meshID=0，
    // 本场景矩阵 0 属于相机对象（无 Collider，不会出现在 mouseEnableMap 里），
    // 正常不会命中；这里再按椭球半径范围过滤一次，杜绝垃圾坐标落到标记上。
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
    // 标记放于命中点（GBuffer 重建的世界坐标，globe.group 无位移 → 直接可用）。
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
      '— 拾取结果（Orillusion pixel gpupick）—',
      `经度  ${lon.toFixed(6)}°`,
      `纬度  ${lat.toFixed(6)}°`,
      `高度  ${cartographic.height.toFixed(1)} m`,
      `ECEF   ${worldPos.x.toFixed(0)}, ${worldPos.y.toFixed(0)}, ${worldPos.z.toFixed(0)}`,
      `meshID ${data.meshID}`,
      `UV     ${data.screenUv.x.toFixed(1)}, ${data.screenUv.y.toFixed(1)}`,
      `相机高度 ${(cameraHeight / 1000).toFixed(0)} km`,
    ].join('\n');
  };
  view.pickFire.addEventListener(PointerEvent3D.PICK_CLICK, onPick, undefined);

  // 未命中反馈：pixel 模式下 PICK_CLICK 只在命中可拾取对象时派发，点击太空没有
  // 任何 PICK_* 事件；借用引擎输入系统的 POINTER_CLICK（PickFire 的同名监听
  // 先注册先执行）判断本次点击是否产生了拾取结果。
  engine.inputSystem.addEventListener(PointerEvent3D.POINTER_CLICK, () => {
    if (performance.now() - lastPickAt > 120) {
      const renderer = marker?.getComponent(MeshRenderer);
      if (renderer?.enable) renderer.enable = false;
      infoPanel.textContent = '未命中地球（射线指向太空）';
    }
  }, undefined);

}

void bootstrap();
