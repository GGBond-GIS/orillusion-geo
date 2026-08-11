import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    fs: {
      // 允许开发服务器读取项目内的大型本地样例数据，而无需复制到 public 目录。
      allow: ['.'],
    },
  },
  build: {
    rollupOptions: {
      input: {
        index: 'index.html',
        orillusion3dtiles: 'examples/orillusion_3dtilesrender.html',
        threejs3dtiles: 'examples/threejs_3dtilesrender.html',
      },
    },
  },
});
