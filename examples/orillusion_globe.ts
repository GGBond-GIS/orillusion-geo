import { Camera3D, Engine3D, Object3D, Scene3D, Vector3, View3D } from '@orillusion/core';
import { Cartographic, Ellipsoid, EllipsoidTerrainProvider, WebMapTileServiceImageryProvider } from '@cesium/engine';
import { configureGlobeRendering, Globe, GlobeComponent, GlobeControls } from '../src/index.js';

/** 启动地形影像 Globe 示例。 */
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
  // 使用 Cesium WGS84 API 生成 ECEF 初始相机位置，确保与 Worker 输出的 TerrainMesh 坐标系一致。
  const cesiumInitialPosition = Ellipsoid.WGS84.cartographicToCartesian(
    Cartographic.fromDegrees(-82.5, 35.0, 12_000_000),
  );
  const initialPosition = new Vector3(cesiumInitialPosition.x, cesiumInitialPosition.y, cesiumInitialPosition.z);
  camera.lookAt(initialPosition, Vector3.ZERO, new Vector3(0, 0, 1));
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
      window.setInterval(() => { document.body.dataset.globeStatistics = JSON.stringify(globe.statistics); }, 500);
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
}

void bootstrap();
