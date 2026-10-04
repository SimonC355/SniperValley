import { defineConfig } from 'vite';
import { attachRelay } from './server/relay.mjs';

// The LAN relay also runs inside the dev server, so `npm run dev -- --host` works for testing.
export default defineConfig({
  plugins: [{
    name: 'sniperyard-lan-relay',
    configureServer(server) { if (server.httpServer) attachRelay(server.httpServer, { log: () => {} }); },
    configurePreviewServer(server) { if (server.httpServer) attachRelay(server.httpServer); },
  }],
});
