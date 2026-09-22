import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/** 后端端口，与 apps/server/src/config.ts 的默认值保持一致 */
const SERVER_PORT = 5178;

export default defineConfig({
  plugins: [react()],
  server: {
    // 开发态：Vite 跑在 5173，/api 反向代理到后端，避免跨域配置
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${SERVER_PORT}`,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    css: false,
  },
});
