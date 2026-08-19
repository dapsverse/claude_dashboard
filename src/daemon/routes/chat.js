// src/daemon/routes/chat.js
//
// The HTTP surface of the orchestrator chat. Every mutating route declares `stateChanging: true`
// and none is `public`, so the daemon's Origin + token guard runs before any of them — a page on
// another 127.0.0.1 port cannot start a session, answer a permission prompt, or reset a
// conversation through the browser's ambient cookie.
import { statSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve, basename } from 'node:path';
import { json, readJson } from './body.js';

// One directory is one session. macOS makes this concrete: /tmp is a symlink to /private/tmp, so
// the two spellings of the same project would otherwise key two sessions, two transcripts and two
// resume ids for the same directory.
export function normalizeProjectPath(value) {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  if (candidate === '' || !isAbsolute(candidate)) return null;
  try {
    const real = realpathSync(candidate);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;                                // absent, unreadable, or not a directory
  }
}

// Reads are lenient about existence — a project on an unmounted drive should still render its
// transcript — but they resolve the same way when they can, so the key matches what writes stored.
function normalizeForRead(value) {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  if (candidate === '' || !isAbsolute(candidate)) return null;
  try { return realpathSync(candidate); } catch { return resolve(candidate); }
}

const DECISIONS = new Set(['allow', 'deny', 'always']);
const PERMISSION_PREFIX = '/api/permissions/';

export function chatRoutes({ sessions, permissions, chat, projects, now = Date.now, historyLimit = 200 }) {
  // Every mutating chat route needs the same two things: a parsed body and a real project
  // directory. Doing it once means a new route cannot forget the path check.
  const withProject = (handler) => async (req, res, ctx) => {
    const body = await readJson(req, res);
    if (body === undefined) return;
    const projectPath = normalizeProjectPath(body.projectPath);
    if (projectPath === null) return json(res, 400, { error: 'bad_project' });
    return handler({ req, res, ctx, body, projectPath });
  };

  return [
    {
      method: 'POST', path: '/api/chat', stateChanging: true,
      handler: withProject(async ({ res, body, projectPath }) => {
        if (typeof body.text !== 'string' || body.text.trim() === '') {
          return json(res, 400, { error: 'empty_message' });
        }
        try {
          const { sessionId } = await sessions.send(projectPath, body.text);
          projects.touch(projectPath, now());
          json(res, 200, { ok: true, projectPath, sessionId: sessionId ?? null });
        } catch (err) {
          if (err?.code === 'EMPTY') return json(res, 400, { error: 'empty_message' });
          // Starting a session can fail for reasons outside this process — no CLI on PATH, a
          // broken install. Report it rather than letting the rejection escape the handler.
          json(res, 500, { error: 'chat_failed', detail: String(err?.message ?? err) });
        }
      }),
    },
    {
      method: 'POST', path: '/api/chat/interrupt', stateChanging: true,
      handler: withProject(async ({ res, projectPath }) => {
        const { interrupted } = await sessions.interrupt(projectPath);
        json(res, 200, { ok: true, projectPath, interrupted });
      }),
    },
    {
      method: 'POST', path: '/api/chat/reset', stateChanging: true,
      handler: withProject(async ({ res, projectPath }) => {
        await sessions.reset(projectPath);
        json(res, 200, { ok: true, projectPath });
      }),
    },
    {
      // The only way to answer a permission prompt. It is token-authenticated and Origin-checked
      // like everything else here: an unauthenticated caller cannot release a tool call.
      method: 'POST', prefix: PERMISSION_PREFIX, stateChanging: true,
      handler: async (req, res, ctx) => {
        const body = await readJson(req, res);
        if (body === undefined) return;
        // Validated against a closed set, never passed through to the SDK: 'bypassPermissions' and
        // friends are permission *modes*, and no request may name one.
        if (!DECISIONS.has(body.decision)) return json(res, 400, { error: 'bad_decision' });

        const id = decodeURIComponent(ctx.url.pathname.slice(PERMISSION_PREFIX.length));
        if (id === '') return json(res, 404, { error: 'not_found' });

        const verdict = permissions.resolve(id, body.decision);
        if (!verdict.ok) return json(res, verdict.reason === 'bad_decision' ? 400 : 404, { error: verdict.reason });
        json(res, 200, { ok: true, id, decision: body.decision });
      },
    },
    {
      method: 'GET', path: '/api/chat/history',
      handler: (_req, res, ctx) => {
        const projectPath = normalizeForRead(ctx.url.searchParams.get('projectPath'));
        if (projectPath === null) return json(res, 400, { error: 'bad_project' });
        const state = sessions.get(projectPath);
        json(res, 200, {
          projectPath,
          sessionId: state.sessionId,
          running: state.running,
          pendingPermissions: state.pendingPermissions,
          messages: chat.list(projectPath, historyLimit),
        });
      },
    },
    {
      method: 'GET', path: '/api/projects',
      handler: (_req, res) => json(res, 200, { projects: projects.list() }),
    },
    {
      method: 'POST', path: '/api/projects', stateChanging: true,
      handler: async (req, res) => {
        const body = await readJson(req, res);
        if (body === undefined) return;
        const path = normalizeProjectPath(body.path);
        if (path === null) return json(res, 400, { error: 'bad_project' });
        const project = projects.add({ path, name: basename(path) || path, at: now() });
        json(res, 201, { project });
      },
    },
  ];
}
