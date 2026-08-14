import { Context3D, Float32ArrayTexture, RenderShaderPass, Shader, ShaderLib, Texture, UnLitMaterial } from '@orillusion/core';
import type { Cartesian4, ImageryLayer, Rectangle } from '@cesium/engine';

/** 单次绘制支持的最大影像图层数。 */
const maximumImageryLayers = 4;
/** 全部 Globe 瓦片共享同一份 WGSL，避免每瓦片永久注册 shader 和重复创建 pipeline。 */
const globeTileShaderName = 'CesiumGlobeTileShared';
/** 参数纹理宽度（RGBA32Float）：图层数、采样标志、矩形、变换、图层属性、colorToAlpha、cutout。 */
const imageryParameterTextureWidth = 32;

/** Cesium TileImagery 在 Globe tile shader 中的采样参数。 */
export interface CesiumGlobeTileTexture {
  /** 已上传或经计算重投影的影像纹理。 */
  texture: Texture;
  /** Cesium textureCoordinateRectangle，顺序为 west、south、east、north。 */
  textureCoordinateRectangle: Cartesian4;
  /** Cesium 计算出的纹理平移与缩放。 */
  textureTranslationAndScale: Cartesian4;
  /** 是否以 WebMercator T 计算纹理 V 坐标。 */
  useWebMercatorT: boolean;
  /** 对应的 Cesium ImageryLayer，用于读取 alpha/brightness/contrast/hue/saturation/gamma/split/colorToAlpha。 */
  imageryLayer?: ImageryLayer;
}

/** 从 Cesium ImageryLayer 读取的图层属性（带 Cesium 默认值）。 */
interface LayerProperties {
  alpha: number;
  brightness: number;
  contrast: number;
  saturation: number;
  hue: number;
  gamma: number;
  splitDirection: number;
  colorToAlpha: { red: number; green: number; blue: number; alpha: number } | null;
  colorToAlphaThreshold: number;
  cutoutRectangle: Rectangle | null;
}

const defaultLayerProperties: LayerProperties = {
  alpha: 1.0,
  brightness: 1.0,
  contrast: 1.0,
  saturation: 1.0,
  hue: 0.0,
  gamma: 1.0,
  splitDirection: 0.0,
  colorToAlpha: null,
  colorToAlphaThreshold: 0.004,
  cutoutRectangle: null,
};

/**
 * Cesium GlobeSurfaceTileMaterial 的 Orillusion 材质移植。
 * shader 与 pipeline 在全部瓦片之间共享，瓦片差异只写入 group(2) uniform 和纹理绑定。
 */
export class CesiumGlobeTileMaterial extends UnLitMaterial {
  private readonly context: Context3D;
  private readonly imageryParameterTexture: Float32ArrayTexture;
  private destroyed = false;

  /**
   * 创建一个瓦片材质。
   * @param context Orillusion 当前 WebGPU 上下文，用于更新参数纹理。
   * @param imagery Cesium TileImagery 对应的纹理与采样信息。
   */
  public constructor(context: Context3D, imagery: CesiumGlobeTileTexture[]) {
    super(context);
    this.context = context;
    if (imagery.length === 0) throw new Error('CesiumGlobeTileMaterial 至少需要一张影像纹理。');
    if (imagery.length > maximumImageryLayers) throw new Error(`单瓦片影像图层不能超过 ${maximumImageryLayers} 个。`);
    ShaderLib.register(globeTileShaderName, globeTileShader);
    const shader = new Shader();
    const pass = new RenderShaderPass(globeTileShaderName, globeTileShaderName);
    pass.setShaderEntry('VertMain', 'FragMain');
    pass.shaderState.useLight = false;
    pass.shaderState.acceptShadow = false;
    pass.shaderState.receiveEnv = false;
    shader.addRenderPass(pass);
    this.shader = shader;
    // 使用 32×1 RGBA32Float 参数纹理保持 512 字节行对齐，避免瓦片退出帧时异步 BindGroup 引用已销毁 StorageGPUBuffer。
    this.imageryParameterTexture = new Float32ArrayTexture();
    // Orillusion Float32ArrayTexture 在 filtering=true 时会把 rgba32float 声明为 unfilterable-float，和 textureLoad 布局一致。
    this.imageryParameterTexture.create(imageryParameterTextureWidth, 1, this.createImageryParameters(imagery), true, context);
    this.setTexture('imageryParams', this.imageryParameterTexture);
    this.updateDayTextures(imagery);
    this.doubleSide = false;
  }

  /**
   * 使用新的 readyImagery 更新现有材质，不重新创建 shader 或 pipeline。
   * @param imagery Cesium 当前可用的祖先回退或最终影像纹理。
   */
  public updateImagery(imagery: CesiumGlobeTileTexture[]): void {
    if (imagery.length === 0) throw new Error('CesiumGlobeTileMaterial 至少需要一张影像纹理。');
    if (imagery.length > maximumImageryLayers) throw new Error(`单瓦片影像图层不能超过 ${maximumImageryLayers} 个。`);
    this.updateDayTextures(imagery);
    this.context.device.queue.writeTexture(
      { texture: this.imageryParameterTexture.getGPUTexture() },
      this.createImageryParameters(imagery),
      { offset: 0, bytesPerRow: imageryParameterTextureWidth * 16, rowsPerImage: 1 },
      { width: imageryParameterTextureWidth, height: 1, depthOrArrayLayers: 1 },
    );
  }

  /**
   * 将退役瓦片材质解除影像纹理引用后放回 Globe 复用池；参数纹理保留继续供下一瓦片使用。
   * @param fallback Orillusion 引擎持久存在的白色占位纹理。
   */
  public resetForPool(fallback: Texture): void {
    for (let index = 0; index < maximumImageryLayers; index += 1) this.setTexture(`dayTexture${index}`, fallback);
  }

  /**
   * 生成 Cesium Globe shader 使用的固定布局参数。
   * @param imagery 当前瓦片可用的最终影像或祖先回退影像。
   * @returns 32 个 RGBA texel；布局对齐 Cesium GlobeFS 的 day texture uniforms。
   */
  private createImageryParameters(imagery: CesiumGlobeTileTexture[]): Float32Array {
    const parameters = new Float32Array(imageryParameterTextureWidth * 4);
    parameters[0] = imagery.length;
    for (let index = 0; index < maximumImageryLayers; index += 1) parameters[4 + index] = imagery[index]?.useWebMercatorT ? 1 : 0;
    for (let index = 0; index < maximumImageryLayers; index += 1) {
      const entry = imagery[index];
      const properties = this.readLayerProperties(entry?.imageryLayer);
      const rectangleOffset = (2 + index) * 4;
      const transformOffset = (6 + index) * 4;
      const propertiesOffset = (10 + index) * 4;
      const properties2Offset = (14 + index) * 4;
      const colorToAlphaOffset = (18 + index) * 4;
      const cutoutOffset = (22 + index) * 4;
      const rectangle = entry?.textureCoordinateRectangle;
      const transform = entry?.textureTranslationAndScale;
      parameters.set(rectangle ? [rectangle.x, rectangle.y, rectangle.z, rectangle.w] : [2, 2, -2, -2], rectangleOffset);
      parameters.set(transform ? [transform.x, transform.y, transform.z, transform.w] : [0, 0, 1, 1], transformOffset);
      // 对齐 Cesium GlobeFS：alpha、brightness、contrast、saturation
      parameters.set([properties.alpha, properties.brightness, properties.contrast, properties.saturation], propertiesOffset);
      // hue、gamma 倒数、splitDirection
      parameters.set([properties.hue, 1 / Math.max(properties.gamma, 1e-4), properties.splitDirection, 0], properties2Offset);
      // colorToAlpha：rgb + threshold；未启用时为 0，shader 中 maxDiff < 0 恒假 → 不生效
      const colorToAlpha = properties.colorToAlpha;
      parameters.set(colorToAlpha
        ? [colorToAlpha.red, colorToAlpha.green, colorToAlpha.blue, properties.colorToAlphaThreshold]
        : [0, 0, 0, 0], colorToAlphaOffset);
      // cutoutRectangle：west、south、east、north；全 0 表示未启用
      const cutout = properties.cutoutRectangle;
      parameters.set(cutout ? [cutout.west, cutout.south, cutout.east, cutout.north] : [0, 0, 0, 0], cutoutOffset);
    }
    return parameters;
  }

  /** 读取 Cesium ImageryLayer 的图层属性（默认值与 Cesium ImageryLayer 常量一致）。 */
  private readLayerProperties(layer: ImageryLayer | undefined): LayerProperties {
    if (!layer) return defaultLayerProperties;
    const colorToAlpha = (layer as unknown as { colorToAlpha?: { red: number; green: number; blue: number; alpha: number } | null }).colorToAlpha ?? null;
    return {
      alpha: layer.alpha ?? 1.0,
      brightness: layer.brightness ?? 1.0,
      contrast: layer.contrast ?? 1.0,
      saturation: layer.saturation ?? 1.0,
      hue: layer.hue ?? 0.0,
      gamma: layer.gamma ?? 1.0,
      splitDirection: layer.splitDirection ?? 0.0,
      colorToAlpha,
      colorToAlphaThreshold: (layer as unknown as { colorToAlphaThreshold?: number }).colorToAlphaThreshold ?? 0.004,
      cutoutRectangle: (layer as unknown as { cutoutRectangle?: Rectangle | null }).cutoutRectangle ?? null,
    };
  }

  /**
   * 更新固定四槽影像纹理绑定，未占用槽位回退到第一张纹理以保持 BindGroup 布局稳定。
   * @param imagery 当前瓦片可用的影像纹理。
   */
  private updateDayTextures(imagery: CesiumGlobeTileTexture[]): void {
    const fallback = imagery[0];
    for (let index = 0; index < maximumImageryLayers; index += 1) {
      this.setTexture(`dayTexture${index}`, imagery[index]?.texture ?? fallback.texture);
    }
  }

  /**
   * 释放当前瓦片独占的采样参数缓冲；纹理由 CesiumImageryRuntime 统一管理。
   * @param force 是否强制销毁 Orillusion shader 实例。
   */
  public override destroy(force: boolean): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.imageryParameterTexture.destroy();
    super.destroy(force);
  }
}

/** 全部 Globe 瓦片共享的固定绑定布局 WGSL。 */
const globeTileShader = /* wgsl */ `
#include "Common_vert"
#include "Common_frag"
#include "UnLit_frag"

@group(1) @binding(auto) var dayTexture0Sampler: sampler;
@group(1) @binding(auto) var dayTexture0: texture_2d<f32>;
@group(1) @binding(auto) var dayTexture1Sampler: sampler;
@group(1) @binding(auto) var dayTexture1: texture_2d<f32>;
@group(1) @binding(auto) var dayTexture2Sampler: sampler;
@group(1) @binding(auto) var dayTexture2: texture_2d<f32>;
@group(1) @binding(auto) var dayTexture3Sampler: sampler;
@group(1) @binding(auto) var dayTexture3: texture_2d<f32>;
@group(1) @binding(auto) var imageryParams: texture_2d<f32>;

fn imageryParameter(index: i32) -> vec4<f32> {
  return textureLoad(imageryParams, vec2<i32>(index, 0), 0);
}

fn vert(inputData: VertexAttributes) -> VertexOutput {
  ORI_Vert(inputData);
  return ORI_VertexOut;
}

// 对齐 Cesium czm_hue（Shaders/Builtin/Functions/hue.glsl）。
fn czmHue(rgb: vec3<f32>, shift: f32) -> vec3<f32> {
  let toYIQ = mat3x3<f32>(
    0.299, 0.595716, 0.211456,
    0.587, -0.274453, -0.522591,
    0.114, -0.321263, 0.311135);
  let toRGB = mat3x3<f32>(
    1.0, 0.9563, 0.6210,
    1.0, -0.2721, -0.6474,
    1.0, -1.107, 1.7046);
  let yiq = toYIQ * rgb;
  let hueAngle = atan2(yiq.z, yiq.y) + shift;
  let chroma = sqrt(yiq.z * yiq.z + yiq.y * yiq.y);
  let color = vec3<f32>(yiq.x, chroma * cos(hueAngle), chroma * sin(hueAngle));
  return toRGB * color;
}

// 对齐 Cesium GlobeFS.sampleAndBlend：colorToAlpha → gamma → split → brightness → contrast → hue
// → saturation → alpha 合成（premultiplied over，含除零消毒）。
fn sampleLayer(
  layerIndex: u32,
  terrainUv: vec2<f32>,
  webMercatorUv: vec2<f32>,
  rectangle: vec4<f32>,
  translationAndScale: vec4<f32>,
  useWebMercator: f32,
  previousColor: vec4<f32>,
  layerProperties: vec4<f32>,
  layerProperties2: vec4<f32>,
  colorToAlpha: vec4<f32>,
  cutoutRectangle: vec4<f32>
) -> vec4<f32> {
  var layerUv = select(terrainUv, webMercatorUv, useWebMercator > 0.5);
  // 裙边在北/南方向上位于 WebMercator T 的 0/1 边界；纹理矩形和顶点解码的
  // 浮点舍入可能仅相差数个 ULP。若直接剔除，该影像层没有任何混合结果，裙边
  // 便显示为黑色。只接受极小的越界并夹到边缘，仍保留真正跨瓦片的剔除语义。
  const uvBoundaryEpsilon = 1e-5;
  if (
    layerUv.x < rectangle.x - uvBoundaryEpsilon ||
    layerUv.x > rectangle.z + uvBoundaryEpsilon ||
    layerUv.y < rectangle.y - uvBoundaryEpsilon ||
    layerUv.y > rectangle.w + uvBoundaryEpsilon
  ) {
    return previousColor;
  }
  layerUv = clamp(layerUv, rectangle.xy, rectangle.zw);
  if (cutoutRectangle.x != 0.0 || cutoutRectangle.z != 0.0) {
    if (layerUv.x >= cutoutRectangle.x && layerUv.x <= cutoutRectangle.z && layerUv.y >= cutoutRectangle.y && layerUv.y <= cutoutRectangle.w) {
      return previousColor;
    }
  }
  let sampleUv = layerUv * translationAndScale.zw + translationAndScale.xy;
  var layerColor = vec4<f32>(0.0);
  // 注意：必须用显式 LOD 的 textureSampleLevel。Orillusion 的纹理视图默认只有 1 级 mip，
  // 而采样器按纹理 mipmap 数量配置了 maxLod；隐式 LOD 的 textureSample 会触发
  // “sampler maxLod 超出视图 mipLevelCount”的 pipeline 校验失败。
  switch layerIndex {
    case 0u: { layerColor = textureSampleLevel(dayTexture0, dayTexture0Sampler, sampleUv, 0.0); }
    case 1u: { layerColor = textureSampleLevel(dayTexture1, dayTexture1Sampler, sampleUv, 0.0); }
    case 2u: { layerColor = textureSampleLevel(dayTexture2, dayTexture2Sampler, sampleUv, 0.0); }
    default: { layerColor = textureSampleLevel(dayTexture3, dayTexture3Sampler, sampleUv, 0.0); }
  }
  var color = layerColor.rgb;
  var alpha = layerColor.a;

  // colorToAlpha（对齐 Cesium APPLY_COLOR_TO_ALPHA）。
  let colorDiff = abs(color - colorToAlpha.rgb);
  let maxDiff = max(colorDiff.r, max(colorDiff.g, colorDiff.b));
  if (maxDiff < colorToAlpha.a) { alpha = 0.0; }

  // gamma（对齐 Cesium APPLY_GAMMA：pow(color, oneOverGamma)）。
  color = pow(color, vec3<f32>(layerProperties2.y));

  // split（对齐 Cesium APPLY_SPLIT：gl_FragCoord.x 与视口宽度一半比较；
  // 这里用 WebGPU clip 坐标换算归一化屏幕 x，splitPosition 固定为 0.5，与 Cesium Globe 一致）。
  let screenX = ORI_VertexVarying.fragPosition.x / ORI_VertexVarying.fragPosition.w * 0.5 + 0.5;
  if (layerProperties2.z < 0.0 && screenX > 0.5) { alpha = 0.0; }
  else if (layerProperties2.z > 0.0 && screenX < 0.5) { alpha = 0.0; }

  // brightness / contrast（对齐 Cesium）。
  color = mix(vec3<f32>(0.0), color, layerProperties.y);
  color = mix(vec3<f32>(0.5), color, layerProperties.z);

  // hue / saturation（对齐 Cesium czm_hue / czm_saturation）。
  color = czmHue(color, layerProperties2.x);
  color = mix(vec3<f32>(dot(color, vec3<f32>(0.2125, 0.7154, 0.0721))), color, layerProperties.w);

  // 合成（对齐 Cesium：sourceAlpha = alpha * textureAlpha；premultiplied over + 除零消毒）。
  let sourceAlpha = alpha * layerProperties.x;
  var outAlpha = mix(previousColor.a, 1.0, sourceAlpha);
  outAlpha += sign(outAlpha) - 1.0;
  var outColor = mix(previousColor.rgb * previousColor.a, color, sourceAlpha) / outAlpha;
  return vec4<f32>(outColor, max(outAlpha, 0.0));
}

fn frag() {
  let terrainUv = ORI_VertexVarying.fragUV0;
  let webMercatorUv = ORI_VertexVarying.fragUV1;
  let imageryCount = imageryParameter(0).x;
  let useWebMercatorT = imageryParameter(1);
  var color = vec4<f32>(0.0);
  if (imageryCount > 0.0) { color = sampleLayer(0u, terrainUv, webMercatorUv, imageryParameter(2), imageryParameter(6), useWebMercatorT.x, color, imageryParameter(10), imageryParameter(14), imageryParameter(18), imageryParameter(22)); }
  if (imageryCount > 1.0) { color = sampleLayer(1u, terrainUv, webMercatorUv, imageryParameter(3), imageryParameter(7), useWebMercatorT.y, color, imageryParameter(11), imageryParameter(15), imageryParameter(19), imageryParameter(23)); }
  if (imageryCount > 2.0) { color = sampleLayer(2u, terrainUv, webMercatorUv, imageryParameter(4), imageryParameter(8), useWebMercatorT.z, color, imageryParameter(12), imageryParameter(16), imageryParameter(20), imageryParameter(24)); }
  if (imageryCount > 3.0) { color = sampleLayer(3u, terrainUv, webMercatorUv, imageryParameter(5), imageryParameter(9), useWebMercatorT.w, color, imageryParameter(13), imageryParameter(17), imageryParameter(21), imageryParameter(25)); }
  ORI_ShadingInput.BaseColor = color;
  UnLit();
}`;
