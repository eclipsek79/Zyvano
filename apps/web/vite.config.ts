import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Resolves the shared contracts package to its TypeScript source.
 *
 * `@zyvano/shared` is consumed by the API and worker as CommonJS, but the web
 * bundle is ESM. Aliasing to source lets Rollup tree-shake the contract module
 * (the built CommonJS output cannot be statically analysed) and keeps the client
 * and server compiling from literally the same file rather than a stale artifact.
 */
const sharedSource = fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url));

/**
 * Vite configuration for the Zyvano web client.
 *
 * The API is always reached through a same-origin `/api` path: in development via
 * this proxy, in production via the reverse proxy in front of the built bundle.
 * Keeping the client same-origin means the session cookie stays first-party and
 * the double-submit CSRF cookie is readable, which is exactly the configuration
 * the API is secured for. A cross-origin API in development would force a laxer
 * cookie policy than production and hide integration bugs until deploy.
 */
const devApiTarget = process.env.VITE_DEV_API_URL ?? 'http://127.0.0.1:4000';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@zyvano/shared': sharedSource,
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': {
        target: devApiTarget,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    // Vendor code is split out so it caches independently of application code.
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
});
