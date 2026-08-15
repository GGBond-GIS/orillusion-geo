# Orillusion Geo

Orillusion Geo 是一个基于 [Orillusion](https://www.orillusion.com/)、WebGPU 与 Cesium Engine 的三维 GIS 实验库。它将 Cesium 的地形和影像数据流、3D Tiles 的 LOD 调度，以及 Orillusion 的 ECS 渲染模型组合在一起，用于构建可交互的地球场景。

![Orillusion Geo 3D Tiles 预览](./data/images/3dtiles.png)

## 已实现功能

- **3D Tiles 加载与调度**：通过 ECS `TilesRendererComponent` 加载 3D Tiles 1.0（B3DM）和 1.1（GLB），并支持屏幕空间误差（SSE）LOD、请求缓存、tileset 根变换及 Y-up/Z-up 坐标校正。
- **地球、地形与影像**：`Globe` 使用四叉树选择可见瓦片，支持 Cesium `TerrainProvider`、椭球地形和 Cesium World Terrain。影像层直接使用 Cesium `ImageryProvider`，包括请求、祖先影像回退、纹理上传与 Web Mercator 重投影。
- **大范围地球渲染**：提供相对相机渲染（RTE）、双精度矩阵、对数深度及矩阵池配置入口，适用于 ECEF 世界坐标中的大尺度场景。
- **交互控制与拾取**：提供面向地球的相机控制器，以及可选的 CPU 三角形射线拾取；拾取结果可转换为经纬度、高程和 ECEF 坐标。
- **地形与 3D Tiles 同场景显示**：示例将 Cesium World Terrain、天地图影像和本地大雁塔 3D Tiles 数据放在同一 ECEF 坐标系中渲染。

> 项目仍处于实验阶段。当前 API 和渲染策略可能变化；矢量图元、标注、编辑能力和完整的 Cesium API 兼容层尚未提供。

## 环境要求

- Node.js 20 或更高版本。
- 支持 WebGPU 的现代浏览器，例如 Chrome 或 Edge。
- 使用 Cesium World Terrain 或在线影像示例时，需要可以访问相应的网络服务。

## 安装与运行

安装依赖并启动 Vite 开发服务器：

```bash
npm install
npm run dev
```

运行后，Vite 会输出本地访问地址。使用以下页面查看示例：

| 地址 | 说明 |
| --- | --- |
| `/` | 3D Tiles 示例导航页。 |
| `/examples/orillusion_3dtilesrender.html` | Orillusion WebGPU 3D Tiles 示例；可切换大雁塔 3D Tiles 1.0/1.1 数据并调整 `LOD Error Target`。 |
| `/examples/threejs_3dtilesrender.html` | 使用同一数据集的 Three.js CDN 对照示例。 |
| `/examples/orillusion_globe.html` | 椭球地形与在线影像 Globe 示例。 |
| `/examples/orillusion_ion_terrain.html` | Cesium World Terrain、在线影像和大气效果示例。 |
| `/examples/orillusion_ion_terrain_3dtiles.html` | Cesium World Terrain 与原始 ECEF 大雁塔 3D Tiles 同场景示例。 |
| `/examples/globe_gpu_pick.html` | 地表 CPU 射线拾取示例；点击地球可查看经纬度、高程和 ECEF 坐标。 |

在线地形和影像示例依赖 Cesium ion、天地图及 Orillusion CDN 资源；网络不可用、服务限流或凭据失效时，相关资源可能无法加载。本地大雁塔数据位于 `data/`，可用于离线的 3D Tiles 示例。

## 构建库

运行以下命令生成可发布的库文件：

```bash
npm run build
```

构建入口为 `src/index.ts`，产物输出到 `dist/`。包导出 3D Tiles、Globe、地形影像、控制器、空间计算与射线拾取相关 API；`@orillusion/core`、`@cesium/engine` 和 `3d-tiles-renderer` 作为运行时依赖保留在包外。

## 基本用法

调用 `configureGlobeRendering` 必须早于 `Engine3D.init()`。随后将 `GlobeComponent` 挂载到场景对象，并将用于 LOD 选择的相机传入组件：

```ts
import { Engine3D, Object3D, Scene3D } from '@orillusion/core';
import { EllipsoidTerrainProvider } from '@cesium/engine';
import {
  configureGlobeRendering,
  GlobeComponent,
  ThreeConventionCamera3D,
} from '@orillusion-geo/core';

configureGlobeRendering({ matrixCapacity: 4_096 });
const engine = await Engine3D.init({
  setting: { useRTE: true, doublePrecision: true },
});

const scene = new Scene3D();
const cameraObject = new Object3D();
const camera = cameraObject.addComponent(ThreeConventionCamera3D);
scene.addChild(cameraObject);

const globeObject = new Object3D();
globeObject.addComponent(GlobeComponent, {
  camera,
  terrainProvider: new EllipsoidTerrainProvider(),
  initialTiles: [{ x: 0, y: 0, level: 0 }, { x: 1, y: 0, level: 0 }],
  onReady: (globe) => {
    // globe.addImageryProvider(yourCesiumImageryProvider)
  },
});
scene.addChild(globeObject);
```

使用 `TilesRendererComponent` 将 3D Tiles 根目录挂载到任意 Orillusion 对象。组件会在生命周期中自动更新加载和 LOD 选择：

```ts
import { Object3D } from '@orillusion/core';
import { TilesRendererComponent } from '@orillusion-geo/core';

const tilesObject = new Object3D();
tilesObject.addComponent(TilesRendererComponent, {
  url: '/data/dayanpagoda-3dtiles-1_1/tileset.json',
  camera,
  errorTarget: 6,
});
scene.addChild(tilesObject);
```

有关相机初始位置、坐标轴转换和完整渲染配置，请参考 `examples/` 中的可运行示例。

## 主要导出

| 分类 | API |
| --- | --- |
| 3D Tiles | `TilesRendererComponent`、`OrillusionTilesRenderer`、`TileBoundingVolume` |
| Globe | `Globe`、`GlobeComponent`、`GlobeQuadtree`、`CesiumSurfaceTile` |
| 渲染与影像 | `configureGlobeRendering`、`CesiumGlobeTileMaterial`、`GlobeReprojectionCompute`、`CesiumImageryRuntime` |
| 控制与空间计算 | `GlobeControls`、`EnvironmentControls`、`ThreeConventionCamera3D`、`Ellipsoid`、`WGS84_ELLIPSOID` |
| 拾取 | `installRayPick`、`SceneRayPick`、`Raycaster` |

## 项目结构

```text
src/
├─ Controls/             # Globe 相机控制、指针和几何工具
├─ Globe/                # Globe ECS 组件与瓦片生命周期管理
├─ Math/                 # 椭球、3D Tiles 包围体和空间计算
├─ Renderer/             # Orillusion 渲染、材质与投影适配
├─ Scheduler/            # 地形与影像的帧内任务、缓存淘汰队列
├─ Terrain/              # Cesium 地形、影像状态机和四叉树选择
└─ ray-pick/             # CPU 射线拾取
examples/                # 可直接运行的 3D Tiles、Globe、地形和拾取示例
data/                    # 本地大雁塔 3D Tiles 测试数据及预览图
public/cesium/           # Cesium Worker 与运行时资源
```

## 已知问题

地形场景启用 Orillusion 全局 `useLogDepth` 时，在低俯角和大三角形条件下可能出现局部黑色三角区域或看似近平面截断的现象。问题分析和建议修复方案记录在 [LOG_DEPTH_ISSUE.md](./LOG_DEPTH_ISSUE.md)。

## 依赖

- [Orillusion](https://www.orillusion.com/)：WebGPU 渲染和 ECS 框架。
- [Cesium Engine](https://cesium.com/platform/cesiumjs/)：地形、影像、投影和地理空间数据类型。
- [3DTilesRendererJS](https://github.com/NASA-AMMOS/3DTilesRendererJS)：3D Tiles 请求、缓存和 LOD 调度。
