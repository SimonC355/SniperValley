// `npm run host`: serves the built game (dist/) and the LAN relay on one port, and prints
// the addresses your friends open in their browsers.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { attachRelay } from './relay.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const PORT = parseInt(process.env.PORT || '8080', 10);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.woff2': 'font/woff2', '.webp': 'image/webp',
};

if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
  console.error('dist/ is missing. Run `npm run host` (it builds first) or `npm run build`.');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  let file = path.normalize(path.join(ROOT, url));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  if (url === '/' || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (path.extname(url)) { res.writeHead(404); res.end('not found'); return; }
    file = path.join(ROOT, 'index.html');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
});
attachRelay(server);
server.listen(PORT, '0.0.0.0', () => {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
  }
  console.log('\nSniperYard LAN server is running.\n');
  console.log(`  On this PC:      http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  For your friends: http://${ip}:${PORT}`);
  console.log('\nOpen it, click HOST GAME. Friends open the address above and click JOIN GAME.');
  console.log('If they cannot connect, allow Node.js through your firewall (private networks).\n');
});
