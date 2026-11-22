import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { attachRelay } from './server/relay.mjs';

const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// The LAN relay also runs inside the dev server, so `npm run dev -- --host` works for testing.
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  // just meshoptimizer's simplifier (the package's entry point brings its encoder and others too)
  resolve: { alias: { 'meshopt-simplifier': fileURLToPath(new URL('./node_modules/meshoptimizer/meshopt_simplifier.js', import.meta.url)) } },
  plugins: [{
    name: 'lan-relay',
    configureServer(server) { if (server.httpServer) attachRelay(server.httpServer, { log: () => {} }); },
    configurePreviewServer(server) { if (server.httpServer) attachRelay(server.httpServer); },
  }],
});
