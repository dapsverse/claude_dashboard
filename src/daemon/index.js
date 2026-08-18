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
import { writeRuntime, clearRuntime, acquireStartLock } from '../core/runtime-file.js';
import { openDb } from '../store/db.js';
import { createRunsRepo } from '../store/runs.js';
import { createSessionsRepo } from '../store/sessions.js';
import { createCatalog } from '../catalog/index.js';
import { startSweeper } from '../core/sweeper.js';

export const VERSION = '0.1.0';

// Loopback only, on purpose: this daemon can run code as the user through Claude, and its only gate
// is a token in a 0600 file. Anything routable turns that local trust boundary into a network one.
export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export async function startDaemon({
  claudeDir, projectRoot, uiDir,
  host = '127.0.0.1',
  portRange = { start: 8888, end: 8988 },
  now = Date.now,
  unsafeBind = false,
}) {
  // The guard lives here, not only in the CLI. This daemon can run code as the user through Claude,
  // and its only gate is a token in a 0600 file. Binding it to a routable address exposes that to the
  // network, so nothing short of an explicit unsafeBind may do it — not a config value, not an env var.
  if (!LOOPBACK_HOSTS.has(host) && !unsafeBind) {
    throw new Error(
      `Refusing to bind ${host}. agentpanel serves a daemon that can execute code as you, gated only by a `
      + `local token. Loopback only. Pass --unsafe-bind if you genuinely intend to expose it.`,
    );
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    process.emitWarning(`agentpanel is bound to ${host}, reachable from the network. Anyone who obtains the token can run code as you.`);
  }

  const runtimeFile = join(claudeDir, 'agentpanel', 'daemon.json');
  // Two `agentpanel start` invocations racing each other both see no live daemon, both start, and
  // the second overwrites the first's runtime file — leaving a live daemon that stop/status/open can
  // never see again. The lock makes the check-then-start sequence atomic across processes.
  const lockPath = `${runtimeFile}.lock`;
  const releaseLock = acquireStartLock(lockPath);
  if (!releaseLock) {
    // A live holder blocks `start` with no way out otherwise — name the file and the recovery so a
    // hard-killed daemon whose pid was later reused by an unrelated process does not strand the user.
    throw new Error(
      `Another agentpanel start is already in progress, or a daemon is already running.\n`
      + `If you are sure neither is true, remove the lock file: ${lockPath}`,
    );
  }

  try {
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

    writeRuntime({ pid: process.pid, port, token, startedAt: now(), version: VERSION }, runtimeFile);
    const stopSweeper = startSweeper({ runs, hub, now });

    return {
      server, port, token,
      url: `http://127.0.0.1:${port}/auth?token=${token}`,
      async stop() {
        try {
          stopSweeper();
          catalog.close();
          hub.closeAll();
          clearRuntime(runtimeFile);
          db.close();
          await new Promise((r) => server.close(r));
        } finally {
          releaseLock();
        }
      },
    };
  } catch (err) {
    releaseLock();
    throw err;
  }
}
