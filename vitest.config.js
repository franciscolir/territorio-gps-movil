import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.js'],
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
