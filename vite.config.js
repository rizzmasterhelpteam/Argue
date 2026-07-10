import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';

const isTest = process.env.VITEST === 'true';

export default defineConfig({
  plugins: [react(), ...(isTest ? [] : [cloudflare({ configPath: 'wrangler.json' })])],
  server: {
    host: '0.0.0.0',
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.js',
    css: true,
  },
});
