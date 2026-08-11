import {
  AtmosphericComponent,
  Camera3D,
  DirectLight,
  Engine3D,
  HoverCameraController,
  Matrix4,
  Object3D,
  Scene3D,
  Vector3,
  View3D,
} from '@orillusion/core';
import { OrillusionTilesRenderer, TilesRendererComponent } from '../src/index.js';

/** Vite 开发服务器中本地 3D Tiles 样例目录的绝对文件系统地址。 */
const SAMPLE_ROOT = '/@fs/E:/dev-worker-sapce/orillusion_map/data';

/** 3D Tiles 对照样例配置。 */
interface TilesetOption {
  label: string;
  path: string;
  distance: number;
  target: readonly [number, number, number];
  convertedToGlb: boolean;
}

/** 当前适配器可直接加载的本地样例。 */
const TILESET_OPTIONS: readonly TilesetOption[] = [
  { label: '西安大雁塔（3D Tiles 1.1 / glb）', path: 'dayanpagoda-3dtiles-1_1/tileset.json', distance: 700, target: [0, 445, 0], convertedToGlb: true },
  { label: '西安大雁塔（3D Tiles 1.0 / b3dm）', path: 'dayanpagoda-3dtiles/tileset.json', distance: 700, target: [0, 445, 0], convertedToGlb: false },
];

/** 启动 Orillusion 场景、样例选择器与默认 3D Tiles。 */
async function bootstrap(): Promise<void> {
  const engine = await Engine3D.init();
  // Three.js 对照示例使用默认 NoToneMapping。3D Tiles 在此示例中采用无光照
  // 基础贴图展示，关闭 ACES 可使线性场景颜色直接经过 sRGB 交换链输出。
  engine.setting.render.tonemap.enable = false;
  const scene = new Scene3D();
  createSkybox(scene);
  const { camera, controller } = createCamera(engine, scene);
  createLight(scene);
  const selector = document.querySelector<HTMLSelectElement>('#tileset-select');
  const errorTargetInput = document.querySelector<HTMLInputElement>('#error-target');
  const errorTargetValue = document.querySelector<HTMLOutputElement>('#error-target-value');
  if (!selector || !errorTargetInput || !errorTargetValue) throw new Error('未找到 3D Tiles 示例控制器。');

  for (const option of TILESET_OPTIONS) {
    selector.add(new Option(option.label, option.path));
  }

  let selected = getTilesetOption(selector.value);
  let errorTarget = Number(errorTargetInput.value);
  controller.setCamera(45, -20, selected.distance, getCameraTarget(selected.target));
  let activeTileset = addTileset(scene, camera, selected, errorTarget);
  selector.addEventListener('change', () => {
    activeTileset.object.destroy();
    selected = getTilesetOption(selector.value);
    controller.setCamera(45, -20, selected.distance, getCameraTarget(selected.target));
    activeTileset = addTileset(scene, camera, selected, errorTarget);
  });
  errorTargetInput.addEventListener('input', () => {
    errorTarget = Number(errorTargetInput.value);
    errorTargetValue.value = String(errorTarget);
    if (activeTileset.component.renderer) activeTileset.component.renderer.errorTarget = errorTarget;
  });

  const view = new View3D();
  view.scene = scene;
  view.camera = camera;
  engine.startRenderView(view);
}

/**
 * 创建适合本地样例尺寸的透视相机。
 * @param engine Orillusion 引擎实例。
 * @param scene 目标场景。
 * @returns 相机与其交互控制器。
 */
function createCamera(engine: Engine3D, scene: Scene3D): { camera: Camera3D; controller: HoverCameraController } {
  const cameraObject = new Object3D();
  const camera = cameraObject.addComponent(Camera3D);
  camera.perspective(60, engine.aspect, 0.1, 20_000);
  const controller = cameraObject.addComponent(HoverCameraController);
  scene.addChild(cameraObject);
  return { camera, controller };
}

/**
 * 向场景添加方向光。
 * @param scene 目标场景。
 */
function createLight(scene: Scene3D): void {
  const lightObject = new Object3D();
  lightObject.addComponent(DirectLight);
  lightObject.rotationX = 45;
  lightObject.rotationY = 30;
  scene.addChild(lightObject);
}

/**
 * 启用 Orillusion 内置的大气散射天空盒。
 * @param scene 目标场景。
 */
function createSkybox(scene: Scene3D): void {
  const skybox = scene.addComponent(AtmosphericComponent);
  skybox.sunX = 0.35;
  skybox.sunY = 0.6;
  skybox.sunBrightness = 1.2;
}

/**
 * 创建并添加一个可自动更新的 3D Tiles ECS 对象。
 * @param scene 目标场景。
 * @param camera 用于 LOD 判断的相机。
 * @param option 当前样例配置。
 * @param errorTarget 屏幕空间误差阈值。
 * @returns 新建的瓦片根对象及其 ECS 组件。
 */
function addTileset(scene: Scene3D, camera: Camera3D, option: TilesetOption, errorTarget: number): { object: Object3D; component: TilesRendererComponent } {
  const tilesObject = new Object3D();
  const component = tilesObject.addComponent(TilesRendererComponent, {
    url: `${SAMPLE_ROOT}/${option.path}`,
    camera,
    errorTarget,
    onRendererReady: (renderer: OrillusionTilesRenderer) => {
      if (option.convertedToGlb) {
        // 3d-tiles-tools 已将 GLB 节点转换为 Y-up，但此数据集的 boundingVolume
        // 仍以 Z-up 保存；只对 LOD 包围体应用轴校正，避免模型被二次旋转。
        renderer.setBoundingVolumeTransform(createYUpMatrix('z'));
      }
      normalizeTilesetTransform(renderer);
    },
  });
  scene.addChild(tilesObject);
  return { object: tilesObject, component };
}

/**
 * 根据选择器地址查找对应的样例配置。
 * @param path 下拉选项保存的相对地址。
 * @returns 样例配置。
 */
function getTilesetOption(path: string): TilesetOption {
  const option = TILESET_OPTIONS.find(item => item.path === path);
  if (!option) throw new Error(`未知的 3D Tiles 样例：${path}`);
  return option;
}

/**
 * 创建相机控制器需要的目标坐标。
 * @param target 样例配置中的目标坐标。
 * @returns 独立的目标向量，避免控制器修改配置数组。
 */
function getCameraTarget(target: readonly [number, number, number]): Vector3 {
  return new Vector3(target[0], target[1], target[2]);
}

/**
 * 消除 tileset 根节点的地理世界变换，并把内容转换为 Y 轴朝上。
 * @param renderer 已创建的 3D Tiles 渲染器。
 */
function normalizeTilesetTransform(renderer: OrillusionTilesRenderer): void {
  renderer.addEventListener('load-root-tileset', event => {
    const rootTile = event.tileset.root as unknown as { engineData: { transform: Matrix4 } };
    const tilesetInverse = Matrix4.invert(rootTile.engineData.transform);
    if (!tilesetInverse) throw new Error('tileset 根节点变换矩阵不可逆。');

    const asset = event.tileset.asset as unknown as { gltfUpAxis?: string };
    // group 的 MatrixWorld = tilesObject.MatrixWorld × (Y-up × tilesetInverse)，
    // 每个瓦片的 LOD 包围体和模型均再乘各自的 3D Tiles transform。
    renderer.setTilesetTransform(Matrix4.multiply(createYUpMatrix(asset.gltfUpAxis), tilesetInverse));
  });
}

/**
 * 按 tileset 声明的 glTF Up 轴生成 Y-up 校正矩阵。
 * @param gltfUpAxis tileset.asset.gltfUpAxis 的值。
 * @returns 轴校正矩阵。
 */
function createYUpMatrix(gltfUpAxis: string | undefined): Matrix4 {
  const matrix = new Matrix4();
  matrix.identity();
  if (gltfUpAxis?.toLowerCase() === 'x') matrix.createByRotation(-90, Vector3.Y_AXIS);
  if (gltfUpAxis?.toLowerCase() === 'z') matrix.createByRotation(-90, Vector3.X_AXIS);
  return matrix;
}

void bootstrap();
