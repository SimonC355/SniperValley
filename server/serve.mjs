// Serves the built game (dist/) over HTTP. Used by `npm run host` and by the desktop app.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.woff2': 'font/woff2', '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
};

// Request handler for the files in `root`. Unknown paths without an extension get index.html.
export function serveStatic(root) {
  return (req, res) => {
    let url;
    try { url = decodeURIComponent((req.url || '/').split('?')[0]); } catch { res.writeHead(400); res.end(); return; }
    let file = path.normalize(path.join(root, url));
    if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    if (url === '/' || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      if (path.extname(url)) { res.writeHead(404); res.end('not found'); return; }
      file = path.join(root, 'index.html');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  };
}

// This PC's IPv4 addresses on the local network.
export function lanAddresses() {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
  }
  return ips;
}
