import fs from 'node:fs';
const assets = new Map([
  ['/panel/', ['index.html', 'text/html; charset=utf-8']],
  ['/panel/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/panel/theme-policy.js', ['theme-policy.js', 'text/javascript; charset=utf-8']],
  ['/panel/theme.js', ['theme.js', 'text/javascript; charset=utf-8']],
  ['/panel/style.css', ['style.css', 'text/css; charset=utf-8']]
].map(([route, [file, type]]) => [route, { type, body: fs.readFileSync(new URL(`../panel/${file}`, import.meta.url)) }]));
export function servePanel(req, res, url) {
  if (req.method !== 'GET') return false;
  if (url.pathname === '/' || url.pathname === '/panel') { res.writeHead(302, { location: '/panel/', 'cache-control': 'no-store' }); res.end(); return true; }
  if (!url.pathname.startsWith('/panel/')) return false;
  const asset = assets.get(url.pathname);
  if (!asset) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Not found'); return true; }
  res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" });
  res.end(asset.body); return true;
}
