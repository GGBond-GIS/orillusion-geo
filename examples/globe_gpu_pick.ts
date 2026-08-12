import { Camera3D, Color, Engine3D, MeshRenderer, Object3D, PointerEvent3D, Ray, Scene3D, SphereGeometry, UnLitMaterial, Vector3, View3D } from '@orillusion/core';
import { Cartographic, Cartesian3, Cartesian4, Ellipsoid, EllipsoidTerrainProvider, Matrix4 as CesiumMatrix4, WebMapTileServiceImageryProvider } from '@cesium/engine';
import { configureGlobeRendering, Globe, GlobeComponent, GlobeControls } from '../src/index.js';

/**
 * GPU 拾取坐标示例（Orillusion 官方 pick 管线，bound 模式）：
 *  - 地形瓦片挂 ColliderComponent + MeshColliderShape（Globe 内置），
 *    引擎 ColliderComponent.onEnable 自动注册进 enablePickerList；
 *  - `setting.pick.mode = 'bound'` 先设、`view.enablePick = true` 后开（PickFire.start 按当时 mode 初始化）；
 *  - 点击时 PickFire 用屏幕射线对 enablePickerList 里的 Collider 做 rayPick，
 *    命中后派发 PointerEvent3D.PICK_CLICK，data.worldPos 即命中点世界坐标（ECEF）。
 *
 * 注意：Orillusion 0.9.2 的 Camera3D.screenPointToRay 在默认透视参数下
 * 恒返回相机 forward（unproject 缺陷），这里在示例层用标准透视矩阵修复；
 * 不修改引擎源码、不开启压缩 GBuffer（pixel 模式前置，会与自定义瓦片材质冲突），
 * 对场景中其他几何零影响——它们没有 ColliderComponent，不参与拾取。
 */

const infoPanel = document.createElement('div');
infoPanel.style.cssText = 'position:fixed;top:12px;right:12px;z-index:10;background:rgba(8,12,20,.82);color:#cfd8e3;font:12px/1.7 "SF Mono",Consolas,monospace;padding:10px 14px;border-radius:8px;border:1px solid rgba(120,160,220,.25);max-width:360px;white-space:pre;pointer-events:none';
document.body.appendChild(infoPanel);

let marker: Object3D | null = null;

/** 创建地表标记：红色小球，半径随相机高度缩放，保证任何视角可见。 */
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

/** Orillusion PICK_* 事件携带的拾取结果（bound 模式）。 */
interface PickData {
  /** 命中点世界坐标（ECEF，与地形瓦片顶点同一参考系）。 */
  worldPos: Vector3;
  worldNormal: Vector3;
  /** 命中网格的矩阵池索引（-1 表示未命中）。 */
  meshID: number;
  distance: number;
}

/**
 * 修复 Orillusion 0.9.2 Camera3D.screenPointToRay 的 unproject 缺陷
 * （其 projectionMatrix 布局非常规，屏幕射线恒等于相机 forward）。
 * 用 fov/aspect/near/far 重建标准透视矩阵（Cesium 数学），方向取反修正 NDC 符号。
 */
function patchScreenPointToRay(camera: Camera3D): void {
  const canvas = camera._boundCtx?.canvas;
  if (!canvas) return;
  camera.screenPointToRay = (clientX: number, clientY: number): Ray => {
    const fov = (camera.fov * Math.PI) / 180;
    const tanHalf = Math.tan(fov / 2);
    const aspect = canvas.clientWidth / canvas.clientHeight;
    const near = camera.near;
    const far = camera.far;
    // 标准 OpenGL 透视矩阵（列主序，与 Cesium Matrix4 布局一致）。
    const proj = new CesiumMatrix4(
      1 / (tanHalf * aspect), 0, 0, 0,
      0, 1 / tanHalf, 0, 0,
      0, 0, -(far + near) / (far - near), (-2 * far * near) / (far - near),
      0, 0, -1, 0,
    );
    const wm = camera.object3D.transform.worldMatrix.rawData;
    const world = new CesiumMatrix4(
      wm[0], wm[4], wm[8], wm[12],
      wm[1], wm[5], wm[9], wm[13],
      wm[2], wm[6], wm[10], wm[14],
      wm[3], wm[7], wm[11], wm[15],
    );
    const invViewProj = CesiumMatrix4.multiply(
      world,
      CesiumMatrix4.inverse(proj, new CesiumMatrix4()),
      new CesiumMatrix4(),
    );
    const ndcX = (clientX / canvas.clientWidth) * 2 - 1;
    // Orillusion 的 NDC y 与标准 OpenGL 相反（屏幕顶部 = NDC -1）：
    // 用 2y/h-1 才能让屏幕上方射线指向北（相机 up 方向）。
    const ndcY = (clientY / canvas.clientHeight) * 2 - 1;
    const far4 = CesiumMatrix4.multiplyByVector(invViewProj, new Cartesian4(ndcX, ndcY, 1, 1), new Cartesian4());
    if (Math.abs(far4.w) < 1e-12) return new Ray(new Vector3(), new Vector3(0, 0, -1));
    const invW = 1 / far4.w;
    const cameraPosition = camera.object3D.transform.worldPosition;
    const origin = new Vector3(cameraPosition.x, cameraPosition.y, cameraPosition.z);
    // 方向取反：Orillusion 的 NDC z 轴与标准 OpenGL 相反，取反后射线才指向场景。
    const direction = new Vector3(
      origin.x - far4.x * invW,
      origin.y - far4.y * invW,
      origin.z - far4.z * invW,
    ).normalize();
    return new Ray(origin, direction);
  };
}

async function bootstrap(): Promise<void> {
  const mapToken = '39d358c825ec7e59142958656c0a6864';
  // 必须早于 Engine3D.init：避免 Orillusion 按默认五十万矩阵创建 48 MB 的全局矩阵缓冲。
  configureGlobeRendering({ matrixCapacity: 16_384 });
  const engine = await Engine3D.init();
  const scene = new Scene3D();
  const cameraObject = new Object3D();
  const camera = cameraObject.addComponent(Camera3D);
  camera.perspective(60, engine.aspect, 1, 100_000_000);
  // Cesium Camera.DEFAULT_VIEW_RECTANGLE 的中心约为经度 -82.5°、纬度 35°。
  const cesiumInitialPosition = Ellipsoid.WGS84.cartographicToCartesian(
    Cartographic.fromDegrees(-82.5, 35.0, 12_000_000),
  );
  camera.lookAt(new Vector3(cesiumInitialPosition.x, cesiumInitialPosition.y, cesiumInitialPosition.z), Vector3.ZERO, new Vector3(0, 0, 1));
  cameraObject.addComponent(GlobeControls, {
    camera,
    domElement: engine.context3D.canvas,
    target: Vector3.ZERO,
    minDistance: Ellipsoid.WGS84.maximumRadius + 100,
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
  view.camera = camera;
  engine.startRenderView(view);
  (window as Window & { __view?: View3D }).__view = view;

  // ---- 开启 Orillusion 官方拾取（bound 模式：ColliderComponent + 屏幕射线） ----
  patchScreenPointToRay(camera);
  engine.setting.pick.mode = 'bound';
  view.enablePick = true;

  const onPick = (event: { data?: PickData }): void => {
    const data = event.data;
    if (!data || data.meshID < 0 || !marker) {
      const renderer = marker?.getComponent(MeshRenderer);
      if (renderer?.enable) renderer.enable = false;
      infoPanel.textContent = '未命中地球（射线指向太空）';
      return;
    }
    const worldPos = data.worldPos;
    const cartographic = Cartographic.fromCartesian(
      new Cartesian3(worldPos.x, worldPos.y, worldPos.z),
      Ellipsoid.WGS84,
    );
    // 标记放于命中点（Collider 命中点世界坐标，globe.group 无位移 → 直接可用）。
    marker.getComponent(MeshRenderer)!.enable = true;
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
      '— 拾取结果（Orillusion bound pick）—',
      `经度  ${lon.toFixed(6)}°`,
      `纬度  ${lat.toFixed(6)}°`,
      `高度  ${cartographic.height.toFixed(1)} m`,
      `ECEF   ${worldPos.x.toFixed(0)}, ${worldPos.y.toFixed(0)}, ${worldPos.z.toFixed(0)}`,
      `meshID ${data.meshID}`,
      `相机高度 ${(cameraHeight / 1000).toFixed(0)} km`,
    ].join('\n');
  };
  view.pickFire.addEventListener(PointerEvent3D.PICK_CLICK, onPick, undefined);

}

void bootstrap();
