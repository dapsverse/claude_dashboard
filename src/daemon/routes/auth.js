// src/daemon/routes/auth.js
import { COOKIE_NAME, safeEqual } from '../auth.js';

export function authRoute({ token }) {
  return {
    method: 'GET',
    path: '/auth',
    public: true,
    handler: (req, res, ctx) => {
      const presented = ctx.url.searchParams.get('token') ?? '';
      if (!safeEqual(presented, token)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end('{"error":"bad_token"}');
      }
      res.writeHead(302, {
        location: '/',
        'set-cookie': `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
      });
      res.end();
    },
  };
}
