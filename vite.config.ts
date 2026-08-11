import { defineConfig } from 'vite';

/**
 * 生产构建配置。
 *
 * 示例页面由 Vite 开发服务器直接提供；npm 包则只以 src/index.ts 为入口。
 */
export default defineConfig({
  // public 中的 Vite 演示资源不属于 npm 库产物。
  publicDir: false,
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
        '3d-tiles-renderer',
        /^3d-tiles-renderer\/.+/,
      ],
    },
  },
});
