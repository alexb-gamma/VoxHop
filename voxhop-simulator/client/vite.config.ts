import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Architect Note 2: Dev proxy uses port 4443 (SIMULATOR_PORT default).
// Root is never on 443 locally (requires root). Docker still binds port 443 inside container.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/personas': 'http://localhost:4443',
    },
    // EN-02: Set COOP/COEP headers in dev for SharedArrayBuffer testing.
    // These are NOT a substitute for NestJS middleware (M-01) — smoke tests always
    // hit NestJS-served responses, never Vite dev server.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: {
    outDir: '../static',
    emptyOutDir: true,
  },
});
