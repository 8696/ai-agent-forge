import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts', 'tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['**/node_modules/**', '**/dist/**', '**/tests/**'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@shared': path.resolve(__dirname, 'shared'),
    },
  },
});
