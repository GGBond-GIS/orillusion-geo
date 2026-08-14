# 地形对数深度截断问题

## 结论

Ion Terrain 在 `useLogDepth: true` 时会出现局部黑色三角区域和看似近平面截断的画面。关闭全局 `useLogDepth` 后，使用相同相机位置和操作路径无法复现该问题。问题不由相机 `near` 值、CPU 四叉树近平面剔除或影像纹理采样引起。

当前地形材质已恢复为 Orillusion 的默认对数深度路径，CPU 四叉树近平面剔除也已恢复。该文档记录问题的最小证据和需要在 Orillusion 内核处理的差异。

## 已排除项

- 将 `CesiumGlobeTileMaterial` 单独退出 LogDepth 分支后，黑色截断仍然出现；单材质宏覆写不能替代全局 LogDepth 配置。
- 临时跳过 `GlobeQuadtree` 的 CPU near-plane 包围球测试后，黑色三角区域仍然出现，并且可见更明显的异常几何边界。
- 地形的 WebMercator 裙边 UV 修复只影响裙边影像采样，不改变顶点深度或地形面片的裁剪。

## Orillusion 当前路径

Orillusion 的 `Common_vert` 在顶点阶段先计算常规投影位置，再在 `USE_LOGDEPTH` 下直接覆盖 `clipPosition.z`：

~~~wgsl [Orillusion Common_vert]
var clipPosition = ORI_MATRIX_P * viewPosition;

#if USE_LOGDEPTH
  clipPosition.z = log2Depth(clipPosition.w, globalUniform.near, globalUniform.far);
#endif
~~~

同一份 `clipPosition` 同时作为顶点的 `@builtin(position)` 输出和 `varying_Clip` 传给片元阶段。随后 `Common_frag` 在 `USE_OUTDEPTH && USE_LOGDEPTH` 下，根据透视校正后的 `varying_Clip.w` 再次计算并写入 `@builtin(frag_depth)`：

~~~wgsl [Orillusion Common_frag]
ORI_FragmentOutput.out_depth = log2DepthFixPersp(
  ORI_VertexVarying.fragPosition.w,
  globalUniform.near,
  globalUniform.far,
);
~~~

这条路径同时改变了顶点裁剪坐标的 `z`，又在片元阶段写入对数深度。顶点输出的 `z` 不再保留常规投影深度，因此硬件对大地形三角形执行 near/far 裁剪时使用的是对数映射后的值。`log2Depth` 实际只使用 `far`，不会保留常规近平面关系。

## Three.js 对比

Three.js 的常规对数深度路径不改写 `gl_Position.z`。顶点阶段只保存 `1.0 + gl_Position.w` 和透视投影标识；片元阶段才写入对数深度：

~~~glsl [Three.js logdepthbuf_vertex.glsl.js]
vFragDepth = 1.0 + gl_Position.w;
vIsPerspective = float( isPerspectiveMatrix( projectionMatrix ) );
~~~

~~~glsl [Three.js logdepthbuf_fragment.glsl.js]
gl_FragDepth = vIsPerspective == 0.0
  ? gl_FragCoord.z
  : log2( vFragDepth ) * logDepthBufFC * 0.5;
~~~

因此 Three.js 保留常规 `gl_Position` 供硬件裁剪和光栅化，仅替换写入深度缓冲的值。相关源码：

- https://raw.githubusercontent.com/mrdoob/three.js/dev/src/renderers/shaders/ShaderChunk/logdepthbuf_vertex.glsl.js
- https://raw.githubusercontent.com/mrdoob/three.js/dev/src/renderers/shaders/ShaderChunk/logdepthbuf_fragment.glsl.js

## 建议修复

Orillusion 应将对数深度限定在片元深度写入阶段。`ORI_Vert` 应保留线性的 `clipPosition.z` 作为 `@builtin(position)` 输出，同时把原始 `clipPosition.w` 传给片元阶段。`Common_frag` 可以继续使用该 `w` 计算并写入 `@builtin(frag_depth)`。

该修复应放在 Orillusion 的公共 shader 路径，而不是只放在地形材质。地形瓦片包含跨度很大的三角形，最容易暴露顶点阶段重写 `clip.z` 带来的裁剪错误，但相同的顶点裁剪语义也会影响其他大尺度网格。

## 验证标准

开启 `useLogDepth: true` 后，在 Ion Terrain 示例中以贴地、低俯角和瓦片尚未全部细化的视角移动相机。画面不应出现局部黑色三角洞、沿单个大三角形边界的截断，或在精细瓦片加载后才恢复正常的现象。
