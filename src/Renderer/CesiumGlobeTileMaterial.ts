import { Context3D, Float32ArrayTexture, RenderShaderPass, Shader, ShaderLib, Texture, UnLitMaterial } from '@orillusion/core';
import type { Cartesian4 } from '@cesium/engine';

/** 单次绘制支持的最大影像图层数。 */
const maximumImageryLayers = 4;
/** 所有 Globe 瓦片共享同一份 WGSL，避免每瓦片永久注册 shader 和重复创建 pipeline。 */
const globeTileShaderName = 'CesiumGlobeTileShared';

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
}

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
    // 使用 16×1 RGBA32Float 参数纹理保持 256 字节行对齐，避免瓦片退出帧时异步 BindGroup 引用已销毁 StorageGPUBuffer。
    this.imageryParameterTexture = new Float32ArrayTexture();
    // Orillusion Float32ArrayTexture 在 filtering=true 时会把 rgba32float 声明为 unfilterable-float，和 textureLoad 布局一致。
    this.imageryParameterTexture.create(16, 1, this.createImageryParameters(imagery), true, context);
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
      { offset: 0, bytesPerRow: 256, rowsPerImage: 1 },
      { width: 16, height: 1, depthOrArrayLayers: 1 },
    );
  }

  /**
   * 将退役瓦片材质解除影像纹理引用后放回 Globe 复用池；参数纹理继续保留供下一瓦片使用。
   * @param fallback Orillusion 引擎持久存在的白色占位纹理。
   */
  public resetForPool(fallback: Texture): void {
    for (let index = 0; index < maximumImageryLayers; index += 1) this.setTexture(`dayTexture${index}`, fallback);
  }

  /**
   * 生成 Cesium Globe shader 使用的固定布局参数。
   * @param imagery 当前瓦片可用的最终影像或祖先回退影像。
   * @returns 16 个 RGBA texel；前 10 个与 Cesium imagery uniforms 一一对应。
   */
  private createImageryParameters(imagery: CesiumGlobeTileTexture[]): Float32Array {
    const parameters = new Float32Array(64);
    parameters[0] = imagery.length;
    for (let index = 0; index < maximumImageryLayers; index += 1) parameters[4 + index] = imagery[index]?.useWebMercatorT ? 1 : 0;
    for (let index = 0; index < maximumImageryLayers; index += 1) {
      const entry = imagery[index];
      const rectangleOffset = (2 + index) * 4;
      const transformOffset = (6 + index) * 4;
      const rectangle = entry?.textureCoordinateRectangle;
      const transform = entry?.textureTranslationAndScale;
      parameters.set(rectangle ? [rectangle.x, rectangle.y, rectangle.z, rectangle.w] : [2, 2, -2, -2], rectangleOffset);
      parameters.set(transform ? [transform.x, transform.y, transform.z, transform.w] : [0, 0, 1, 1], transformOffset);
    }
    return parameters;
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

fn sampleLayer(
  layerIndex: u32,
  terrainUv: vec2<f32>,
  webMercatorUv: vec2<f32>,
  rectangle: vec4<f32>,
  translationAndScale: vec4<f32>,
  useWebMercator: f32,
  currentColor: vec4<f32>
) -> vec4<f32> {
  let layerUv = select(terrainUv, webMercatorUv, useWebMercator > 0.5);
  if (layerUv.x < rectangle.x || layerUv.x > rectangle.z || layerUv.y < rectangle.y || layerUv.y > rectangle.w) {
    return currentColor;
  }
  let sampleUv = layerUv * translationAndScale.zw + translationAndScale.xy;
  var layerColor = vec4<f32>(0.0);
  switch layerIndex {
    case 0u: { layerColor = textureSampleLevel(dayTexture0, dayTexture0Sampler, sampleUv, 0.0); }
    case 1u: { layerColor = textureSampleLevel(dayTexture1, dayTexture1Sampler, sampleUv, 0.0); }
    case 2u: { layerColor = textureSampleLevel(dayTexture2, dayTexture2Sampler, sampleUv, 0.0); }
    default: { layerColor = textureSampleLevel(dayTexture3, dayTexture3Sampler, sampleUv, 0.0); }
  }
  return layerColor + currentColor * (1.0 - layerColor.a);
}

fn frag() {
  let terrainUv = ORI_VertexVarying.fragUV0;
  let webMercatorUv = ORI_VertexVarying.fragUV1;
  let imageryCount = imageryParameter(0).x;
  let useWebMercatorT = imageryParameter(1);
  var color = vec4<f32>(0.0);
  if (imageryCount > 0.0) { color = sampleLayer(0u, terrainUv, webMercatorUv, imageryParameter(2), imageryParameter(6), useWebMercatorT.x, color); }
  if (imageryCount > 1.0) { color = sampleLayer(1u, terrainUv, webMercatorUv, imageryParameter(3), imageryParameter(7), useWebMercatorT.y, color); }
  if (imageryCount > 2.0) { color = sampleLayer(2u, terrainUv, webMercatorUv, imageryParameter(4), imageryParameter(8), useWebMercatorT.z, color); }
  if (imageryCount > 3.0) { color = sampleLayer(3u, terrainUv, webMercatorUv, imageryParameter(5), imageryParameter(9), useWebMercatorT.w, color); }
  ORI_ShadingInput.BaseColor = color;
  UnLit();
}`;
