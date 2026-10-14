import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Ports are configurable so run.sh can pick free ones and keep the proxy in sync.
const CLIENT_PORT = Number(process.env.CLIENT_PORT) || 5180;
const API_PORT = Number(process.env.API_PORT) || 4000;

export default defineConfig({
  plugins: [react()],
  server: {
    port: CLIENT_PORT,
    strictPort: true, // fail instead of silently shifting; run.sh already picked a free port
    proxy: {
      '/api': `http://localhost:${API_PORT}`,
    },
  },
});
