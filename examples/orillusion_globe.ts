import { Engine3D, Object3D, Scene3D, Vector3, View3D } from '@orillusion/core';
import { Cartographic, Ellipsoid, EllipsoidTerrainProvider, WebMapTileServiceImageryProvider } from '@cesium/engine';
import { configureGlobeRendering, Globe, GlobeComponent, GlobeControls, ThreeConventionCamera3D } from '../src/index.js';

/** 启动地形影像 Globe 示例。 */
async function bootstrap(): Promise<void> {
  const mapToken = '39d358c825ec7e59142958656c0a6864';
  // 必须早于 Engine3D.init：避免 Orillusion 按默认五十万矩阵创建 48 MB 的全局矩阵缓冲。
  configureGlobeRendering({ matrixCapacity: 4_096 });
  // ECEF 大尺度渲染必需的三件套：
  //  - useLogDepth：near=1/far=1e8 线性深度在远距离挤爆，且拾取反投影数值病态；
  //  - useRTE + doublePrecision：模型矩阵按 f64 维护、着色器做分裂双精度
  //    (modelPos - cameraPos) 减法——配合 Globe 的 RTC 瓦片顶点（相对中心），
  //    贴地视角顶点精度达毫米级，否则绝对 ECEF f32（~6.4e6）近距会抖动。
  //  - zPrePass=false：fork 的 PreDepthPass 写线性深度而颜色通道写 log
  //    frag_depth，编码不匹配使预通道遮挡失效 → 近距裙边/缝隙可见；关闭后
  //    颜色通道自写自比 log 深度，遮挡正确。
  const engine = await Engine3D.init({
    setting: {
      useRTE: true,
      RTEScale: 1.0,
      doublePrecision: true,
      render: {
        useLogDepth: true,
        zPrePass: false,
      },
    },
  });
  const scene = new Scene3D();
  const cameraObject = new Object3D();
  // three.js 约定相机：GlobeControls 按 three 数学操作 transform，viewMatrix 层还原 fork 的 +z 前向。
  const camera = cameraObject.addComponent(ThreeConventionCamera3D);
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
    // 原版语义：相机到缩放点（地表）的最小距离，100 m 允许放大到贴地高度。
    minDistance: 100,
    // 关闭阻尼惯性：拖拽/旋转松开后立即停止（原版 enableDamping 会带惯性继续转）。
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
  view.camera = camera as unknown as import('@orillusion/core').Camera3D;
  engine.startRenderView(view);
}

void bootstrap();
