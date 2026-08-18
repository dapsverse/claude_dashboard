import { createServer } from 'node:net';

export class PortRangeExhaustedError extends Error {
  constructor(host, start, end) {
    super(`No free port on ${host} in range ${start}-${end}`);
    this.name = 'PortRangeExhaustedError';
  }
}

export function isPortFree(port, host = '127.0.0.1') {
  return new Promise((res) => {
    const s = createServer();
    s.once('error', () => res(false));
    s.once('listening', () => s.close(() => res(true)));
    s.listen(port, host);
  });
}

export async function findAvailablePort({ host = '127.0.0.1', start = 8888, end = 8988 } = {}) {
  for (let p = start; p <= end; p++) {
    if (await isPortFree(p, host)) return p;
  }
  throw new PortRangeExhaustedError(host, start, end);
}
