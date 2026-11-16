import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite proxies /api to the local Express server. Set API_PROXY_TARGET=off when the
// Netlify CLI is serving the API function itself (API_PROXY_TARGET=off npx netlify dev).
const proxyTarget = process.env.API_PROXY_TARGET;

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: proxyTarget === 'off' ? undefined : { '/api': { target: proxyTarget || 'http://127.0.0.1:3001', changeOrigin: false } },
  },
});
