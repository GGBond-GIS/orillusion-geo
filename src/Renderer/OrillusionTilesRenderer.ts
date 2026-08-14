import { B3DMLoader, Camera3D, Color, Engine3D, Matrix4, MeshRenderer, Object3D, Quaternion, UnLitMaterial, Vector3 } from '@orillusion/core';
import { TilesRendererBase, type TilesRendererBaseEventMap } from '3d-tiles-renderer/core';
import { TileBoundingVolume, type TileBoundingVolumeDefinition } from '../Math/TileBoundingVolume.js';

interface Tile {
  boundingVolume: TileBoundingVolumeDefinition;
  geometricError: number;
  transform?: readonly number[];
  content?: TileContent;
  contents?: TileContent[];
  engineData: TileEngineData;
}

interface TileContent {
  uri?: string;
  url?: string;
}

interface TileEngineData {
  boundingVolume: TileBoundingVolume;
  node: Object3D | null;
  scene: Object3D | null;
  transform: Matrix4;
}

interface TileViewTarget {
  inView: boolean;
  error: number;
  distanceFromCamera: number;
}

interface TilesRendererRuntime {
  loadRootTileset(...args: unknown[]): Promise<{ asset?: { gltfUpAxis?: string } }>;
  preprocessNode(tile: Tile, tilesetDir: string, parentTile: Tile | null): void;
  disposeTile(tile: Tile): void;
  setTileVisible(tile: Tile, visible: boolean): void;
}

/**
 * 将 3d-tiles-renderer/core 的调度、缓存与 LOD 能力映射到 Orillusion 对象树。
 */
export class OrillusionTilesRenderer extends TilesRendererBase {
  /** 所有已加载瓦片的 ECS 根节点。 */
  public readonly group = new Object3D();
  private readonly engine: Engine3D;
  private readonly camera: Camera3D;
  private readonly tilesetTransform = new Matrix4();
  private readonly boundingVolumeTransform = new Matrix4();
  private readonly contentTransform = new Matrix4();
  private readonly eventListeners = new Map<string, Set<(event: unknown) => void>>();

  /**
   * 创建渲染器。
   * @param url 根 tileset.json 的地址。
   * @param engine 资源加载所使用的 Orillusion 引擎实例。
   * @param camera 用于 LOD 与视锥计算的相机。
   */
  public constructor(url: string, engine: Engine3D, camera: Camera3D) {
    super(url);
    this.engine = engine;
    this.camera = camera;
    this.group.name = '3D Tiles Root';
    this.tilesetTransform.identity();
    this.boundingVolumeTransform.identity();
  }

  /**
   * 读取 tileset 元数据并执行与 Babylon 适配层一致的 glTF Up 轴校正。
   * @param args core 传入的加载参数。
   * @returns 已加载的根 tileset。
   */
  public loadRootTileset(...args: unknown[]): Promise<{ asset?: { gltfUpAxis?: string } }> {
    return this.getBaseRuntime().loadRootTileset.apply(this, args).then(tileset => {
      const upAxis = tileset.asset?.gltfUpAxis?.toLowerCase();
      const upTransform = new Matrix4();
      upTransform.identity();
      if (upAxis === 'x') upTransform.createByRotation(-90, Vector3.Y_AXIS);
      if (upAxis === 'z') upTransform.createByRotation(-90, Vector3.X_AXIS);
      this.setTilesetTransform(upTransform);
      return tileset;
    });
  }

  /**
   * 注册 3D Tiles 生命周期事件监听器。
   * @param name 事件名称。
   * @param callback 事件回调。
   */
  public addEventListener<T extends keyof TilesRendererBaseEventMap>(name: T, callback: (event: TilesRendererBaseEventMap[T] & { type: T }) => void): void;
  public addEventListener(name: string, callback: (event: unknown) => void): void;
  public addEventListener(name: string, callback: (event: unknown) => void): void {
    let listeners = this.eventListeners.get(name);
    if (!listeners) {
      listeners = new Set();
      this.eventListeners.set(name, listeners);
    }
    listeners.add(callback);
  }

  /**
   * 移除 3D Tiles 生命周期事件监听器。
   * @param name 事件名称。
   * @param callback 事件回调。
   */
  public removeEventListener<T extends keyof TilesRendererBaseEventMap>(name: T, callback: (event: TilesRendererBaseEventMap[T] & { type: T }) => void): void;
  public removeEventListener(name: string, callback: (event: unknown) => void): void;
  public removeEventListener(name: string, callback: (event: unknown) => void): void {
    this.eventListeners.get(name)?.delete(callback);
  }

  /**
   * 向当前渲染器派发 core 生命周期事件。
   * @param event 事件对象。
   */
  public dispatchEvent<T extends keyof TilesRendererBaseEventMap>(event: TilesRendererBaseEventMap[T] & { type: T }): void;
  public dispatchEvent(event: { type: string }): void;
  public dispatchEvent(event: { type: string }): void {
    for (const listener of this.eventListeners.get(event.type) ?? []) listener(event);
  }

  /**
   * 预处理瓦片并保存其继承后的世界变换与包围体。
   * @param tile 当前瓦片。
   * @param tilesetDir 当前 tileset 的目录。
   * @param parentTile 父级瓦片，没有父级时为 null。
   */
  public preprocessNode(tile: Tile, tilesetDir: string, parentTile: Tile | null = null): void {
    // 3D Tiles 1.1 的多内容瓦片由 core 的单 content 调度一次，再由 parseTile 加载其余内容。
    if (!tile.content && tile.contents?.length) tile.content = tile.contents[0];
    this.getBaseRuntime().preprocessNode.call(this, tile, tilesetDir, parentTile);
    const transform = this.createTileTransform(tile.transform, parentTile?.engineData.transform);
    tile.engineData.transform = transform;
    tile.engineData.boundingVolume = new TileBoundingVolume(tile.boundingVolume, this.getTileWorldMatrix(tile));
    tile.engineData.node = null;
  }

  /**
   * 加载 b3dm、glb 或 gltf 瓦片为 Orillusion 的 Object3D。
   * @param _buffer 已下载的二进制数据；b3dm 使用该数据避免重复下载。
   * @param tile 当前瓦片。
   * @param extension 内容扩展名。
   * @param url 内容绝对地址。
   * @param abortSignal 取消信号。
   */
  public async parseTile(_buffer: ArrayBuffer, tile: Tile, extension: string, url: string, abortSignal: AbortSignal): Promise<void> {
    const type = this.getContentType(_buffer, extension);
    const scene = new Object3D();
    scene.name = `3D Tile Content: ${url}`;
    scene.addChild(await this.loadContent(_buffer, type, url));

    // `contents` 是 3D Tiles 1.1 的多内容定义。首个内容由 core 下载，其余内容在此并行加载。
    const additionalContents = tile.contents?.slice(1) ?? [];
    await Promise.all(additionalContents.map(async content => {
      const contentUrl = new URL(this.getContentUri(content), url).href;
      const response = await fetch(contentUrl, { ...this.fetchOptions, signal: abortSignal });
      if (!response.ok) throw new Error(`瓦片内容请求失败：${response.status} ${contentUrl}`);
      const buffer = await response.arrayBuffer();
      scene.addChild(await this.loadContent(buffer, this.getContentType(buffer, this.getUrlExtension(contentUrl)), contentUrl));
    }));

    if (abortSignal.aborted) {
      scene.destroy();
      return;
    }

    const node = new Object3D();
    node.name = `3D Tile: ${url}`;
    this.applyMatrix(node, tile.engineData.transform);
    node.addChild(scene);
    this.group.addChild(node);
    node.transform.enable = false;
    tile.engineData.node = node;
    tile.engineData.scene = scene;
  }

  /**
   * 释放被 LRU 缓存淘汰的瓦片对象。
   * @param tile 需要释放的瓦片。
   */
  public disposeTile(tile: Tile): void {
    this.getBaseRuntime().disposeTile.call(this, tile);
    tile.engineData.node?.destroy();
    tile.engineData.node = null;
    tile.engineData.scene = null;
  }

  /**
   * 显示或隐藏瓦片，并同步 core 中的可见集。
   * @param tile 目标瓦片。
   * @param visible 是否显示。
   */
  public setTileVisible(tile: Tile, visible: boolean): void {
    if (tile.engineData.node) tile.engineData.node.transform.enable = visible;
    this.getBaseRuntime().setTileVisible.call(this, tile, visible);
  }

  /**
   * 依据相机距离、投影参数和 Orillusion 视锥计算屏幕空间误差。
   * @param tile 当前瓦片。
   * @param target core 提供的输出对象。
   */
  public calculateTileViewError(tile: Tile, target: TileViewTarget): void {
    const cameraPosition = this.camera.object3D.transform.worldPosition;
    const volume = tile.engineData.boundingVolume;
    const distance = volume.distanceToPoint(cameraPosition);
    const viewportHeight = Math.max(1, this.engine.height);
    const fovRadians = this.camera.fov * Math.PI / 180;
    const denominator = 2 * Math.tan(fovRadians / 2) / viewportHeight;
    target.inView = volume.intersectsFrustum(point => this.camera.frustum.containsPoint(point));
    target.error = distance === 0 ? Number.POSITIVE_INFINITY : tile.geometricError / (distance * denominator);
    target.distanceFromCamera = distance;
  }

  /** 释放 core 缓存与 Orillusion 对象树。 */
  public override dispose(): void {
    super.dispose();
    this.eventListeners.clear();
    this.group.destroy();
  }

  /**
   * 设置显示和 LOD 计算共同使用的场景坐标变换。
   * @param transform group 相对父对象的局部变换，例如“Y-up 校正 × 根 tileset 逆矩阵”。
   */
  public setTilesetTransform(transform: Matrix4): void {
    this.tilesetTransform.copy(transform);
    this.applyMatrix(this.group, this.tilesetTransform);
    this.group.transform.updateWorldMatrix(true);
    this.traverse(tileValue => {
      const tile = tileValue as Tile;
      const worldMatrix = this.getTileWorldMatrix(tile);
      tile.engineData.boundingVolume = new TileBoundingVolume(tile.boundingVolume, worldMatrix);
      if (tile.engineData.node) this.applyMatrix(tile.engineData.node, tile.engineData.transform);
      return false;
    }, null);
  }

  /**
   * 设置每个瓦片内容在 tileset 局部坐标系中的变换。
   *
   * 该变换在 tile.transform 之前作用于 GLB/B3DM 内容，适用于内容坐标轴和
   * tileset 包围体坐标轴不一致的非标准数据集。请在开始加载根 tileset 前调用。
   */
  public setContentTransform(transform: Matrix4): void {
    this.contentTransform.copy(transform);
  }

  /**
   * 设置只用于 LOD 与视锥计算的包围体局部变换。
   * @param transform 将 tileset boundingVolume 坐标转换到已渲染模型坐标的局部变换。
   */
  public setBoundingVolumeTransform(transform: Matrix4): void {
    this.boundingVolumeTransform.copy(transform);
    this.traverse(tileValue => {
      const tile = tileValue as Tile;
      tile.engineData.boundingVolume = new TileBoundingVolume(tile.boundingVolume, this.getTileWorldMatrix(tile));
      return false;
    }, null);
  }

  /**
   * 创建并累积 3D Tiles 的列主序变换矩阵。
   * @param values 当前瓦片 transform。
   * @param parentTransform 父瓦片变换。
   * @returns 当前瓦片的世界变换。
   */
  private createTileTransform(values: readonly number[] | undefined, parentTransform: Matrix4 | undefined): Matrix4 {
    const result = new Matrix4();
    result.identity();
    if (values) result.rawData.set(values);
    return parentTransform ? Matrix4.multiply(parentTransform, result) : result;
  }

  /**
   * 将矩阵分解后写入 Orillusion 的 ECS Transform。
   * @param object 目标对象。
   * @param matrix 要应用的世界变换。
   */
  private applyMatrix(object: Object3D, matrix: Matrix4): void {
    const position = matrix.getPosition();
    const scale = new Vector3();
    scale.setFromMatrixScale(matrix);
    const rotation = new Quaternion();
    matrix.decompose('quaternion', [position, rotation as unknown as Vector3, scale]);
    object.localPosition = position;
    object.localScale = scale;
    object.localQuaternion = rotation;
  }

  /** 获取 core 未在公开类型中声明的运行时钩子。 */
  private getBaseRuntime(): TilesRendererRuntime {
    return TilesRendererBase.prototype as unknown as TilesRendererRuntime;
  }

  /**
   * 解析一个内容缓冲区为 Orillusion 对象。
   * @param buffer 内容二进制数据。
   * @param type 内容类型。
   * @param url 内容 URL。
   * @returns 可挂接到瓦片节点的对象。
   */
  private async loadContent(buffer: ArrayBuffer, type: string, url: string): Promise<Object3D> {
    let scene: Object3D;
    if (type === 'b3dm') {
      scene = await new B3DMLoader().parse(buffer);
    } else if (type === 'glb' || type === 'gltf') {
      scene = await this.engine.res.loadGltf(url);
    } else {
      throw new Error(`OrillusionTilesRenderer 不支持 “${type}” 类型的瓦片。`);
    }
    this.applyMatrix(scene, this.contentTransform);
    this.applyUnlitMaterials(scene);
    return scene;
  }

  /**
   * 将瓦片内的 PBR 材质转换为保留原贴图的无光照材质。
   * @param scene 已解析的瓦片根对象。
   */
  private applyUnlitMaterials(scene: Object3D): void {
    for (const mesh of scene.getComponents(MeshRenderer)) {
      const source = mesh.material;
      if (source instanceof UnLitMaterial) continue;

      // 与官方 UnLitMaterial 示例保持一致：只设置基础贴图和颜色。
      // 部分 glTF 导入材质虽继承 LitMaterial，却没有完整的 PBR uniform，读取
      // source.baseColor 会触发 shader.getUniform(...).data 的空引用。
      const material = new UnLitMaterial(this.engine.context3D);
      material.name = `${source.name || '3D Tiles'} UnLit`;
      material.doubleSide = source.doubleSide;
      material.cullMode = source.cullMode;
      // UnLit 着色器始终读取 baseMap；无贴图材质使用引擎白贴图作为占位。
      const baseMap = source.getTexture('baseMap') ?? this.engine.res.whiteTexture;
      material.baseMap = baseMap;
      // 仅当 GPU 纹理实际为 sRGB 格式时跳过 shader 解码。部分 GLB 的嵌入
      // 图像会声明 colorSpace='srgb'，但仍以 rgba8unorm 上传；此时仍需在
      // shader 中执行 gamma 解码，才能与 Three.js 的 GLTFLoader 输出一致。
      const usesHardwareSrgbDecode = baseMap.format === 'rgba8unorm-srgb';
      material.setDefine('USE_SRGB_ALBEDO', usesHardwareSrgbDecode);
      material.baseColor = new Color(1, 1, 1, 1);
      this.initializeUnlitGBufferUniforms(material);
      mesh.material = material;
      mesh.receiveShadow = false;
    }
  }

  /**
   * 补齐延迟渲染 GBuffer Pass 会读取的无光照材质 uniform。
   * @param material 已创建的无光照材质。
   */
  private initializeUnlitGBufferUniforms(material: UnLitMaterial): void {
    // Orillusion 的 GBuffer 生成逻辑会无条件复制这些值，但 UnLitMaterial
    // 默认只创建 baseColor、alphaCutoff 与 UV uniform。
    material.setUniformFloat('envIntensity', 0);
    material.setUniformColor('emissiveColor', new Color(0, 0, 0, 1));
    material.setUniformFloat('emissiveIntensity', 0);
    material.setUniformFloat('alphaCutoff', 0);
  }

  /**
   * 获取 3D Tiles 瓦片实际参与渲染与 LOD 判断的世界矩阵。
   * @param tile 当前瓦片。
   * @returns 用于模型和包围体的统一变换。
   */
  private getTileWorldMatrix(tile: Tile): Matrix4 {
    const tileWorldMatrix = Matrix4.multiply(this.group.transform.worldMatrix, tile.engineData.transform);
    return Matrix4.multiply(tileWorldMatrix, this.boundingVolumeTransform);
  }

  /**
   * 获取 3D Tiles 内容 URI，兼容旧版 url 字段。
   * @param content 内容描述。
   * @returns 内容相对地址。
   */
  private getContentUri(content: TileContent): string {
    const uri = content.uri ?? content.url;
    if (!uri) throw new Error('3D Tiles 内容缺少 uri。');
    return uri;
  }

  /**
   * 从 URL 中提取扩展名。
   * @param url 内容地址。
   * @returns 不带点号的小写扩展名。
   */
  private getUrlExtension(url: string): string {
    const pathname = new URL(url).pathname;
    const dot = pathname.lastIndexOf('.');
    return dot === -1 ? '' : pathname.slice(dot + 1).toLowerCase();
  }

  /**
   * 读取二进制魔数，兼容没有可靠扩展名的 b3dm 文件。
   * @param buffer 已下载的内容数据。
   * @param extension URL 扩展名。
   * @returns 小写内容类型。
   */
  private getContentType(buffer: ArrayBuffer, extension: string): string {
    if (buffer.byteLength >= 4) {
      const magic = new TextDecoder().decode(new Uint8Array(buffer, 0, 4));
      if (magic === 'b3dm') return 'b3dm';
      if (magic === 'glTF') return 'glb';
    }
    return extension.toLowerCase().replace('.', '');
  }
}
