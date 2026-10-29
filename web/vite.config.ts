import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The API server runs on 8787 in development (npm run dev). The desktop app talks to its own bundled server.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
