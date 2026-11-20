import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

// `npm run dev:phone` runs Vite with --mode phone: listen on the local network and serve HTTPS (self-signed),
// because phone browsers only allow camera/microphone on secure (https) pages.
// API_TARGET lets a second dev copy (e.g. for automated checks) talk to a different API port.
const api = process.env.API_TARGET || 'http://localhost:4000';

export default defineConfig(({ mode }) => {
  const phone = mode === 'phone';
  return {
    plugins: [react(), ...(phone ? [basicSsl()] : [])],
    server: {
      port: 5173,
      host: phone ? true : 'localhost',
      proxy: {
        '/api': { target: api, changeOrigin: false },
        '/ws': { target: api.replace(/^http/, 'ws'), ws: true },
      },
    },
    build: { chunkSizeWarningLimit: 1500 },
  };
});
