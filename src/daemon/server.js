// src/daemon/server.js
import { createServer as createHttpServer } from 'node:http';
import { authorize, checkHost } from './auth.js';

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

export function createServer({ token, port, hub, routes }) {
  // A mutating route that is also public would be a browser-reachable, unauthenticated way to
  // change state — start a Claude session, answer a permission prompt. Refuse to boot rather than
  // serve one: this is cheap to check here and impossible to notice in review of a later diff.
  for (const route of routes) {
    if (route.stateChanging && route.public) {
      throw new Error(`Refusing to serve ${route.method} ${route.path ?? route.prefix}: a stateChanging route cannot be public.`);
    }
  }

  const server = createHttpServer((req, res) => {
    const boundPort = server.address()?.port ?? port;
    const url = new URL(req.url, `http://127.0.0.1:${boundPort}`);
    const route = routes.find((r) => r.method === req.method && r.path === url.pathname)
      ?? routes.find((r) => r.method === req.method && r.prefix !== undefined && url.pathname.startsWith(r.prefix));

    if (!route) return sendJson(res, 404, { error: 'not_found' });

    if (!route.public) {
      const verdict = authorize(req, { token, port: boundPort });
      if (!verdict.ok) return sendJson(res, verdict.status, { error: verdict.reason });
    } else if (!checkHost(req.headers, boundPort)) {
      return sendJson(res, 403, { error: 'bad_host' });
    }

    const fail = (err) => {
      if (res.headersSent) return res.destroy();
      sendJson(res, 500, { error: 'handler_failed', detail: String(err?.message ?? err) });
    };

    try {
      // An async handler never throws synchronously — a later throw arrives as a rejected promise,
      // which Node's default --unhandled-rejections=throw turns into process death. Catching the
      // returned promise here is what keeps one malformed request from taking the daemon down.
      const result = route.handler(req, res, { token, port: boundPort, hub, url });
      if (result && typeof result.catch === 'function') result.catch(fail);
    } catch (err) {
      fail(err);
    }
  });

  return server;
}
