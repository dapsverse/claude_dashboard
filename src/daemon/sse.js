// src/daemon/sse.js
export function createHub() {
  const clients = new Set();

  return {
    add(res) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.flushHeaders?.();
      clients.add(res);
      res.on('close', () => clients.delete(res));
      return res;
    },
    broadcast(event, data) {
      const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const res of clients) {
        try { res.write(frame); } catch { clients.delete(res); }
      }
    },
    size() { return clients.size; },
    closeAll() {
      for (const res of clients) { try { res.end(); } catch { /* already gone */ } }
      clients.clear();
    },
  };
}
