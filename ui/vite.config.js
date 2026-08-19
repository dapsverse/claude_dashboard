import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The daemon takes the first free port from 8888 upward — never 4317, which no part of this project
// binds. Set AGENTPANEL_DEV_PORT when `agentpanel status` reports something other than 8888.
const daemonPort = process.env.AGENTPANEL_DEV_PORT ?? '8888';

// `changeOrigin` rewrites Host to the target, which the daemon requires (it rejects a foreign Host to
// close DNS rebinding), and the explicit Origin satisfies the check that now applies to reads as well
// as writes. Without both, every proxied request from `vite dev` comes back 403. Authenticate the dev
// session once by visiting http://localhost:5173/auth?token=<token from `agentpanel open`>.
const devProxy = {
  target: `http://127.0.0.1:${daemonPort}`,
  changeOrigin: true,
  headers: { origin: `http://127.0.0.1:${daemonPort}` },
};

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: {
    outDir: '../dist/ui',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': devProxy,
      '/auth': devProxy,
    },
  },
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.jsx'],
    setupFiles: ['./test/setup.js'],
  },
});
