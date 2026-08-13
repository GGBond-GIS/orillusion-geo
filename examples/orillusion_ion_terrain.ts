import { Engine3D, Object3D, Scene3D, Vector3, View3D } from '@orillusion/core';
import {
  Cartographic,
  Ellipsoid,
  Ion,
  WebMapTileServiceImageryProvider,
  createWorldTerrainAsync,
} from '@cesium/engine';
import {
  configureGlobeRendering,
  Globe,
  GlobeComponent,
  GlobeControls,
  ThreeConventionCamera3D,
} from '../src/index.js';

/** Load Cesium World Terrain (ion asset 1) and render it with the existing imagery pipeline. */
async function bootstrap(): Promise<void> {
  Ion.defaultAccessToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiJlZmU5MWMwNS02YjY5LTRiNjAtOTFlNi0xM2NmNWZjZTc1ZDQiLCJpZCI6MzY2MDc1LCJpYXQiOjE3NjQ3MzYwOTV9.6Mjjy2V6NMudcsH9vQsYvMFDtcSdmG58ixc6dc19kEo';
  const terrainProvider = await createWorldTerrainAsync({
    requestVertexNormals: false,
    requestWaterMask: false,
  });

  configureGlobeRendering({ matrixCapacity: 4_096 });
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
  const camera = cameraObject.addComponent(ThreeConventionCamera3D);
  camera.perspective(60, engine.aspect, 1, 100_000_000);
  const cesiumInitialPosition = Ellipsoid.WGS84.cartographicToCartesian(
    Cartographic.fromDegrees(104.0, 35.0, 5_000_000),
  );
  camera.lookAt(
    new Vector3(cesiumInitialPosition.x, cesiumInitialPosition.y, cesiumInitialPosition.z),
    Vector3.ZERO,
    new Vector3(0, 0, 1),
  );
  cameraObject.addComponent(GlobeControls, {
    camera,
    domElement: engine.context3D.canvas,
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
      window.setInterval(() => {
        document.body.dataset.globeStatistics = JSON.stringify(globe.statistics);
      }, 500);
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

  const view = new View3D();
  view.scene = scene;
  view.camera = camera as unknown as import('@orillusion/core').Camera3D;
  engine.startRenderView(view);
}

void bootstrap();
