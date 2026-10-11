import fs from 'node:fs';
import { defineConfig } from 'vite';
import { attachRelay } from './server/relay.mjs';

const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// The LAN relay also runs inside the dev server, so `npm run dev -- --host` works for testing.
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [{
    name: 'lan-relay',
    configureServer(server) { if (server.httpServer) attachRelay(server.httpServer, { log: () => {} }); },
    configurePreviewServer(server) { if (server.httpServer) attachRelay(server.httpServer); },
  }],
});
