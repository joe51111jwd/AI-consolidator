import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'renderer',
  base: './',
  plugins: [react()],
  build: { outDir: '../dist-renderer', emptyOutDir: true, chunkSizeWarningLimit: 2000 },
  server: { port: 5173, strictPort: true },
});
