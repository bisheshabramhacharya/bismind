import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const PORT = Number(process.env.BISMIND_PORT ?? 4317);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5317,
    strictPort: true,
    proxy: {
      '/api': { target: `http://127.0.0.1:${PORT}`, changeOrigin: true },
      '/ws': { target: `ws://127.0.0.1:${PORT}`, ws: true },
    },
  },
  build: { outDir: 'dist/web', emptyOutDir: true },
});
