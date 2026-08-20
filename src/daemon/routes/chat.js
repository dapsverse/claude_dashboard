// src/daemon/routes/chat.js
//
// The HTTP surface of the orchestrator chat. Every mutating route declares `stateChanging: true`
// and none is `public`, so the daemon's Origin + token guard runs before any of them — a page on
// another 127.0.0.1 port cannot start a session, answer a permission prompt, or reset a
// conversation through the browser's ambient cookie.
import { statSync, realpathSync, mkdirSync } from 'node:fs';
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

// Why the add-project route needs more than `normalizeProjectPath`'s yes/no: "that is not a
// directory on this machine" is a dead end for the two mistakes people actually make — a path typed
// without its leading slash, and a folder that simply does not exist yet. Both have an obvious next
// step, and the UI can only offer it if the reason is distinguishable here.
//
//   { ok: true, path }                  — resolved, exists, is a directory
//   { ok: false, reason: 'empty' }      — nothing usable was sent
//   { ok: false, reason: 'not_absolute', suggestion } — `Users/me/x`; the suggestion adds the slash
//   { ok: false, reason: 'missing', path }           — nothing there yet; `path` is what we'd create
//   { ok: false, reason: 'not_a_directory', path }   — a file is in the way; nothing to offer
//   { ok: false, reason: 'unreadable', path, detail } — it exists but we cannot stat it
export function classifyProjectPath(value) {
  if (typeof value !== 'string' || value.trim() === '') return { ok: false, reason: 'empty' };
  const candidate = value.trim();
  if (!isAbsolute(candidate)) {
    return { ok: false, reason: 'not_absolute', suggestion: `/${candidate.replace(/^\/+/, '')}` };
  }
  try {
    const real = realpathSync(candidate);
    return statSync(real).isDirectory()
      ? { ok: true, path: real }
      : { ok: false, reason: 'not_a_directory', path: real };
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: false, reason: 'missing', path: resolve(candidate) };
    // ENOTDIR is a file somewhere *along* the path rather than at the end of it — `/tmp/notes.txt/x`.
    // It is the same problem as the path itself being a file, and it has the same answer: this can
    // never become a directory, so it is reported rather than offered as something to create.
    if (err?.code === 'ENOTDIR') return { ok: false, reason: 'not_a_directory', path: resolve(candidate) };
    return { ok: false, reason: 'unreadable', path: resolve(candidate), detail: err?.code ?? String(err) };
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

        // `answers` and `notes` are only meaningful for an AskUserQuestion prompt, and the gate is
        // what decides that — it rebuilds both from the questions it actually asked, so a body
        // carrying them for an ordinary tool call changes nothing.
        const verdict = permissions.resolve(id, body.decision, { answers: body.answers, notes: body.notes });
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
        const verdict = classifyProjectPath(body.path);

        // Creating the folder is a second, explicit request — never inferred from the first. The UI
        // shows the exact path it would create and the user asks for it by name, because `mkdir -p`
        // on a typo is how you end up with a tree of empty directories you never meant to make.
        if (!verdict.ok && verdict.reason === 'missing' && body.create === true) {
          try {
            mkdirSync(verdict.path, { recursive: true });
          } catch (err) {
            return json(res, 400, { error: 'create_failed', path: verdict.path, detail: err?.code ?? String(err) });
          }
          const created = classifyProjectPath(verdict.path);
          if (!created.ok) {
            return json(res, 400, { error: 'create_failed', path: verdict.path, detail: created.reason });
          }
          const project = projects.add({ path: created.path, name: basename(created.path) || created.path, at: now() });
          return json(res, 201, { project, created: true });
        }

        if (!verdict.ok) {
          // `bad_project` is kept as the code for "nothing usable was sent" so a client that only
          // knows the old contract still reads a familiar error for the case it was written for.
          const error = verdict.reason === 'empty' ? 'bad_project' : verdict.reason;
          const { ok, reason, ...rest } = verdict;      // `ok: false` is the status code's job
          return json(res, 400, { error, ...rest });
        }

        const project = projects.add({ path: verdict.path, name: basename(verdict.path) || verdict.path, at: now() });
        json(res, 201, { project, created: false });
      },
    },
  ];
}
