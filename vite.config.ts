import { defineConfig } from 'vite';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const packageManifest = {
  name: '@orillusion-geo/core',
  version: '0.0.0',
  type: 'module',
  main: './index.js',
  module: './index.js',
  types: './index.d.ts',
  exports: {
    '.': {
      types: './index.d.ts',
      import: './index.js',
    },
  },
  dependencies: {
    '@orillusion/core': '0.9.2',
    '@cesium/engine': '22.1.0',
    '3d-tiles-renderer': '0.5.1',
  },
};

/**
 * 生产构建配置。
 *
 * 示例页面由 Vite 开发服务器直接提供；npm 包则只以 src/index.ts 为入口。
 */
export default defineConfig({
  // Cesium TaskProcessor 会通过 window.CESIUM_BASE_URL 读取 Source/Workers。
  // 必须保留 public/cesium，否则地形网格 Worker 在开发与构建产物中都无法加载。
  publicDir: 'public',
  server: {
    fs: {
      // 允许开发服务器读取项目内的大型本地样例数据，无需复制到 public 目录。
      allow: ['.'],
    },
  },
  build: {
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: 'index',
    },
    rollupOptions: {
      // 运行时依赖由使用方安装，避免将其重复打入 @orillusion-geo/core 包体。
      external: [
        '@orillusion/core',
        /^@orillusion\/core\/.+/,
        '@cesium/engine',
        /^@cesium\/engine\/.+/,
        '3d-tiles-renderer',
        /^3d-tiles-renderer\/.+/,
      ],
      plugins: [
        {
          name: 'write-package-manifest',
          /** 写入可独立发布的 dist/package.json。 */
          closeBundle() {
            writeFileSync(
              resolve('dist/package.json'),
              `${JSON.stringify(packageManifest, null, 2)}\n`,
              'utf8',
            );
          },
        },
      ],
    },
  },
});
