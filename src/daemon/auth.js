// src/daemon/auth.js
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const COOKIE_NAME = 'agentpanel_token';

export function generateToken() {
  return randomBytes(32).toString('hex');
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function allowedHosts(port) {
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
}

export function checkHost(headers, port) {
  return allowedHosts(port).includes(String(headers.host ?? '').toLowerCase());
}

export function checkOrigin(headers, port) {
  const origin = headers.origin;
  if (origin === undefined) return true;          // curl, hook scripts, non-browser clients
  return allowedHosts(port).some((h) => origin.toLowerCase() === `http://${h}`);
}

export function readCookie(headers, name) {
  const raw = headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

export function bearer(headers) {
  const match = /^Bearer (.+)$/.exec(headers.authorization ?? '');
  return match ? match[1] : null;
}

export function authorize(req, { token, port, stateChanging = false }) {
  if (!checkHost(req.headers, port)) return { ok: false, status: 403, reason: 'bad_host' };
  if (stateChanging && !checkOrigin(req.headers, port)) return { ok: false, status: 403, reason: 'bad_origin' };
  const presented = bearer(req.headers) ?? readCookie(req.headers, COOKIE_NAME);
  if (!presented || !safeEqual(presented, token)) return { ok: false, status: 401, reason: 'bad_token' };
  return { ok: true };
}
