// src/daemon/index.js
import { join } from 'node:path';
import { createHub } from './sse.js';
import { createServer } from './server.js';
import { generateToken } from './auth.js';
import { authRoute } from './routes/auth.js';
import { staticRoute } from './routes/static.js';
import { catalogRoute } from './routes/catalog.js';
import { hooksRoute, runsRoute } from './routes/hooks.js';
import { findAvailablePort } from '../core/port.js';
import { writeRuntime, clearRuntime } from '../core/runtime-file.js';
import { openDb } from '../store/db.js';
import { createRunsRepo } from '../store/runs.js';
import { createSessionsRepo } from '../store/sessions.js';
import { createCatalog } from '../catalog/index.js';
import { startSweeper } from '../core/sweeper.js';

export const VERSION = '0.1.0';

export async function startDaemon({
  claudeDir, projectRoot, uiDir,
  host = '127.0.0.1',
  portRange = { start: 8888, end: 8988 },
  now = Date.now,
}) {
  const port = await findAvailablePort({ host, ...portRange });
  const token = generateToken();
  const hub = createHub();

  const db = openDb(join(claudeDir, 'agentpanel', 'data.db'));
  const runs = createRunsRepo(db);
  const sessions = createSessionsRepo(db);
  const catalog = createCatalog({ claudeDir, projectRoot });
  catalog.watch((next) => hub.broadcast('catalog.changed', { scannedAt: next.scannedAt }));

  const streamRoute = { method: 'GET', path: '/api/stream', handler: (_req, res) => hub.add(res) };
  const routes = [
    authRoute({ token }),
    { method: 'GET', path: '/api/health', public: true,
      handler: (_q, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, version: VERSION })); } },
    streamRoute,
    catalogRoute({ catalog }),
    runsRoute({ runs }),
    hooksRoute({ runs, sessions, hub, now }),
    staticRoute({ uiDir }),
  ];

  const server = createServer({ token, port, hub, routes });
  await new Promise((r) => server.listen(port, host, r));

  const runtimeFile = join(claudeDir, 'agentpanel', 'daemon.json');
  writeRuntime({ pid: process.pid, port, token, startedAt: now(), version: VERSION }, runtimeFile);
  const stopSweeper = startSweeper({ runs, hub, now });

  return {
    server, port, token,
    url: `http://127.0.0.1:${port}/auth?token=${token}`,
    async stop() {
      stopSweeper();
      catalog.close();
      hub.closeAll();
      clearRuntime(runtimeFile);
      db.close();
      await new Promise((r) => server.close(r));
    },
  };
}
