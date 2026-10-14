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
      // 把 @ai-sdk/react 内部 bundle 的 ai v7 暴露成 `@ai-sdk-internal`
      // —— 让前端能 import DefaultChatTransport（v4 ChatInit 需要）
      '@ai-sdk-internal': path.resolve(
        __dirname,
        'node_modules/@ai-sdk/react/node_modules/ai',
      ),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      // SSE（流式聊天）直接走 /api/chat/stream，不需要单独代理
    },
  },
});
