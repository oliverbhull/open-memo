import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  root: 'electron/renderer',
  base: './',
  build: {
    outDir: '../../dist-react',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './electron/renderer/src'),
    },
  },
  server: {
    port: 5173,
  },
});


