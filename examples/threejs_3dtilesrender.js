/** Vite 开发服务器中本地 3D Tiles 样例目录的绝对文件系统地址。 */
const SAMPLE_ROOT = '/@fs/E:/dev-worker-sapce/orillusion_map/data';
const THREE_CDN = 'https://cdn.jsdelivr.net/npm/three@0.185.0/build/three.module.js';
const ORBIT_CONTROLS_CDN = 'https://cdn.jsdelivr.net/npm/three@0.185.0/examples/jsm/controls/OrbitControls.js';
const TILES_RENDERER_CDN = 'https://cdn.jsdelivr.net/npm/3d-tiles-renderer@0.5.1/build/index.three.js';
const TILESET_OPTIONS = new Map([
  ['dayanpagoda-3dtiles-1_1/tileset.json', { convertedToGlb: true }],
  ['dayanpagoda-3dtiles/tileset.json', { convertedToGlb: false }],
]);

const [THREE, { OrbitControls }, { TilesRenderer }] = await Promise.all([
  import(THREE_CDN),
  import(ORBIT_CONTROLS_CDN),
  import(TILES_RENDERER_CDN),
]);

/** 启动与 Orillusion 示例相同数据、相机和 LOD 阈值的 Three.js 场景。 */
function bootstrap() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x19242d);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 20_000);
  const target = new THREE.Vector3(0, 445, 0);
  camera.position.set(-169, 940, 465);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(target);
  controls.update();

  const selector = document.querySelector('#tileset-select');
  const errorTargetInput = document.querySelector('#error-target');
  const errorTargetValue = document.querySelector('#error-target-value');
  if (!(selector instanceof HTMLSelectElement) || !(errorTargetInput instanceof HTMLInputElement) || !(errorTargetValue instanceof HTMLOutputElement)) {
    throw new Error('未找到 3D Tiles 示例控制器。');
  }

  let errorTarget = Number(errorTargetInput.value);
  let tiles = createTileset(selector.value, camera, renderer, errorTarget);
  scene.add(tiles.group);
  selector.addEventListener('change', () => {
    scene.remove(tiles.group);
    tiles.dispose();
    tiles = createTileset(selector.value, camera, renderer, errorTarget);
    scene.add(tiles.group);
  });
  errorTargetInput.addEventListener('input', () => {
    errorTarget = Number(errorTargetInput.value);
    errorTargetValue.value = String(errorTarget);
    tiles.errorTarget = errorTarget;
  });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  /** 按帧更新相机、瓦片选择和 WebGL 绘制。 */
  function render() {
    requestAnimationFrame(render);
    controls.update();
    camera.updateMatrixWorld();
    tiles.setResolutionFromRenderer(camera, renderer);
    tiles.update();
    renderer.render(scene, camera);
  }

  render();
}

/**
 * 创建并配置 Three.js 3D Tiles 渲染器。
 * @param {string} relativePath 相对本地样例根目录的 tileset 地址。
 * @param {import('three').PerspectiveCamera} camera 用于 LOD 计算的透视相机。
 * @param {import('three').WebGLRenderer} renderer Three.js WebGL 渲染器。
 * @param {number} errorTarget 屏幕空间误差阈值。
 * @returns {import('3d-tiles-renderer/three').TilesRenderer} 已配置的瓦片渲染器。
 */
function createTileset(relativePath, camera, renderer, errorTarget) {
  const option = TILESET_OPTIONS.get(relativePath);
  if (!option) throw new Error(`未知的 3D Tiles 样例：${relativePath}`);
  const tiles = new TilesRenderer(`${SAMPLE_ROOT}/${relativePath}`);
  tiles.errorTarget = errorTarget;
  tiles.setCamera(camera);
  tiles.setResolutionFromRenderer(camera, renderer);
  if (option.convertedToGlb) installYUpBoundingVolumeAdapter(tiles);

  tiles.addEventListener('load-root-tileset', event => {
    // 1.1 GLB 节点已经是 Y-up，禁用适配器的额外内容旋转；1.0 b3dm
    // 则由 group 统一执行 Z-up 到 Y-up 的校正。
    tiles._upRotationMatrix.identity();
    const rootTransform = new THREE.Matrix4().fromArray(event.tileset.root.transform);
    const tilesetInverse = rootTransform.invert();
    if (option.convertedToGlb) {
      tiles.group.applyMatrix4(tilesetInverse);
    } else {
      tiles.group.applyMatrix4(new THREE.Matrix4().makeRotationX(-Math.PI / 2).multiply(tilesetInverse));
    }
    tiles.group.updateMatrixWorld(true);
  });
  tiles.addEventListener('load-model', event => applyUnlitMaterials(event.scene));
  return tiles;
}

/**
 * 将升级数据中仍为 Z-up 的包围体转换为 Y-up，供 Three.js 的 LOD 判断使用。
 * @param {import('3d-tiles-renderer/three').TilesRenderer} tiles 目标瓦片渲染器。
 */
function installYUpBoundingVolumeAdapter(tiles) {
  const rotation = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
  const processedTiles = new WeakSet();
  const preprocessNode = tiles.preprocessNode.bind(tiles);

  tiles.preprocessNode = (tile, ...args) => {
    if (!processedTiles.has(tile)) {
      rotateBoundingVolume(tile.boundingVolume, rotation);
      processedTiles.add(tile);
    }
    preprocessNode(tile, ...args);
  };
}

/**
 * 原地旋转 3D Tiles 的 box 或 sphere 包围体定义。
 * @param {{ box?: number[], sphere?: number[] }} boundingVolume 瓦片包围体定义。
 * @param {import('three').Matrix4} rotation Z-up 到 Y-up 的旋转矩阵。
 */
function rotateBoundingVolume(boundingVolume, rotation) {
  if (boundingVolume.box) {
    const box = boundingVolume.box;
    const center = new THREE.Vector3(box[0], box[1], box[2]).applyMatrix4(rotation);
    box[0] = center.x;
    box[1] = center.y;
    box[2] = center.z;
    for (let index = 0; index < 3; index += 1) {
      const offset = 3 + index * 3;
      const axis = new THREE.Vector3(box[offset], box[offset + 1], box[offset + 2]).applyMatrix4(rotation);
      box[offset] = axis.x;
      box[offset + 1] = axis.y;
      box[offset + 2] = axis.z;
    }
  } else if (boundingVolume.sphere) {
    const sphere = boundingVolume.sphere;
    const center = new THREE.Vector3(sphere[0], sphere[1], sphere[2]).applyMatrix4(rotation);
    sphere[0] = center.x;
    sphere[1] = center.y;
    sphere[2] = center.z;
  }
}

/**
 * 将加载的模型改为无光照材质，以便与 Orillusion 示例保持一致。
 * @param {import('three').Object3D} scene 已加载的瓦片场景对象。
 */
function applyUnlitMaterials(scene) {
  scene.traverse(object => {
    if (!object.isMesh) return;
    const hasMultipleMaterials = Array.isArray(object.material);
    const sourceMaterials = hasMultipleMaterials ? object.material : [object.material];
    const unlitMaterials = sourceMaterials.map(source => new THREE.MeshBasicMaterial({
      map: source.map ?? null,
      color: 0xffffff,
      side: source.side,
      transparent: source.transparent,
      opacity: source.opacity,
      alphaTest: source.alphaTest,
    }));
    object.material = hasMultipleMaterials ? unlitMaterials : unlitMaterials[0];
  });
}

bootstrap();
