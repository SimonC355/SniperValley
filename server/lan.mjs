// `npm run host`: serves the built game (dist/) and the LAN relay on one port, and prints
// the addresses your friends open in their browsers.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachRelay } from './relay.mjs';
import { serveStatic, lanAddresses } from './serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const PORT = parseInt(process.env.PORT || '8080', 10);

if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
  console.error('dist/ is missing. Run `npm run host` (it builds first) or `npm run build`.');
  process.exit(1);
}

const server = http.createServer(serveStatic(ROOT));
attachRelay(server);
server.listen(PORT, '0.0.0.0', () => {
  console.log('\nSniperValley LAN server is running.\n');
  console.log(`  On this PC:      http://localhost:${PORT}`);
  for (const ip of lanAddresses()) console.log(`  For your friends: http://${ip}:${PORT}`);
  console.log('\nOpen it, click HOST GAME. Friends open the address above and click JOIN GAME.');
  console.log('If they cannot connect, allow Node.js through your firewall (private networks).\n');
});
