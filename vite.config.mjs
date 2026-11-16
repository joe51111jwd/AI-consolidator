import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Every build gets its own id (dist-renderer/build.json). electron/onboarding.cjs shows Welcome again
// the first time a new build opens.
const buildStamp = () => ({
  name: 'build-stamp',
  apply: 'build',
  generateBundle() {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.emitFile({ type: 'asset', fileName: 'build.json', source: JSON.stringify({ id }) });
  },
});

export default defineConfig({
  root: 'renderer',
  base: './',
  plugins: [react(), buildStamp()],
  build: { outDir: '../dist-renderer', emptyOutDir: true, chunkSizeWarningLimit: 2000 },
  server: { port: 5173, strictPort: true },
});
