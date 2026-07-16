import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [
    {
      name: 'content-security-policy',
      enforce: 'pre',
      transformIndexHtml(html, context) {
        const connectSources = context.server
          ? "'self' http://localhost:5173 ws://localhost:5173"
          : "'self'";
        const policy = [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "media-src 'self' blob:",
          "font-src 'self' data:",
          `connect-src ${connectSources}`,
          "object-src 'none'",
          "base-uri 'none'",
          "form-action 'none'",
        ].join('; ');
        return html.replace('{{CONTENT_SECURITY_POLICY}}', policy);
      },
    },
    react(),
  ],
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
