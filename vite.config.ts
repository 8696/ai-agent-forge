import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * Vite 配置 —— 详见 docs/03-技术栈与规范.md §C.3
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'web'),
      '@shared': path.resolve(__dirname, 'shared'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        // 代理目标可以用 VITE_API_TARGET 覆盖 ——
        // 跑在别的端口的后端（比如测试实例 3099 / 3100）时不用改代码
        target: process.env.VITE_API_TARGET ?? 'http://localhost:3000',
        changeOrigin: true,
      },
      // SSE（流式聊天）直接走 /api/chat/stream，不需要单独代理
    },
  },
});
