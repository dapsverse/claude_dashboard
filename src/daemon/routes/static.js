// src/daemon/routes/static.js
import { readFile } from 'node:fs/promises';
import { join, resolve, extname, sep } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon',
};

export function staticRoute({ uiDir }) {
  const root = resolve(uiDir);

  return {
    method: 'GET',
    prefix: '/',
    handler: async (req, res, ctx) => {
      const decoded = decodeURIComponent(ctx.url.pathname);
      // Resolve first, then check: a check on the raw pathname can be walked past with an
      // encoded ".." or a symlink. path.resolve() collapses every ".." — including ones a
      // percent-encoded segment reintroduces after the URL parser has already normalized the
      // literal dots — so "inside root" is only meaningful once it runs after the join.
      const requested = resolve(join(root, decoded));
      const inside = requested === root || requested.startsWith(root + sep);
      const isAsset = inside && extname(requested) !== '';
      // The UI has only flat, top-level client routes (/, /agents, /skills, /activity). A
      // nested, extension-less path that isn't a real file (e.g. a collapsed traversal attempt
      // that lands harmlessly inside root as .../etc/passwd) is not one of those routes — serving
      // index.html for it would turn every dead path into a 200 instead of a 404.
      const isTopLevelRoute = inside && !isAsset && decoded.split('/').filter(Boolean).length <= 1;

      if (!isAsset && !isTopLevelRoute) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end('{"error":"not_found"}');
      }

      const file = isAsset ? requested : join(root, 'index.html');
      try {
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
        res.end(body);
      } catch {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"not_found"}');
      }
    },
  };
}
