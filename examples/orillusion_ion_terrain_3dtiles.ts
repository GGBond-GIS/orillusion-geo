import {
  Camera3D,
  EarthAtmRenderer,
  Engine3D,
  Matrix4,
  Object3D,
  Scene3D,
  SkyRenderer,
  Vector3,
  View3D,
} from '@orillusion/core';
import { Stats } from '@orillusion/stats';
import {
  Cartographic,
  Ellipsoid,
  Ion,
  WebMapTileServiceImageryProvider,
  createWorldTerrainAsync,
} from '@cesium/engine';
import {
  Globe,
  GlobeComponent,
  GlobeControls,
  OrillusionTilesRenderer,
  ThreeConventionCamera3D,
  TilesRendererComponent,
  configureGlobeRendering,
} from '../src/index.js';

/** 项目内由 Vite 开发服务器直接提供的本地 3D Tiles 样例目录。 */
const sampleRoot = '/data';
/** 不做坐标归一、偏移或轴修正的原始 3D Tiles 根地址。 */
const tilesetUrl = `${sampleRoot}/dayanpagoda-3dtiles-1_1/tileset.json`;

/** 在同一 Orillusion 场景中加载 Cesium World Terrain 与原始坐标的 3D Tiles。 */
async function bootstrap(): Promise<void> {
  let stats: Stats | null = null;
  Ion.defaultAccessToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiJlZmU5MWMwNS02YjY5LTRiNjAtOTFlNi0xM2NmNWZjZTc1ZDQiLCJpZCI6MzY2MDc1LCJpYXQiOjE3NjQ3MzYwOTV9.6Mjjy2V6NMudcsH9vQsYvMFDtcSdmG58ixc6dc19kEo';
  const terrainProvider = await createWorldTerrainAsync({
    requestVertexNormals: false,
    requestWaterMask: false,
  });

  configureGlobeRendering({ matrixCapacity: 4_096 });
  const engine = await Engine3D.init({
    // @orillusion/stats 仍使用官方面板与采样逻辑；当前 core 的更新表按 View3D
    // 分组，直接 addComponent(Stats) 只初始化画布而不会持续调用 onUpdate。
    lateRender: () => stats?.onUpdate(),
    setting: {
        useRTE: true,            // 开启相对相机渲染
        RTEScale: 1.0,           // RTE 坐标缩放系数，一般保持默认
        doublePrecision: true,   // 开启双精度矩阵
        render: {
            // useLogDepth: true,   // 开启对数深度缓冲
            // zPrePass: false,     // 关闭线性深度预通道：与 log 颜色深度编码不匹配会使遮挡失效 → 裙边可见
        },
    },
});

  stats = new Stats();
  stats.init();

  const scene = new Scene3D();
  const sky = scene.addComponent(SkyRenderer);
  void engine.res.loadLDRTextureCube('https://cdn.orillusion.com/images/space.webp')
    .then((texture) => { sky.map = texture; })
    .catch((error) => { console.warn('Unable to load the star-sky cubemap.', error); });

  const cameraObject = new Object3D();
  //@ts-ignore
  const camera = window.camera = cameraObject.addComponent(ThreeConventionCamera3D);
  camera.perspective(60, engine.aspect, 1, 100_000_000);
  // dayanpagoda tileset 根包围体中心（108.9594°E, 34.2196°N, 约 445m）。
  // 仅移动相机到数据集附近；3D Tiles 本身仍使用 tileset.json 的原始 ECEF 变换。
  const initialPosition = Ellipsoid.WGS84.cartographicToCartesian(
    Cartographic.fromDegrees(108.9594, 34.2196, 2_500),
  );
  const tilesetCenter = Ellipsoid.WGS84.cartographicToCartesian(
    Cartographic.fromDegrees(108.9594, 34.2196, 445),
  );
  camera.lookAt(
    new Vector3(initialPosition.x, initialPosition.y, initialPosition.z),
    new Vector3(tilesetCenter.x, tilesetCenter.y, tilesetCenter.z),
    new Vector3(0, 0, 1),
  );
  cameraObject.addComponent(GlobeControls, {
    camera,
    domElement: engine.context3D.canvas,
    // 传入 scene：控制器内部拾取（ray-pick Raycaster）命中地形网格三角形。
    scene,
    minDistance: 100,
    enableDamping: false,
  });
  scene.addChild(cameraObject);

  const globeObject = new Object3D();
  globeObject.addComponent(GlobeComponent, {
    camera,
    terrainProvider,
    initialTiles: [{ x: 0, y: 0, level: 0 }, { x: 1, y: 0, level: 0 }],
    onReady: (globe: Globe) => {
      (window as Window & { __globe?: Globe }).__globe = globe;
      globe.addImageryProvider(new WebMapTileServiceImageryProvider({
        url: 'https://{s}.tianditu.gov.cn/img_w/wmts?SERVICE=WMTS&REQUEST=GetTile&version=1.0.0&LAYER=img&tileMatrixSet=w&TileMatrix={TileMatrix}&TileRow={TileRow}&TileCol={TileCol}&style=default&tk=39d358c825ec7e59142958656c0a6864',
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

  const tilesObject = new Object3D();
  tilesObject.name = '3D Tiles (raw tileset transform)';
  // 不设置 tilesObject 的 position / rotation / scale，也不调用 setTilesetTransform：
  // 3D Tiles 保持 tileset.json 声明的原始空间坐标，与地球直接共存。
  tilesObject.addComponent(TilesRendererComponent, {
    url: tilesetUrl,
    camera: camera as unknown as Camera3D,
    errorTarget: 6,
    onRendererReady: (renderer: OrillusionTilesRenderer) => {
      // 此数据的 GLB 节点是标准 glTF Y-up，但 tileset.json 的包围体和 ECEF
      // 根变换按 Z-up 写入。内容先转回 Z-up，再乘原始 ECEF 根变换。
      // 不引入任何平移，数据仍位于 tileset.json 声明的原始位置。
      const yUpToZUp = new Matrix4();
      yUpToZUp.createByRotation(90, Vector3.X_AXIS);
      renderer.setContentTransform(yUpToZUp);
    },
  });
  scene.addChild(tilesObject);

  const view = new View3D();
  view.scene = scene;
  view.camera = camera as unknown as Camera3D;
  engine.startRenderView(view);

  const atmosphere = scene.addComponent(EarthAtmRenderer);
  atmosphere.configureForSpaceView();
  atmosphere.earthRadius = 6_378_137;
  atmosphere.atmosphereRadius = 6_478_137;
  atmosphere.radius = atmosphere.atmosphereRadius * 1.5;
  atmosphere.sunDirection = new Vector3(1, 0.3, 0.5);
  atmosphere.sunIntensity = 22;
  atmosphere.exposure = 1;
}

void bootstrap();
