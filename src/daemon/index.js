// src/daemon/index.js
import { join } from 'node:path';
import { createHub } from './sse.js';
import { createServer } from './server.js';
import { generateToken } from './auth.js';
import { authRoute } from './routes/auth.js';
import { staticRoute } from './routes/static.js';
import { catalogRoute, catalogWriteRoutes } from './routes/catalog.js';
import { fsRoutes, fsRevealRoute } from './routes/fs.js';
import { hooksRoute, runsRoute, runsDismissRoute } from './routes/hooks.js';
import { chatRoutes } from './routes/chat.js';
import { uploadsRoute } from './routes/uploads.js';
import { createUploadsStore } from './uploads.js';
import { findAvailablePort } from '../core/port.js';
import { writeRuntime, clearRuntime, acquireStartLock, restrictStatePaths } from '../core/runtime-file.js';
import { openDb } from '../store/db.js';
import { createRunsRepo } from '../store/runs.js';
import { createSessionsRepo } from '../store/sessions.js';
import { createChatRepo } from '../store/chat.js';
import { createProjectsRepo } from '../store/projects.js';
import { createSessionManager } from '../chat/session.js';
import { createResumeScheduler } from '../chat/resume.js';
import { createPermissionGate } from '../chat/permissions.js';
import { createCatalog } from '../catalog/index.js';
import { startSweeper } from '../core/sweeper.js';
import { sweepDeadRuns } from './sweepers.js';
import { hooksInstalled } from '../cli/hook-config.js';

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
      + `local token. Loopback only. The CLI offers no way to override this; only code calling `
      + `startDaemon({ unsafeBind: true }) directly can, and it should not.`,
    );
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    process.emitWarning(`agentpanel is bound to ${host}, reachable from the network. Anyone who obtains the token can run code as you.`);
  }

  const stateDir = join(claudeDir, 'agentpanel');
  // Before anything else touches this directory: the bootstrap script may have created it, and an
  // older version of that script created it under the umask. Everything below writes the token into
  // it, so tighten it first rather than assuming the shell got it right.
  restrictStatePaths(stateDir);

  const runtimeFile = join(stateDir, 'daemon.json');
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

    const db = openDb(join(stateDir, 'data.db'));
    const runs = createRunsRepo(db);
    const sessions = createSessionsRepo(db);
    const chat = createChatRepo(db);
    const projects = createProjectsRepo(db);
    // The gate and the session manager are separate on purpose: the gate is the security boundary
    // and knows nothing about the SDK, and the manager cannot answer its own permission prompts.
    const permissions = createPermissionGate({ hub, now });
    // Declared before the session manager because the manager reports every activity message into
    // it. This is what finally closes a subagent the user stopped mid-session: the run row used to
    // stay 'running' while the activity feed already said 'stopped', and the office scene kept the
    // actor at its desk for the whole 30-minute stale window.
    const deadRuns = sweepDeadRuns({ runs, sessions, hub, now });
    // Declared before the manager because the manager's end-of-session callback reaches for it, and
    // the scheduler in turn needs the manager to send with. One of the two has to be filled in
    // afterwards; a `let` is the whole of the trick.
    let resumes = null;
    const chatSessions = createSessionManager({
      store: chat, hub, now, permissions,
      onActivity: (message) => deadRuns.noteActivity(message),
      // The CLI that would have fired SessionEnd is the process that just died, so nothing else
      // closes the subagents it dispatched — they sat in the rail claiming to be alive until the
      // 30-minute sweeper reached them. Closing them here is what makes the rail stop lying.
      onSessionEnd: ({ projectPath, sessionId, reason, resetsAt }) => {
        if (sessionId) {
          for (const id of runs.endSessionRuns(sessionId, now(), reason)) {
            hub.broadcast('run.close', runs.get(id));
          }
        }
        if (reason === 'rate_limit') resumes?.arm({ projectPath, resetsAt });
      },
    });
    resumes = createResumeScheduler({ sessions: chatSessions, hub, now });
    const uploads = createUploadsStore({ stateDir });
    const catalog = createCatalog({ claudeDir, projectRoot });
    catalog.watch((next) => hub.broadcast('catalog.changed', { scannedAt: next.scannedAt }));

    const streamRoute = { method: 'GET', path: '/api/stream', handler: (_req, res) => hub.add(res) };
    const routes = [
      authRoute({ token }),
      { method: 'GET', path: '/api/health', public: true,
        handler: (_q, res) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            version: VERSION,
            hooksInstalled: hooksInstalled(join(claudeDir, 'settings.json')),
          }));
        } },
      streamRoute,
      catalogRoute({ catalog }),
      ...catalogWriteRoutes({ catalog, claudeDir, hub }),
      // Read-only, and confined to the user's home directory inside the route itself: the add-project
      // form needs to show what is on disk, not a way to enumerate the whole machine.
      ...fsRoutes({ projects }),
      fsRevealRoute({}),
      runsRoute({ runs }),
      runsDismissRoute({ runs, hub, now }),
      hooksRoute({ runs, sessions, hub, now }),
      ...chatRoutes({ sessions: chatSessions, permissions, chat, projects, resumes, uploads, now }),
      uploadsRoute({ uploads }),
      staticRoute({ uiDir }),
    ];

    const server = createServer({ token, port, hub, routes });
    await new Promise((r) => server.listen(port, host, r));

    writeRuntime({ pid: process.pid, port, token, startedAt: now(), version: VERSION }, runtimeFile);
    const stopSweeper = startSweeper({ runs, hub, now });
    deadRuns.start();

    return {
      server, port, token,
      url: `http://127.0.0.1:${port}/auth?token=${token}`,
      async stop() {
        try {
          stopSweeper();
          // Both timers, not just the old one: an interval left running here outlives stop() and
          // keeps writing to a database the line below is about to close.
          deadRuns.stop();
          resumes.stop();
          // Sessions first: each holds a child process and an open permission prompt may be
          // parked on a promise. Closing the gate afterwards denies anything still waiting, so
          // nothing is left holding the event loop open after stop() resolves.
          await chatSessions.close();
          permissions.close();
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
