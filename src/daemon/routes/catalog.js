// src/daemon/routes/catalog.js
export function catalogRoute({ catalog }) {
  return {
    method: 'GET',
    path: '/api/catalog',
    handler: (_req, res) => {
      const payload = JSON.stringify(catalog.get());
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
    },
  };
}
