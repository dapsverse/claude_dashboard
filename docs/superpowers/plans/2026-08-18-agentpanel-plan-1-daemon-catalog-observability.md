# agentpanel Plan 1 — Daemon, Catalog, Live Observability (M0–M2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a running localhost daemon that auto-starts with Claude Code, shows every agent and skill installed on the machine, and displays live subagent activity from all sessions.

**Architecture:** A single Node process binds 127.0.0.1 (port 8888, scanning to 8988), writes its port and auth token to `~/.claude/agentpanel/daemon.json`, and serves a prebuilt React SPA plus an SSE stream. Claude Code hooks POST their stdin payloads to `/api/hooks`; a correlator turns `PreToolUse[Task]` / `PostToolUse[Task]` pairs into `AgentRun` rows in SQLite and pushes them to the UI. This plan contains no orchestrator chat and no SDK dependency — that is Plan 2.

**Tech Stack:** Node >= 22.5 (`node:http`, `node:sqlite`, `node:test`), zero runtime dependencies; React + Vite for the UI, built and shipped prebuilt; bash for hook scripts.

**Spec:** `docs/superpowers/specs/2026-08-18-agentpanel-design.md`

## Global Constraints

- Node floor `>=22.5.0` (first version with `node:sqlite`). Declared in `package.json` `engines`.
- Daemon process is spawned with `--disable-warning=ExperimentalWarning` (verified to suppress the `node:sqlite` experimental notice on Node 24.6.0).
- **Zero runtime dependencies.** React, Vite, and Playwright are `devDependencies` only. Any proposal to add a runtime dependency is a spec change.
- All UI copy, code, comments, and docs in English. The repository is public.
- Daemon binds `127.0.0.1` only. No route, config value, or environment variable may cause a non-loopback bind; only the explicit `--unsafe-bind` CLI flag can, and it prints a warning.
- Every route, `/api/hooks` included, requires the token (bearer header or httpOnly SameSite=Strict cookie).
- Every request must pass `Host` validation (`127.0.0.1:<port>` or `localhost:<port>`); state-changing routes also require a matching `Origin`.
- `daemon.json` and `data.db` are created with mode `0600`.
- Hook scripts always exit 0 and print nothing on the success path. A dashboard must never break a terminal session.
- Filesystem writes are confined to `~/.claude/**` and `<selected project>/.claude/**`, re-checked after path resolution.
- Every task ends with tests passing and a commit.
- Verified hook payload fields (from `@anthropic-ai/claude-agent-sdk@0.3.234`, `claudeCodeVersion: 2.1.234`) — treat these as the contract:
  - common to all events: `session_id: string`, `transcript_path: string`, `cwd: string`, `prompt_id?: string`, `permission_mode?: string`, `agent_id?: string`, `agent_type?: string`, `effort?: { level: string }`
  - `PreToolUse`: `+ hook_event_name: 'PreToolUse'`, `tool_name: string`, `tool_input: unknown`, `tool_use_id: string`
  - `PostToolUse`: `+ hook_event_name: 'PostToolUse'`, `tool_name: string`, `tool_input: unknown`, `tool_response: unknown`, `tool_use_id: string`, `duration_ms?: number`
  - `SubagentStop`: `+ hook_event_name: 'SubagentStop'`, `agent_id: string`, `agent_type: string`, `agent_transcript_path: string`, `stop_hook_active: boolean`, `last_assistant_message?: string`
  - `SessionEnd`: `+ hook_event_name: 'SessionEnd'`
  - The subagent-dispatch tool is named **`Agent`** on CLI 2.1.234 (verified by captured fixture). Older and
    other builds name it `Task`, and `toolAliases` can rename it, so treat `AGENT_TOOL_NAMES = ['Agent', 'Task']`
    as the set. Its `tool_input` has `subagent_type: string`, `description: string`, `prompt: string`, and
    optionally `run_in_background: boolean`

---

## File Structure

Files that change together live together. Each module below has one responsibility and is tested in isolation.

**Runtime (zero dependencies):**

| File | Responsibility |
|---|---|
| `bin/agentpanel.js` | shebang entry, delegates to `src/cli/index.js` |
| `src/cli/index.js` | subcommand dispatch: `init`, `start`, `stop`, `status`, `open`, `uninstall` |
| `src/cli/init.js` | merge hook entries into `~/.claude/settings.json`, idempotent, prints the diff first |
| `src/cli/uninstall.js` | remove hook entries, state dir, and database; print what was removed |
| `src/core/paths.js` | every filesystem location the product knows about — single source of truth |
| `src/core/port.js` | find a free port in a range on a given host |
| `src/core/runtime-file.js` | read/write/clear `daemon.json` atomically at mode 0600; PID liveness |
| `src/core/redact.js` | strip secret-shaped strings before persistence |
| `src/core/frontmatter.js` | parse the YAML subset used by agent and skill frontmatter |
| `src/core/correlator.js` | pure state machine: hook events in, run actions out |
| `src/store/db.js` | open SQLite, apply schema migrations |
| `src/store/runs.js` | AgentRun repository |
| `src/store/sessions.js` | Session repository |
| `src/catalog/agents.js` | scan agent definitions across user, project, and plugin scopes |
| `src/catalog/skills.js` | scan skill definitions across the same scopes |
| `src/catalog/index.js` | merge scanners, mtime cache, `fs.watch` change notification |
| `src/daemon/index.js` | daemon bootstrap: port, runtime file, wiring, shutdown |
| `src/daemon/server.js` | routing table over `node:http` |
| `src/daemon/auth.js` | token generation, constant-time compare, Host/Origin guards, cookie exchange |
| `src/daemon/sse.js` | SSE client hub |
| `src/daemon/routes/*.js` | one file per route group: `auth`, `hooks` (also serves `/api/runs`), `catalog`, `static` |
| `hooks/agentpanel-hook.sh` | generic: read stdin, POST to daemon, always exit 0 |
| `hooks/agentpanel-bootstrap.sh` | SessionStart: start the daemon if it is not alive, then exit 0 |

**UI (devDependencies only, built to `dist/ui`):** `ui/src/main.jsx`, `ui/src/api.js` (SSE client), `ui/src/pages/{Agents,Skills,Activity}.jsx`, `ui/src/components/{LiveRail,RunRow,Layout}.jsx`.

**Tests:** mirrored under `test/`, one file per module, plus `test/fixtures/hooks/*.json` holding real captured payloads.

---
## Task 0: Capture real hook payloads as fixtures

Every later task tests against these files. Capture them from a real Claude Code session before writing any
correlation logic — the SDK types tell us the shape, and this proves the wire format matches.

**Files:**
- Create: `test/fixtures/hooks/pre-tool-use-task.json`, `post-tool-use-task.json`, `subagent-stop.json`, `session-start.json`, `session-end.json`
- Create: `tools/capture-fixtures.sh`

**Interfaces:**
- Consumes: nothing
- Produces: the five fixture files, each the verbatim stdin JSON one hook received

- [ ] **Step 1: Write the capture harness**

```bash
mkdir -p tools && cat > tools/capture-fixtures.sh <<'EOF'
#!/usr/bin/env bash
# Captures real hook stdin payloads WITHOUT touching ~/.claude/settings.json.
# Uses an isolated settings file passed via `claude --settings`.
set -euo pipefail
OUT="$(mktemp -d)"; echo "capturing to $OUT"
cat > "$OUT/settings.json" <<JSON
{
  "hooks": {
    "SessionStart":  [{ "hooks": [{ "type": "command", "command": "cat > $OUT/session-start.json" }] }],
    "SessionEnd":    [{ "hooks": [{ "type": "command", "command": "cat > $OUT/session-end.json" }] }],
    "SubagentStop":  [{ "hooks": [{ "type": "command", "command": "cat > $OUT/subagent-stop.json" }] }],
    "PreToolUse":    [{ "matcher": "Task", "hooks": [{ "type": "command", "command": "cat > $OUT/pre-tool-use-task.json" }] }],
    "PostToolUse":   [{ "matcher": "Task", "hooks": [{ "type": "command", "command": "cat > $OUT/post-tool-use-task.json" }] }]
  }
}
JSON
cd "$OUT"
claude --settings "$OUT/settings.json" -p \
  "Use the Task tool to dispatch one Explore subagent with the prompt 'echo hello and stop'. Then stop."
ls -la "$OUT"/*.json
EOF
chmod +x tools/capture-fixtures.sh
```

- [ ] **Step 2: Run it and inspect what arrived**

Run: `./tools/capture-fixtures.sh`
Expected: five JSON files. Confirm by eye that `pre-tool-use-task.json` contains `tool_use_id`,
`tool_name` (`"Agent"` on CLI 2.1.234), and `tool_input.subagent_type`; that `post-tool-use-task.json`
contains the same `tool_use_id` plus `tool_response`.

- [ ] **Step 3: Copy fixtures in, redacting local paths**

Copy the five files into `test/fixtures/hooks/`. Replace your real home directory with `/home/testuser`
throughout, and replace any prompt text with `"prompt": "test prompt"`. Fixtures land in a public repo.

- [ ] **Step 4: Record any mismatch against the documented contract**

If a field in the Global Constraints contract is absent or differently named in a captured fixture, STOP and
report it. The plan's correlator design depends on `tool_use_id` being present on both Task events. Do not
work around a mismatch silently.

- [ ] **Step 5: Commit**

```bash
git add tools/capture-fixtures.sh test/fixtures/hooks
git commit -m "test: capture real hook payload fixtures"
```

---

## Task 1: Project scaffold and path resolution

**Files:**
- Create: `package.json`, `.gitignore`, `src/core/paths.js`
- Test: `test/core/paths.test.js`

**Interfaces:**
- Produces: `claudeHome()`, `stateDir()`, `runtimeFilePath()`, `dbPath()`, `logFilePath()`, `userSettingsPath()`,
  `userAgentsDir()`, `userSkillsDir()`, `pluginsCacheDir()`, `projectAgentsDir(root)`, `projectSkillsDir(root)` — all
  return absolute path strings and take no I/O.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "agentpanel",
  "version": "0.1.0",
  "description": "Local dashboard for Claude Code: live subagent activity, agent and skill catalog",
  "type": "module",
  "bin": { "agentpanel": "bin/agentpanel.js" },
  "engines": { "node": ">=22.5.0" },
  "license": "MIT",
  "scripts": {
    "test": "node --test --disable-warning=ExperimentalWarning test/**/*.test.js"
  },
  "files": ["bin", "src", "hooks", "dist"],
  "dependencies": {},
  "devDependencies": {}
}
```

Also create `.gitignore` with `node_modules/`, `dist/`, `*.log`, `.DS_Store`.

- [ ] **Step 2: Write the failing test**

```js
// test/core/paths.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { homedir } from 'node:os';

test('claudeHome defaults to ~/.claude', async () => {
  delete process.env.CLAUDE_CONFIG_DIR;
  const { claudeHome } = await import('../../src/core/paths.js?1');
  assert.equal(claudeHome(), join(homedir(), '.claude'));
});

test('CLAUDE_CONFIG_DIR overrides and is resolved to absolute', async () => {
  process.env.CLAUDE_CONFIG_DIR = '/tmp/cfg/../cfg';
  const { claudeHome, stateDir, dbPath } = await import('../../src/core/paths.js?2');
  assert.equal(claudeHome(), '/tmp/cfg');
  assert.equal(stateDir(), '/tmp/cfg/agentpanel');
  assert.equal(dbPath(), '/tmp/cfg/agentpanel/data.db');
  delete process.env.CLAUDE_CONFIG_DIR;
});

test('project dirs resolve relative roots', async () => {
  const { projectAgentsDir } = await import('../../src/core/paths.js?3');
  assert.equal(projectAgentsDir('/a/b/'), '/a/b/.claude/agents');
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npm test`
Expected: FAIL — `Cannot find module .../src/core/paths.js`

- [ ] **Step 4: Implement**

```js
// src/core/paths.js
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR
    ? resolve(process.env.CLAUDE_CONFIG_DIR)
    : join(homedir(), '.claude');
}

export function stateDir() { return join(claudeHome(), 'agentpanel'); }
export function runtimeFilePath() { return join(stateDir(), 'daemon.json'); }
export function dbPath() { return join(stateDir(), 'data.db'); }
export function logFilePath() { return join(stateDir(), 'daemon.log'); }
export function userSettingsPath() { return join(claudeHome(), 'settings.json'); }
export function userAgentsDir() { return join(claudeHome(), 'agents'); }
export function userSkillsDir() { return join(claudeHome(), 'skills'); }
export function pluginsCacheDir() { return join(claudeHome(), 'plugins', 'cache'); }
export function projectAgentsDir(root) { return join(resolve(root), '.claude', 'agents'); }
export function projectSkillsDir(root) { return join(resolve(root), '.claude', 'skills'); }
```

- [ ] **Step 5: Run tests, confirm green, commit**

```bash
npm test
git add package.json .gitignore src/core/paths.js test/core/paths.test.js
git commit -m "feat: add path resolution module"
```

---

## Task 2: Free port discovery

**Files:**
- Create: `src/core/port.js`
- Test: `test/core/port.test.js`

**Interfaces:**
- Produces: `isPortFree(port, host?) => Promise<boolean>`, `findAvailablePort({host?, start?, end?}) => Promise<number>`,
  `PortRangeExhaustedError`. Defaults: host `127.0.0.1`, start `8888`, end `8988`.

- [ ] **Step 1: Write the failing test**

```js
// test/core/port.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { findAvailablePort, isPortFree, PortRangeExhaustedError } from '../../src/core/port.js';

function occupy(port) {
  return new Promise((res) => {
    const s = createServer();
    s.listen(port, '127.0.0.1', () => res(s));
  });
}

test('skips an occupied port and returns the next free one', async () => {
  const held = await occupy(18888);
  try {
    const port = await findAvailablePort({ start: 18888, end: 18890 });
    assert.equal(port, 18889);
  } finally { held.close(); }
});

test('reports an occupied port as not free', async () => {
  const held = await occupy(18891);
  try { assert.equal(await isPortFree(18891), false); }
  finally { held.close(); }
});

test('throws when the whole range is taken', async () => {
  const a = await occupy(18892);
  try {
    await assert.rejects(
      () => findAvailablePort({ start: 18892, end: 18892 }),
      (e) => e instanceof PortRangeExhaustedError
    );
  } finally { a.close(); }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// src/core/port.js
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
```

- [ ] **Step 4: Run tests, confirm green, commit**

```bash
npm test
git add src/core/port.js test/core/port.test.js
git commit -m "feat: add free port discovery"
```

---

## Task 3: Runtime state file

**Files:**
- Create: `src/core/runtime-file.js`
- Test: `test/core/runtime-file.test.js`

**Interfaces:**
- Produces: `writeRuntime(info, file?)`, `readRuntime(file?)`, `readLiveRuntime(file?)`, `clearRuntime(file?)`,
  `isAlive(pid)`. The stored record is `{ pid, port, token, startedAt, version }`. Writes are atomic
  (temp file + rename) and mode `0600`; the containing directory is mode `0700`.

- [ ] **Step 1: Write the failing test**

```js
// test/core/runtime-file.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeRuntime, readRuntime, readLiveRuntime, clearRuntime, isAlive } from '../../src/core/runtime-file.js';

const file = () => join(mkdtempSync(join(tmpdir(), 'ap-')), 'nested', 'daemon.json');

test('writes 0600 and reads back', () => {
  const f = file();
  writeRuntime({ pid: process.pid, port: 8888, token: 'abc', startedAt: 1, version: '0.1.0' }, f);
  assert.equal((statSync(f).mode & 0o777), 0o600);
  assert.equal(readRuntime(f).port, 8888);
});

test('readRuntime returns null for missing or corrupt files', () => {
  assert.equal(readRuntime('/nonexistent/daemon.json'), null);
});

test('readLiveRuntime returns null when the pid is dead', () => {
  const f = file();
  writeRuntime({ pid: 999999, port: 8888, token: 'abc', startedAt: 1, version: '0.1.0' }, f);
  assert.equal(readLiveRuntime(f), null);
  assert.ok(readRuntime(f), 'the file itself is left in place for diagnostics');
});

test('readLiveRuntime returns the record when the pid is alive', () => {
  const f = file();
  writeRuntime({ pid: process.pid, port: 8888, token: 'abc', startedAt: 1, version: '0.1.0' }, f);
  assert.equal(readLiveRuntime(f).token, 'abc');
});

test('isAlive rejects nonsense pids', () => {
  assert.equal(isAlive(0), false);
  assert.equal(isAlive(-1), false);
  assert.equal(isAlive('x'), false);
});

test('clearRuntime is idempotent', () => {
  const f = file();
  writeRuntime({ pid: process.pid, port: 1, token: 't', startedAt: 1, version: '0.1.0' }, f);
  clearRuntime(f); clearRuntime(f);
  assert.equal(readRuntime(f), null);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// src/core/runtime-file.js
import { writeFileSync, readFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { runtimeFilePath } from './paths.js';

export function writeRuntime(info, file = runtimeFilePath()) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(info, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  return info;
}

export function readRuntime(file = runtimeFilePath()) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }   // alive but owned by another user
}

export function readLiveRuntime(file = runtimeFilePath()) {
  const info = readRuntime(file);
  return info && isAlive(info.pid) ? info : null;
}

export function clearRuntime(file = runtimeFilePath()) {
  rmSync(file, { force: true });
}
```

- [ ] **Step 4: Run tests, confirm green, commit**

```bash
npm test
git add src/core/runtime-file.js test/core/runtime-file.test.js
git commit -m "feat: add atomic runtime state file"
```

---
## Task 4: Authentication and request guards

This task implements Global Constraints 5, 6, and 7. Review those lines before starting.

**Files:**
- Create: `src/daemon/auth.js`
- Test: `test/daemon/auth.test.js`

**Interfaces:**
- Produces: `COOKIE_NAME`, `generateToken() => string` (64 hex chars), `safeEqual(a, b) => boolean`,
  `allowedHosts(port) => string[]`, `checkHost(headers, port) => boolean`, `checkOrigin(headers, port) => boolean`,
  `readCookie(headers, name) => string|null`, `bearer(headers) => string|null`,
  `authorize(req, { token, port, stateChanging }) => { ok: true } | { ok: false, status, reason }`.
  Reasons are exactly `'bad_host'`, `'bad_origin'`, `'bad_token'`.

- [ ] **Step 1: Write the failing test**

```js
// test/daemon/auth.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorize, generateToken, safeEqual, readCookie, COOKIE_NAME } from '../../src/daemon/auth.js';

const TOKEN = 'a'.repeat(64);
const req = (headers) => ({ headers });
const ok = { token: TOKEN, port: 8888 };

test('token is 64 hex chars and unique per call', () => {
  const a = generateToken(), b = generateToken();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});

test('safeEqual handles length mismatch without throwing', () => {
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual(undefined, 'a'), false);
  assert.equal(safeEqual('abc', 'abc'), true);
});

test('accepts a bearer token on a loopback host', () => {
  const r = req({ host: '127.0.0.1:8888', authorization: `Bearer ${TOKEN}` });
  assert.deepEqual(authorize(r, ok), { ok: true });
});

test('accepts the cookie form', () => {
  const r = req({ host: 'localhost:8888', cookie: `other=1; ${COOKIE_NAME}=${TOKEN}` });
  assert.deepEqual(authorize(r, ok), { ok: true });
});

test('rejects a missing token', () => {
  const r = req({ host: '127.0.0.1:8888' });
  assert.deepEqual(authorize(r, ok), { ok: false, status: 401, reason: 'bad_token' });
});

test('rejects a wrong token', () => {
  const r = req({ host: '127.0.0.1:8888', authorization: `Bearer ${'b'.repeat(64)}` });
  assert.equal(authorize(r, ok).reason, 'bad_token');
});

test('rejects a foreign Host header — this closes DNS rebinding', () => {
  const r = req({ host: 'evil.example.com', authorization: `Bearer ${TOKEN}` });
  assert.deepEqual(authorize(r, ok), { ok: false, status: 403, reason: 'bad_host' });
});

test('rejects the right host on the wrong port', () => {
  const r = req({ host: '127.0.0.1:9999', authorization: `Bearer ${TOKEN}` });
  assert.equal(authorize(r, ok).reason, 'bad_host');
});

test('rejects a cross-site Origin on state-changing requests', () => {
  const r = req({ host: '127.0.0.1:8888', origin: 'https://evil.example.com', authorization: `Bearer ${TOKEN}` });
  assert.deepEqual(authorize(r, { ...ok, stateChanging: true }), { ok: false, status: 403, reason: 'bad_origin' });
});

test('allows an absent Origin on state-changing requests — hook scripts are not browsers', () => {
  const r = req({ host: '127.0.0.1:8888', authorization: `Bearer ${TOKEN}` });
  assert.deepEqual(authorize(r, { ...ok, stateChanging: true }), { ok: true });
});

test('allows our own Origin on state-changing requests', () => {
  const r = req({ host: '127.0.0.1:8888', origin: 'http://127.0.0.1:8888', authorization: `Bearer ${TOKEN}` });
  assert.deepEqual(authorize(r, { ...ok, stateChanging: true }), { ok: true });
});

test('host check runs before token check so a bad host never leaks timing on the token', () => {
  const r = req({ host: 'evil.example.com' });
  assert.equal(authorize(r, ok).reason, 'bad_host');
});

test('readCookie ignores prefix collisions', () => {
  assert.equal(readCookie({ cookie: `not_${COOKIE_NAME}=x; ${COOKIE_NAME}=y` }, COOKIE_NAME), 'y');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
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
```

- [ ] **Step 4: Run tests, confirm green, commit**

```bash
npm test
git add src/daemon/auth.js test/daemon/auth.test.js
git commit -m "feat: add token auth with Host and Origin guards"
```

---

## Task 5: HTTP server, SSE hub, and health route

**Files:**
- Create: `src/daemon/sse.js`, `src/daemon/server.js`
- Test: `test/daemon/server.test.js`

**Interfaces:**
- Consumes: `authorize` from Task 4.
- Produces:
  - `createHub() => { add(res), broadcast(event, data), size(), closeAll() }` — `broadcast` writes
    `event: <event>\ndata: <json>\n\n` to every client.
  - `createServer({ token, port, hub, routes }) => http.Server`. `routes` is an array of
    `{ method, path, stateChanging?, public?, handler(req, res, ctx) }`, matched by exact path.
    `ctx` is `{ token, port, hub, url }`. Unmatched paths yield 404 JSON `{ error: 'not_found' }`.
    Guard failures yield `{ error: <reason> }` at the guard's status.

- [ ] **Step 1: Write the failing test**

```js
// test/daemon/server.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../../src/daemon/sse.js';
import { createServer } from '../../src/daemon/server.js';

const TOKEN = 'c'.repeat(64);

async function boot(routes = []) {
  const hub = createHub();
  const server = createServer({ token: TOKEN, port: 0, hub, routes });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { server, hub, port, base: `http://127.0.0.1:${port}` };
}

test('health route requires no token but still enforces Host', async () => {
  const { server, base } = await boot([
    { method: 'GET', path: '/api/health', public: true, handler: (_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
    } },
  ]);
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  server.close();
});

test('protected route rejects without a token', async () => {
  const { server, base } = await boot([
    { method: 'GET', path: '/api/runs', handler: (_q, res) => { res.writeHead(200); res.end('[]'); } },
  ]);
  const res = await fetch(`${base}/api/runs`);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'bad_token' });
  server.close();
});

test('protected route accepts a bearer token', async () => {
  const { server, base } = await boot([
    { method: 'GET', path: '/api/runs', handler: (_q, res) => { res.writeHead(200); res.end('[]'); } },
  ]);
  const res = await fetch(`${base}/api/runs`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 200);
  server.close();
});

test('unknown path returns 404 json', async () => {
  const { server, base } = await boot();
  const res = await fetch(`${base}/nope`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'not_found' });
  server.close();
});

test('wrong method on a known path returns 404', async () => {
  const { server, base } = await boot([
    { method: 'GET', path: '/api/runs', handler: (_q, res) => { res.writeHead(200); res.end('[]'); } },
  ]);
  const res = await fetch(`${base}/api/runs`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 404);
  server.close();
});

test('hub broadcasts framed SSE to connected clients', async () => {
  const chunks = [];
  const fakeRes = { write: (c) => chunks.push(c), end() {}, on() {}, writeHead() {}, flushHeaders() {} };
  const hub = createHub();
  hub.add(fakeRes);
  assert.equal(hub.size(), 1);
  hub.broadcast('run.open', { id: 'x' });
  assert.equal(chunks.at(-1), 'event: run.open\ndata: {"id":"x"}\n\n');
});

test('hub drops a client whose write throws', () => {
  const hub = createHub();
  hub.add({ write() { throw new Error('EPIPE'); }, end() {}, on() {}, writeHead() {}, flushHeaders() {} });
  hub.broadcast('ping', {});
  assert.equal(hub.size(), 0);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the SSE hub**

```js
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
```

- [ ] **Step 4: Implement the server**

Note the port used by the guard is the port the server actually bound, not the requested one — tests bind to
port 0.

```js
// src/daemon/server.js
import { createServer as createHttpServer } from 'node:http';
import { authorize } from './auth.js';

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

export function createServer({ token, port, hub, routes }) {
  const server = createHttpServer((req, res) => {
    const boundPort = server.address()?.port ?? port;
    const url = new URL(req.url, `http://127.0.0.1:${boundPort}`);
    const route = routes.find((r) => r.method === req.method && r.path === url.pathname);

    if (!route) return sendJson(res, 404, { error: 'not_found' });

    if (!route.public) {
      const verdict = authorize(req, { token, port: boundPort, stateChanging: !!route.stateChanging });
      if (!verdict.ok) return sendJson(res, verdict.status, { error: verdict.reason });
    } else if (String(req.headers.host ?? '').split(':')[0] !== '127.0.0.1'
            && String(req.headers.host ?? '').split(':')[0] !== 'localhost') {
      return sendJson(res, 403, { error: 'bad_host' });
    }

    try {
      route.handler(req, res, { token, port: boundPort, hub, url });
    } catch (err) {
      sendJson(res, 500, { error: 'handler_failed', detail: String(err?.message ?? err) });
    }
  });

  return server;
}
```

- [ ] **Step 5: Run tests, confirm green, commit**

```bash
npm test
git add src/daemon/sse.js src/daemon/server.js test/daemon/server.test.js
git commit -m "feat: add http server routing and SSE hub"
```

---
## Task 6: Secret redaction

Runs store the dispatch prompt and the tool response. Both can contain credentials pasted by the user or
printed by a command. Redaction happens before persistence, never at render time.

**Files:**
- Create: `src/core/redact.js`
- Test: `test/core/redact.test.js`

**Interfaces:**
- Produces: `redact(text) => string`, `REDACTED = '[redacted]'`, `truncate(text, max) => string`,
  `preview(text, max = 500) => string` (redact then truncate; appends `'…'` when cut).

- [ ] **Step 1: Write the failing test**

```js
// test/core/redact.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, preview, truncate, REDACTED } from '../../src/core/redact.js';

test('redacts anthropic-style keys', () => {
  assert.equal(redact('use sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv now'), `use ${REDACTED} now`);
});

test('redacts github tokens', () => {
  assert.equal(redact('ghp_0123456789abcdefghijklmnopqrstuvwxyz'), REDACTED);
});

test('redacts aws access key ids', () => {
  assert.equal(redact('AKIAIOSFODNN7EXAMPLE'), REDACTED);
});

test('redacts private key blocks', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----';
  assert.equal(redact(pem), REDACTED);
});

test('redacts long hex runs such as seeds', () => {
  assert.equal(redact(`seed ${'a1b2c3d4'.repeat(8)}`), `seed ${REDACTED}`);
});

test('leaves ordinary prose and short hex alone', () => {
  const s = 'commit deadbeef fixes the parser';
  assert.equal(redact(s), s);
});

test('is null-safe', () => {
  assert.equal(redact(undefined), '');
  assert.equal(redact(null), '');
});

test('truncate appends an ellipsis only when it cuts', () => {
  assert.equal(truncate('abcdef', 3), 'abc…');
  assert.equal(truncate('ab', 3), 'ab');
});

test('preview redacts before truncating so a cut key cannot survive', () => {
  const out = preview(`x${' '.repeat(40)}ghp_0123456789abcdefghijklmnopqrstuvwxyz`, 20);
  assert.ok(!out.includes('ghp_'));
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// src/core/redact.js
export const REDACTED = '[redacted]';

const PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,   // JWT
  /\b[0-9a-fA-F]{40,}\b/g,                                            // seeds, long digests
];

export function redact(text) {
  if (typeof text !== 'string') return '';
  return PATTERNS.reduce((acc, re) => acc.replace(re, REDACTED), text);
}

export function truncate(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function preview(text, max = 500) {
  return truncate(redact(text), max);
}
```

- [ ] **Step 4: Run tests, confirm green, commit**

```bash
npm test
git add src/core/redact.js test/core/redact.test.js
git commit -m "feat: redact secret-shaped strings before persistence"
```

---

## Task 7: SQLite store

**Files:**
- Create: `src/store/db.js`, `src/store/runs.js`, `src/store/sessions.js`
- Test: `test/store/store.test.js`

**Interfaces:**
- Produces:
  - `openDb(path) => DatabaseSync` — creates parent dirs at `0700`, sets the file to `0600`, applies the schema.
  - `createRunsRepo(db) => { open(run), close(patch), enrich(match, patch), get(id), listActive(), listRecent(limit),
    markStaleBefore(cutoffTs, now), endSessionRuns(sessionId, now), pruneBefore(ts) }`
  - `createSessionsRepo(db) => { touch(session), end(id, ts), get(id), list() }`
- Run shape: `{ id, sessionId, agentType, description, prompt, status, startedAt, endedAt, durationMs,
  resultPreview, transcriptPath }`. `status` ∈ `'running' | 'done' | 'error' | 'stale'`.
- `open()` is idempotent on `id` (a replayed hook must not duplicate a row); `close()` on an unknown id is a no-op.

- [ ] **Step 1: Write the failing test**

```js
// test/store/store.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/store/db.js';
import { createRunsRepo } from '../../src/store/runs.js';
import { createSessionsRepo } from '../../src/store/sessions.js';

const fresh = () => openDb(join(mkdtempSync(join(tmpdir(), 'ap-db-')), 'nested', 'data.db'));
const baseRun = { id: 's1:t1', sessionId: 's1', agentType: 'programmer', description: 'do a thing', prompt: 'p', startedAt: 1000 };

test('database file is created 0600', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'ap-db-')), 'data.db');
  openDb(path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('open then close produces a completed run with a duration', () => {
  const runs = createRunsRepo(fresh());
  runs.open(baseRun);
  runs.close({ id: 's1:t1', status: 'done', endedAt: 3500, resultPreview: 'ok' });
  const row = runs.get('s1:t1');
  assert.equal(row.status, 'done');
  assert.equal(row.durationMs, 2500);
  assert.equal(row.resultPreview, 'ok');
});

test('close honours an explicitly supplied durationMs', () => {
  const runs = createRunsRepo(fresh());
  runs.open(baseRun);
  runs.close({ id: 's1:t1', status: 'done', endedAt: 3500, durationMs: 99, resultPreview: 'ok' });
  assert.equal(runs.get('s1:t1').durationMs, 99);
});

test('open is idempotent — a replayed hook does not duplicate or reset the row', () => {
  const runs = createRunsRepo(fresh());
  runs.open(baseRun);
  runs.open({ ...baseRun, startedAt: 9999, description: 'changed' });
  assert.equal(runs.listActive().length, 1);
  assert.equal(runs.get('s1:t1').startedAt, 1000);
});

test('closing an unknown id is a silent no-op', () => {
  const runs = createRunsRepo(fresh());
  runs.close({ id: 'ghost', status: 'done', endedAt: 1 });
  assert.equal(runs.get('ghost'), null);
});

test('listActive returns only running rows, newest first', () => {
  const runs = createRunsRepo(fresh());
  runs.open({ ...baseRun, id: 'a', startedAt: 1 });
  runs.open({ ...baseRun, id: 'b', startedAt: 2 });
  runs.close({ id: 'a', status: 'done', endedAt: 5 });
  assert.deepEqual(runs.listActive().map((r) => r.id), ['b']);
});

test('markStaleBefore only touches running rows older than the cutoff', () => {
  const runs = createRunsRepo(fresh());
  runs.open({ ...baseRun, id: 'old', startedAt: 1 });
  runs.open({ ...baseRun, id: 'new', startedAt: 10_000 });
  runs.markStaleBefore(5000, 20_000);
  assert.equal(runs.get('old').status, 'stale');
  assert.equal(runs.get('new').status, 'running');
});

test('endSessionRuns marks that session\'s open runs stale and leaves others alone', () => {
  const runs = createRunsRepo(fresh());
  runs.open({ ...baseRun, id: 'mine', sessionId: 's1' });
  runs.open({ ...baseRun, id: 'other', sessionId: 's2' });
  runs.endSessionRuns('s1', 7000);
  assert.equal(runs.get('mine').status, 'stale');
  assert.equal(runs.get('other').status, 'running');
});

test('enrich attaches transcript data to the oldest matching open run', () => {
  const runs = createRunsRepo(fresh());
  runs.open({ ...baseRun, id: 'first', startedAt: 1 });
  runs.open({ ...baseRun, id: 'second', startedAt: 2 });
  const hit = runs.enrich({ sessionId: 's1', agentType: 'programmer' }, { transcriptPath: '/t.jsonl' });
  assert.equal(hit, 'first');
  assert.equal(runs.get('first').transcriptPath, '/t.jsonl');
  assert.equal(runs.get('second').transcriptPath, null);
});

test('enrich returns null when nothing matches, rather than guessing', () => {
  const runs = createRunsRepo(fresh());
  runs.open(baseRun);
  assert.equal(runs.enrich({ sessionId: 's1', agentType: 'qa' }, { transcriptPath: '/t' }), null);
});

test('pruneBefore deletes finished rows older than the cutoff and keeps running ones', () => {
  const runs = createRunsRepo(fresh());
  runs.open({ ...baseRun, id: 'old' });
  runs.close({ id: 'old', status: 'done', endedAt: 100 });
  runs.open({ ...baseRun, id: 'live', startedAt: 100 });
  runs.pruneBefore(1000);
  assert.equal(runs.get('old'), null);
  assert.ok(runs.get('live'));
});

test('sessions touch upserts and preserves the original startedAt', () => {
  const s = createSessionsRepo(fresh());
  s.touch({ id: 'x', projectPath: '/p', source: 'terminal', at: 10 });
  s.touch({ id: 'x', projectPath: '/p', source: 'terminal', at: 20 });
  assert.equal(s.get('x').startedAt, 10);
  assert.equal(s.get('x').lastEventAt, 20);
  s.end('x', 30);
  assert.equal(s.get('x').status, 'ended');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `db.js`**

```js
// src/store/db.js
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  project_path  TEXT,
  source        TEXT NOT NULL DEFAULT 'terminal',
  status        TEXT NOT NULL DEFAULT 'active',
  started_at    INTEGER NOT NULL,
  last_event_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  agent_type      TEXT,
  description     TEXT,
  prompt          TEXT,
  status          TEXT NOT NULL,
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  duration_ms     INTEGER,
  result_preview  TEXT,
  transcript_path TEXT
);
CREATE INDEX IF NOT EXISTS runs_status_idx  ON runs(status, started_at DESC);
CREATE INDEX IF NOT EXISTS runs_session_idx ON runs(session_id);
`;

export function openDb(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  chmodSync(path, 0o600);
  return db;
}
```

- [ ] **Step 4: Implement `runs.js`**

```js
// src/store/runs.js
const toRun = (r) => r == null ? null : ({
  id: r.id, sessionId: r.session_id, agentType: r.agent_type, description: r.description,
  prompt: r.prompt, status: r.status, startedAt: r.started_at, endedAt: r.ended_at,
  durationMs: r.duration_ms, resultPreview: r.result_preview, transcriptPath: r.transcript_path,
});

export function createRunsRepo(db) {
  const insert = db.prepare(`INSERT OR IGNORE INTO runs
    (id, session_id, agent_type, description, prompt, status, started_at)
    VALUES (?, ?, ?, ?, ?, 'running', ?)`);
  const closeStmt = db.prepare(`UPDATE runs
    SET status = ?, ended_at = ?, duration_ms = ?, result_preview = ?
    WHERE id = ? AND status = 'running'`);
  const getStmt = db.prepare('SELECT * FROM runs WHERE id = ?');
  const activeStmt = db.prepare("SELECT * FROM runs WHERE status = 'running' ORDER BY started_at DESC");
  const recentStmt = db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?');
  const staleStmt = db.prepare("UPDATE runs SET status = 'stale', ended_at = ? WHERE status = 'running' AND started_at < ?");
  const endSessionStmt = db.prepare("UPDATE runs SET status = 'stale', ended_at = ? WHERE status = 'running' AND session_id = ?");
  const oldestMatchStmt = db.prepare(`SELECT id FROM runs
    WHERE status = 'running' AND session_id = ? AND agent_type = ? ORDER BY started_at ASC LIMIT 1`);
  const enrichStmt = db.prepare('UPDATE runs SET transcript_path = ?, result_preview = COALESCE(?, result_preview) WHERE id = ?');
  const pruneStmt = db.prepare("DELETE FROM runs WHERE status != 'running' AND COALESCE(ended_at, started_at) < ?");

  return {
    open({ id, sessionId, agentType, description, prompt, startedAt }) {
      insert.run(id, sessionId, agentType ?? null, description ?? null, prompt ?? null, startedAt);
    },
    close({ id, status, endedAt, durationMs, resultPreview }) {
      const row = getStmt.get(id);
      if (!row) return false;
      const duration = durationMs ?? (endedAt - row.started_at);
      closeStmt.run(status, endedAt, duration, resultPreview ?? null, id);
      return true;
    },
    enrich({ sessionId, agentType }, { transcriptPath, resultPreview }) {
      const hit = oldestMatchStmt.get(sessionId, agentType);
      if (!hit) return null;                      // ambiguous or absent: skip rather than guess
      enrichStmt.run(transcriptPath ?? null, resultPreview ?? null, hit.id);
      return hit.id;
    },
    get(id) { return toRun(getStmt.get(id)); },
    listActive() { return activeStmt.all().map(toRun); },
    listRecent(limit = 100) { return recentStmt.all(limit).map(toRun); },
    markStaleBefore(cutoffTs, now) { staleStmt.run(now, cutoffTs); },
    endSessionRuns(sessionId, now) { endSessionStmt.run(now, sessionId); },
    pruneBefore(ts) { pruneStmt.run(ts); },
  };
}
```

- [ ] **Step 5: Implement `sessions.js`**

```js
// src/store/sessions.js
const toSession = (r) => r == null ? null : ({
  id: r.id, projectPath: r.project_path, source: r.source,
  status: r.status, startedAt: r.started_at, lastEventAt: r.last_event_at,
});

export function createSessionsRepo(db) {
  const upsert = db.prepare(`INSERT INTO sessions (id, project_path, source, status, started_at, last_event_at)
    VALUES (?, ?, ?, 'active', ?, ?)
    ON CONFLICT(id) DO UPDATE SET last_event_at = excluded.last_event_at,
                                  project_path  = COALESCE(excluded.project_path, sessions.project_path)`);
  const endStmt = db.prepare("UPDATE sessions SET status = 'ended', last_event_at = ? WHERE id = ?");
  const getStmt = db.prepare('SELECT * FROM sessions WHERE id = ?');
  const listStmt = db.prepare('SELECT * FROM sessions ORDER BY last_event_at DESC');

  return {
    touch({ id, projectPath, source = 'terminal', at }) {
      upsert.run(id, projectPath ?? null, source, at, at);
    },
    end(id, at) { endStmt.run(at, id); },
    get(id) { return toSession(getStmt.get(id)); },
    list() { return listStmt.all().map(toSession); },
  };
}
```

- [ ] **Step 6: Run tests, confirm green, commit**

```bash
npm test
git add src/store test/store
git commit -m "feat: add sqlite store for sessions and agent runs"
```

---
## Task 8: Hook event correlator

A pure function: hook event in, list of actions out. No I/O, no clock reads, no database. This is the piece
most likely to be wrong, so it must be the easiest to test.

**Files:**
- Create: `src/core/correlator.js`
- Test: `test/core/correlator.test.js`

**Interfaces:**
- Consumes: `preview` from Task 6.
- Produces: `AGENT_TOOL_NAMES` (a `Set` of `'Agent'` and `'Task'`), `isAgentDispatch(toolName) => boolean`,
  `runId(sessionId, toolUseId) => string`, `extractText(toolResponse) => string`,
  `isErrorResponse(toolResponse) => boolean`, `planActions(event, { now }) => Action[]`.
- Action union — later tasks switch on `type`:
  - `{ type: 'session.touch', session: { id, projectPath, source, at } }`
  - `{ type: 'session.end', sessionId, at }`
  - `{ type: 'run.open', run: { id, sessionId, agentType, description, prompt, startedAt } }`
  - `{ type: 'run.close', close: { id, status, endedAt, durationMs, resultPreview } }`
  - `{ type: 'run.enrich', match: { sessionId, agentType }, patch: { transcriptPath, resultPreview } }`

- [ ] **Step 1: Write the failing test**

```js
// test/core/correlator.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planActions, runId, isErrorResponse, extractText, isAgentDispatch } from '../../src/core/correlator.js';

const NOW = 1_700_000_000_000;
const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/hooks/${name}.json`, import.meta.url)));

const pre = {
  hook_event_name: 'PreToolUse', session_id: 's1', cwd: '/proj', transcript_path: '/t.jsonl',
  tool_name: 'Agent', tool_use_id: 'tu_1',
  tool_input: { subagent_type: 'programmer', description: 'add auth', prompt: 'do the thing' },
};

test('every event touches its session', () => {
  const [a] = planActions({ hook_event_name: 'Notification', session_id: 's1', cwd: '/proj' }, { now: NOW });
  assert.deepEqual(a, { type: 'session.touch', session: { id: 's1', projectPath: '/proj', source: 'terminal', at: NOW } });
});

test('the dispatch tool is recognised under both of its names', () => {
  assert.equal(isAgentDispatch('Agent'), true);
  assert.equal(isAgentDispatch('Task'), true);
  assert.equal(isAgentDispatch('Bash'), false);
  assert.equal(isAgentDispatch(undefined), false);
});

test('a Task-named dispatch still opens a run', () => {
  const actions = planActions({ ...pre, tool_name: 'Task' }, { now: NOW });
  assert.equal(actions.some((a) => a.type === 'run.open'), true);
});

test('PreToolUse[Agent] opens a run keyed by session and tool_use_id', () => {
  const actions = planActions(pre, { now: NOW });
  const open = actions.find((a) => a.type === 'run.open');
  assert.deepEqual(open.run, {
    id: 's1:tu_1', sessionId: 's1', agentType: 'programmer',
    description: 'add auth', prompt: 'do the thing', startedAt: NOW,
  });
});

test('PreToolUse for a non-dispatch tool opens nothing', () => {
  const actions = planActions({ ...pre, tool_name: 'Bash', tool_input: { command: 'ls' } }, { now: NOW });
  assert.equal(actions.some((a) => a.type === 'run.open'), false);
});

test('PostToolUse[Agent] closes the same id', () => {
  const evt = { ...pre, hook_event_name: 'PostToolUse', tool_response: 'all good', duration_ms: 4321 };
  const close = planActions(evt, { now: NOW }).find((a) => a.type === 'run.close');
  assert.deepEqual(close.close, {
    id: 's1:tu_1', status: 'done', endedAt: NOW, durationMs: 4321, resultPreview: 'all good',
  });
});

test('an error tool_response closes the run as error', () => {
  const evt = { ...pre, hook_event_name: 'PostToolUse', tool_response: { is_error: true, content: 'boom' } };
  const close = planActions(evt, { now: NOW }).find((a) => a.type === 'run.close');
  assert.equal(close.close.status, 'error');
});

test('a string response starting with Error is also an error', () => {
  assert.equal(isErrorResponse('Error: exceeded'), true);
  assert.equal(isErrorResponse('errors were fixed'), false);
});

test('extractText understands the content-block response shape', () => {
  assert.equal(extractText({ content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }] }), 'hello\nworld');
  assert.equal(extractText('plain'), 'plain');
  assert.equal(extractText(undefined), '');
});

test('result previews are redacted and capped', () => {
  const evt = { ...pre, hook_event_name: 'PostToolUse', tool_response: `token ghp_${'a'.repeat(36)}` };
  const close = planActions(evt, { now: NOW }).find((a) => a.type === 'run.close');
  assert.ok(!close.close.resultPreview.includes('ghp_'));
});

test('SubagentStop produces a heuristic enrich, never an open or close', () => {
  const evt = {
    hook_event_name: 'SubagentStop', session_id: 's1', cwd: '/proj',
    agent_id: 'ag_9', agent_type: 'programmer', agent_transcript_path: '/agent.jsonl',
    last_assistant_message: 'finished', stop_hook_active: false,
  };
  const actions = planActions(evt, { now: NOW });
  assert.equal(actions.some((a) => a.type === 'run.open' || a.type === 'run.close'), false);
  const enrich = actions.find((a) => a.type === 'run.enrich');
  assert.deepEqual(enrich.match, { sessionId: 's1', agentType: 'programmer' });
  assert.equal(enrich.patch.transcriptPath, '/agent.jsonl');
});

test('SubagentStop without an agent_type enriches nothing', () => {
  const evt = { hook_event_name: 'SubagentStop', session_id: 's1', cwd: '/p', agent_id: 'ag_9', agent_transcript_path: '/a' };
  assert.equal(planActions(evt, { now: NOW }).some((a) => a.type === 'run.enrich'), false);
});

test('SessionEnd ends the session', () => {
  const actions = planActions({ hook_event_name: 'SessionEnd', session_id: 's1', cwd: '/p' }, { now: NOW });
  assert.deepEqual(actions.at(-1), { type: 'session.end', sessionId: 's1', at: NOW });
});

test('an event without a session_id yields no actions', () => {
  assert.deepEqual(planActions({ hook_event_name: 'PreToolUse' }, { now: NOW }), []);
  assert.deepEqual(planActions(null, { now: NOW }), []);
});

test('real captured fixtures produce the expected action types', () => {
  assert.ok(planActions(fixture('pre-tool-use-task'), { now: NOW }).some((a) => a.type === 'run.open'));
  assert.ok(planActions(fixture('post-tool-use-task'), { now: NOW }).some((a) => a.type === 'run.close'));
});

test('the fixture pair correlates to one id', () => {
  const open = planActions(fixture('pre-tool-use-task'), { now: NOW }).find((a) => a.type === 'run.open');
  const close = planActions(fixture('post-tool-use-task'), { now: NOW }).find((a) => a.type === 'run.close');
  assert.equal(open.run.id, close.close.id);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// src/core/correlator.js
import { preview } from './redact.js';

// The subagent-dispatch tool is `Agent` on CLI 2.1.234 and `Task` on other builds; `toolAliases`
// can also rename it. Recognise the whole set rather than one build's spelling.
export const AGENT_TOOL_NAMES = new Set(['Agent', 'Task']);

export function isAgentDispatch(toolName) { return AGENT_TOOL_NAMES.has(toolName); }

export function runId(sessionId, toolUseId) { return `${sessionId}:${toolUseId}`; }

export function extractText(toolResponse) {
  if (toolResponse == null) return '';
  if (typeof toolResponse === 'string') return toolResponse;
  const { content } = toolResponse;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
  }
  return JSON.stringify(toolResponse);
}

export function isErrorResponse(toolResponse) {
  if (toolResponse == null) return false;
  if (typeof toolResponse === 'object' && toolResponse.is_error === true) return true;
  return /^Error\b/.test(extractText(toolResponse));
}

export function planActions(event, { now }) {
  if (!event || typeof event.session_id !== 'string') return [];

  const actions = [{
    type: 'session.touch',
    session: { id: event.session_id, projectPath: event.cwd ?? null, source: 'terminal', at: now },
  }];

  const input = event.tool_input ?? {};

  switch (event.hook_event_name) {
    case 'PreToolUse':
      if (isAgentDispatch(event.tool_name) && event.tool_use_id) {
        actions.push({
          type: 'run.open',
          run: {
            id: runId(event.session_id, event.tool_use_id),
            sessionId: event.session_id,
            agentType: input.subagent_type ?? null,
            description: input.description ?? null,
            prompt: preview(input.prompt, 2000),
            startedAt: now,
          },
        });
      }
      break;

    case 'PostToolUse':
      if (isAgentDispatch(event.tool_name) && event.tool_use_id) {
        actions.push({
          type: 'run.close',
          close: {
            id: runId(event.session_id, event.tool_use_id),
            status: isErrorResponse(event.tool_response) ? 'error' : 'done',
            endedAt: now,
            durationMs: event.duration_ms ?? null,
            resultPreview: preview(extractText(event.tool_response)),
          },
        });
      }
      break;

    // Heuristic only: SubagentStop shares no join key with the Task events, so it matches the oldest
    // open run with the same (session_id, agent_type) and is skipped when that is not determinable.
    case 'SubagentStop':
      if (event.agent_type) {
        actions.push({
          type: 'run.enrich',
          match: { sessionId: event.session_id, agentType: event.agent_type },
          patch: {
            transcriptPath: event.agent_transcript_path ?? null,
            resultPreview: event.last_assistant_message ? preview(event.last_assistant_message) : null,
          },
        });
      }
      break;

    case 'SessionEnd':
      actions.push({ type: 'session.end', sessionId: event.session_id, at: now });
      break;

    default:
      break;   // every other event contributes only the session touch
  }

  return actions;
}
```

- [ ] **Step 4: Run tests, confirm green, commit**

```bash
npm test
git add src/core/correlator.js test/core/correlator.test.js
git commit -m "feat: add pure hook event correlator"
```

---

## Task 9: Hook ingest route and stale sweeper

**Files:**
- Create: `src/daemon/routes/hooks.js` (exports both `hooksRoute` and `runsRoute`), `src/core/sweeper.js`
- Test: `test/daemon/hooks-route.test.js`

**Interfaces:**
- Consumes: `planActions` (Task 8), repos (Task 7), `createHub` (Task 5).
- Produces:
  - `applyActions(actions, { runs, sessions, hub }) => void` — applies each action and broadcasts
    `run.open` / `run.close` / `run.enrich` / `session.end` over SSE with the resulting row as payload.
  - `hooksRoute({ runs, sessions, hub, now }) => Route` — `POST /api/hooks`, `stateChanging: true`.
    Body cap 256 KB; malformed JSON answers `400 { error: 'bad_json' }`; a valid but unhandled event answers
    `200 { ok: true, actions: 0 }`.
  - `runsRoute({ runs }) => Route` — `GET /api/runs` returning `{ active, recent }`.
  - `startSweeper({ runs, hub, staleAfterMs = 1_800_000, retentionMs = 604_800_000, intervalMs = 60_000, now })
    => stop()` — an `unref()`ed interval so it never keeps the process alive.

- [ ] **Step 1: Write the failing test**

```js
// test/daemon/hooks-route.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/store/db.js';
import { createRunsRepo } from '../../src/store/runs.js';
import { createSessionsRepo } from '../../src/store/sessions.js';
import { createHub } from '../../src/daemon/sse.js';
import { createServer } from '../../src/daemon/server.js';
import { hooksRoute, runsRoute } from '../../src/daemon/routes/hooks.js';
import { startSweeper } from '../../src/core/sweeper.js';

const TOKEN = 'd'.repeat(64);
let clock = 1_000_000;
const now = () => clock;

async function boot() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'ap-h-')), 'data.db'));
  const runs = createRunsRepo(db);
  const sessions = createSessionsRepo(db);
  const hub = createHub();
  const events = [];
  hub.add({ write: (c) => events.push(c), end() {}, on() {}, writeHead() {}, flushHeaders() {} });
  const server = createServer({ token: TOKEN, port: 0, hub,
    routes: [hooksRoute({ runs, sessions, hub, now }), runsRoute({ runs })] });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(`${base}/api/hooks`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { server, runs, sessions, post, base, events };
}

const pre = {
  hook_event_name: 'PreToolUse', session_id: 's1', cwd: '/proj',
  tool_name: 'Agent', tool_use_id: 'tu_1',
  tool_input: { subagent_type: 'qa', description: 'write tests', prompt: 'p' },
};

test('a PreToolUse[Agent] post creates a running row and broadcasts it', async () => {
  const { server, runs, post, events } = await boot();
  const res = await post(pre);
  assert.equal(res.status, 200);
  assert.equal(runs.listActive().length, 1);
  assert.match(events.join(''), /event: run\.open/);
  server.close();
});

test('the matching PostToolUse closes it', async () => {
  const { server, runs, post } = await boot();
  await post(pre);
  clock += 5000;
  await post({ ...pre, hook_event_name: 'PostToolUse', tool_response: 'done' });
  assert.equal(runs.listActive().length, 0);
  assert.equal(runs.get('s1:tu_1').status, 'done');
  server.close();
});

test('malformed json is rejected without touching the store', async () => {
  const { server, runs, post } = await boot();
  const res = await post('{not json');
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'bad_json' });
  assert.equal(runs.listRecent().length, 0);
  server.close();
});

test('an oversized body is rejected', async () => {
  const { server, post } = await boot();
  const res = await post({ ...pre, tool_input: { ...pre.tool_input, prompt: 'x'.repeat(300_000) } });
  assert.equal(res.status, 413);
  server.close();
});

test('an unknown event is accepted but changes no runs', async () => {
  const { server, runs, post } = await boot();
  const res = await post({ hook_event_name: 'Notification', session_id: 's9', cwd: '/p' });
  assert.equal(res.status, 200);
  assert.equal(runs.listRecent().length, 0);
  server.close();
});

test('the ingest route requires a token', async () => {
  const { server, base } = await boot();
  const res = await fetch(`${base}/api/hooks`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 401);
  server.close();
});

test('SessionEnd stales that session\'s open runs', async () => {
  const { server, runs, post } = await boot();
  await post(pre);
  await post({ hook_event_name: 'SessionEnd', session_id: 's1', cwd: '/proj' });
  assert.equal(runs.get('s1:tu_1').status, 'stale');
  server.close();
});

test('GET /api/runs returns active and recent', async () => {
  const { server, post, base } = await boot();
  await post(pre);
  const res = await fetch(`${base}/api/runs`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const body = await res.json();
  assert.equal(body.active.length, 1);
  assert.equal(body.active[0].agentType, 'qa');
  server.close();
});

test('the sweeper stales an abandoned run and broadcasts it', async () => {
  const { server, runs, post, events } = await boot();
  await post(pre);
  clock += 31 * 60 * 1000;
  const stop = startSweeper({ runs, hub: { broadcast: (e, d) => events.push(`event: ${e}\n`) }, now, intervalMs: 10 });
  await new Promise((r) => setTimeout(r, 40));
  stop();
  assert.equal(runs.get('s1:tu_1').status, 'stale');
  server.close();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the routes**

```js
// src/daemon/routes/hooks.js
import { planActions } from '../../core/correlator.js';

const MAX_BODY = 256 * 1024;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('too_large'), { code: 'TOO_LARGE' })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function applyActions(actions, { runs, sessions, hub }) {
  for (const action of actions) {
    switch (action.type) {
      case 'session.touch':
        sessions.touch(action.session);
        break;
      case 'session.end':
        sessions.end(action.sessionId, action.at);
        runs.endSessionRuns(action.sessionId, action.at);
        hub.broadcast('session.end', { sessionId: action.sessionId });
        break;
      case 'run.open':
        runs.open(action.run);
        hub.broadcast('run.open', runs.get(action.run.id));
        break;
      case 'run.close':
        if (runs.close(action.close)) hub.broadcast('run.close', runs.get(action.close.id));
        break;
      case 'run.enrich': {
        const id = runs.enrich(action.match, action.patch);
        if (id) hub.broadcast('run.enrich', runs.get(id));
        break;
      }
      default:
        break;
    }
  }
}

export function hooksRoute({ runs, sessions, hub, now = Date.now }) {
  return {
    method: 'POST',
    path: '/api/hooks',
    stateChanging: true,
    handler: async (req, res) => {
      let raw;
      try { raw = await readBody(req); }
      catch (err) { return json(res, err.code === 'TOO_LARGE' ? 413 : 400, { error: 'bad_body' }); }

      let event;
      try { event = JSON.parse(raw); }
      catch { return json(res, 400, { error: 'bad_json' }); }

      const actions = planActions(event, { now: now() });
      applyActions(actions, { runs, sessions, hub });
      json(res, 200, { ok: true, actions: actions.length });
    },
  };
}

export function runsRoute({ runs }) {
  return {
    method: 'GET',
    path: '/api/runs',
    handler: (_req, res) => json(res, 200, { active: runs.listActive(), recent: runs.listRecent(200) }),
  };
}
```

- [ ] **Step 4: Implement the sweeper**

```js
// src/core/sweeper.js
export function startSweeper({
  runs, hub,
  staleAfterMs = 30 * 60 * 1000,
  retentionMs = 7 * 24 * 60 * 60 * 1000,
  intervalMs = 60 * 1000,
  now = Date.now,
}) {
  const tick = () => {
    const t = now();
    const before = new Set(runs.listActive().map((r) => r.id));
    runs.markStaleBefore(t - staleAfterMs, t);
    runs.pruneBefore(t - retentionMs);
    for (const id of before) {
      const row = runs.get(id);
      if (row && row.status === 'stale') hub.broadcast('run.close', row);
    }
  };

  tick();
  const handle = setInterval(tick, intervalMs);
  handle.unref?.();
  return () => clearInterval(handle);
}
```

- [ ] **Step 5: Run tests, confirm green, commit**

```bash
npm test
git add src/daemon/routes/hooks.js src/core/sweeper.js test/daemon/hooks-route.test.js
git commit -m "feat: ingest hook events into runs and broadcast over SSE"
```

---
## Task 10: Hook scripts

Two shell scripts. Both always exit 0 and print nothing on stdout. Printing matters more than it looks:
for `SessionStart`, Claude Code injects a hook's plain-text stdout into the model's context, so a chatty
script would silently pollute every session.

**Files:**
- Create: `hooks/agentpanel-hook.sh`, `hooks/agentpanel-bootstrap.sh`
- Test: `test/hooks/scripts.test.js`

**Interfaces:**
- Produces: two executable scripts. `agentpanel-hook.sh` reads a payload on stdin and POSTs it verbatim to
  `/api/hooks`. `agentpanel-bootstrap.sh` starts the daemon if no live one is recorded, then exits.
- Both read `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/agentpanel/daemon.json` for the port, token, and pid.

- [ ] **Step 1: Write the failing test**

```js
// test/hooks/scripts.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('../../hooks/agentpanel-hook.sh', import.meta.url));

function run(script, { stdin = '', env = {} }) {
  return new Promise((resolve) => {
    const child = execFile('bash', [script], { env: { ...process.env, ...env } },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

function fakeConfigDir({ port, token, pid = process.pid }) {
  const dir = mkdtempSync(join(tmpdir(), 'ap-cfg-'));
  mkdirSync(join(dir, 'agentpanel'), { recursive: true });
  if (port) {
    writeFileSync(join(dir, 'agentpanel', 'daemon.json'),
      JSON.stringify({ pid, port, token, startedAt: 1, version: '0.1.0' }));
  }
  return dir;
}

test('forwards the payload verbatim with the bearer token', async () => {
  const received = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { received.push({ body, auth: req.headers.authorization, url: req.url }); res.end('{}'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const cfg = fakeConfigDir({ port, token: 'e'.repeat(64) });
  const payload = '{"hook_event_name":"PreToolUse","session_id":"s1"}';

  const out = await run(HOOK, { stdin: payload, env: { CLAUDE_CONFIG_DIR: cfg } });

  assert.equal(out.code, 0);
  assert.equal(out.stdout, '', 'stdout must stay empty — SessionStart stdout is injected into context');
  assert.equal(received.length, 1);
  assert.equal(received[0].body, payload);
  assert.equal(received[0].url, '/api/hooks');
  assert.equal(received[0].auth, `Bearer ${'e'.repeat(64)}`);
  server.close();
});

test('exits 0 and stays silent when no daemon.json exists', async () => {
  const cfg = fakeConfigDir({});
  const out = await run(HOOK, { stdin: '{"a":1}', env: { CLAUDE_CONFIG_DIR: cfg } });
  assert.equal(out.code, 0);
  assert.equal(out.stdout, '');
});

test('exits 0 when the recorded port refuses the connection', async () => {
  const cfg = fakeConfigDir({ port: 9, token: 'f'.repeat(64) });   // discard port, nothing listening
  const out = await run(HOOK, { stdin: '{"a":1}', env: { CLAUDE_CONFIG_DIR: cfg } });
  assert.equal(out.code, 0);
  assert.equal(out.stdout, '');
});

test('exits 0 on a corrupt daemon.json', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ap-cfg-'));
  mkdirSync(join(dir, 'agentpanel'), { recursive: true });
  writeFileSync(join(dir, 'agentpanel', 'daemon.json'), 'not json at all');
  const out = await run(HOOK, { stdin: '{"a":1}', env: { CLAUDE_CONFIG_DIR: dir } });
  assert.equal(out.code, 0);
  assert.equal(out.stdout, '');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test`
Expected: FAIL — `hooks/agentpanel-hook.sh` does not exist.

- [ ] **Step 3: Write the forwarding script**

```bash
#!/usr/bin/env bash
# Forwards one Claude Code hook payload to the agentpanel daemon.
# Contract: always exit 0, never write to stdout. Claude Code injects SessionStart
# stdout into the model's context, and a non-zero exit shows a hook error in the transcript.
set -u

runtime="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/agentpanel/daemon.json"
[ -r "$runtime" ] || exit 0

payload="$(cat)"
[ -n "$payload" ] || exit 0

port="$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$runtime" | head -1)"
token="$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([0-9a-f]*\)".*/\1/p' "$runtime" | head -1)"
[ -n "$port" ] && [ -n "$token" ] || exit 0

printf '%s' "$payload" | curl -sS -o /dev/null --max-time 1 \
  -X POST "http://127.0.0.1:${port}/api/hooks" \
  -H "Authorization: Bearer ${token}" \
  -H "Content-Type: application/json" \
  --data-binary @- >/dev/null 2>&1

exit 0
```

- [ ] **Step 4: Write the bootstrap script**

```bash
#!/usr/bin/env bash
# SessionStart: start the agentpanel daemon if it is not already running, then get out of the way.
# Contract: always exit 0, never write to stdout.
set -u

claude_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
runtime="${claude_dir}/agentpanel/daemon.json"

cat >/dev/null   # drain stdin so Claude Code never blocks writing the payload

if [ -r "$runtime" ]; then
  pid="$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$runtime" | head -1)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then exit 0; fi
fi

entry="$(cd "$(dirname "$0")/.." && pwd)/bin/agentpanel.js"
[ -f "$entry" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0

mkdir -p "${claude_dir}/agentpanel"
nohup node --disable-warning=ExperimentalWarning "$entry" start --detached \
  >>"${claude_dir}/agentpanel/daemon.log" 2>&1 &

exit 0
```

- [ ] **Step 5: Make them executable, run tests, commit**

```bash
chmod +x hooks/agentpanel-hook.sh hooks/agentpanel-bootstrap.sh
npm test
git add hooks test/hooks
git commit -m "feat: add fail-open hook forwarding and bootstrap scripts"
```

---

## Task 11: `init` and `uninstall`

Writes to the user's `~/.claude/settings.json`. Print the plan, then write — never the other way round.

**Files:**
- Create: `src/cli/hook-config.js`, `src/cli/init.js`, `src/cli/uninstall.js`
- Test: `test/cli/init.test.js`

**Interfaces:**
- Produces:
  - `OUR_MARKER = 'agentpanel'` and `hookEntries(hooksDir) => object` — the `hooks` fragment to merge.
  - `isOurs(entry) => boolean` — true when a handler's `command` references one of our scripts.
  - `mergeHooks(existing, hooksDir) => { hooks, added, removed }` — pure; strips our old entries, appends fresh
    ones, leaves every foreign entry untouched.
  - `runInit({ settingsPath, hooksDir, write, log })` and `runUninstall({ settingsPath, stateDir, write, log })`.
- Hook registration produced by `hookEntries`, with the verified semantics: `matcher: 'Agent|Task'` takes
  Claude Code's exact-string-list path (letters and `|` only), so it matches both spellings of the dispatch
  tool and nothing else; `async: true` runs the handler without blocking; `timeout` is in **seconds**.
  `SessionEnd` gets `timeout: 2` because those hooks share a 1.5-second budget and a per-hook timeout is what
  raises it.

- [ ] **Step 1: Write the failing test**

```js
// test/cli/init.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeHooks, hookEntries, isOurs } from '../../src/cli/hook-config.js';

const DIR = '/opt/agentpanel/hooks';
const foreign = {
  PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/other/tool.sh' }] }],
};

test('registers all five events', () => {
  const h = hookEntries(DIR);
  assert.deepEqual(Object.keys(h).sort(),
    ['PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'SubagentStop']);
});

test('dispatch events match both tool names via the exact-string list matcher', () => {
  const h = hookEntries(DIR);
  assert.equal(h.PreToolUse[0].matcher, 'Agent|Task');
  assert.equal(h.PostToolUse[0].matcher, 'Agent|Task');
});

test('every handler is async and short-timeout, and SessionEnd fits its 1.5s budget', () => {
  const h = hookEntries(DIR);
  const all = Object.values(h).flatMap((g) => g.flatMap((m) => m.hooks));
  assert.ok(all.every((x) => x.async === true), 'async keeps sessions unblocked');
  assert.ok(all.every((x) => x.timeout <= 5 && x.timeout >= 2));
  assert.equal(h.SessionEnd[0].hooks[0].timeout, 2);
});

test('merge preserves foreign hooks on the same event', () => {
  const { hooks } = mergeHooks(foreign, DIR);
  const commands = hooks.PreToolUse.flatMap((m) => m.hooks.map((h) => h.command));
  assert.ok(commands.some((c) => c.includes('/other/tool.sh')), 'foreign handler survived');
  assert.ok(commands.some((c) => c.includes('agentpanel-hook.sh')), 'ours was added');
});

test('merge is idempotent — running init twice yields one copy', () => {
  const once = mergeHooks(foreign, DIR).hooks;
  const twice = mergeHooks(once, DIR).hooks;
  const mine = twice.PreToolUse.flatMap((m) => m.hooks).filter(isOurs);
  assert.equal(mine.length, 1);
  assert.deepEqual(once, twice);
});

test('re-running after a path change replaces the stale entry rather than stacking', () => {
  const old = mergeHooks({}, '/old/path/hooks').hooks;
  const fresh = mergeHooks(old, DIR).hooks;
  const commands = fresh.SubagentStop.flatMap((m) => m.hooks.map((h) => h.command));
  assert.equal(commands.length, 1);
  assert.ok(commands[0].includes(DIR));
});

test('merge reports what it added and removed', () => {
  const result = mergeHooks({}, DIR);
  assert.equal(result.added.length, 5);
  assert.equal(result.removed.length, 0);
  assert.equal(mergeHooks(result.hooks, DIR).removed.length, 5);
});

test('an event group left with no handlers is deleted, not left empty', () => {
  const ours = mergeHooks({}, DIR).hooks;
  const { hooks } = mergeHooks(ours, DIR, { remove: true });
  assert.equal(hooks.SubagentStop, undefined);
});

test('isOurs recognises our scripts and nothing else', () => {
  assert.equal(isOurs({ command: '"/x/hooks/agentpanel-hook.sh"' }), true);
  assert.equal(isOurs({ command: '/x/hooks/agentpanel-bootstrap.sh' }), true);
  assert.equal(isOurs({ command: '/x/other.sh' }), false);
  assert.equal(isOurs({}), false);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `hook-config.js`**

```js
// src/cli/hook-config.js
import { join } from 'node:path';

export const OUR_SCRIPTS = ['agentpanel-hook.sh', 'agentpanel-bootstrap.sh'];

export function isOurs(handler) {
  const cmd = handler?.command;
  return typeof cmd === 'string' && OUR_SCRIPTS.some((name) => cmd.includes(name));
}

const handler = (hooksDir, script, timeout) => ({
  type: 'command',
  command: `"${join(hooksDir, script)}"`,
  async: true,
  timeout,
});

export function hookEntries(hooksDir) {
  const forward = (timeout = 5) => handler(hooksDir, 'agentpanel-hook.sh', timeout);
  return {
    // No matcher: SessionStart matchers filter on `source` (startup|resume|clear|compact|fork)
    // and agentpanel wants the daemon up for all of them.
    SessionStart: [{ hooks: [handler(hooksDir, 'agentpanel-bootstrap.sh', 5), forward()] }],
    // `Agent|Task` contains only letters and `|`, so Claude Code takes the exact-string-list path,
    // not the regex path: it matches the tool named exactly `Agent` or exactly `Task`, nothing else.
    PreToolUse:   [{ matcher: 'Agent|Task', hooks: [forward()] }],
    PostToolUse:  [{ matcher: 'Agent|Task', hooks: [forward()] }],
    SubagentStop: [{ hooks: [forward()] }],
    // SessionEnd hooks share a 1.5s budget; a per-hook timeout raises it, so keep it tight.
    SessionEnd:   [{ hooks: [forward(2)] }],
  };
}

export function mergeHooks(existing = {}, hooksDir, { remove = false } = {}) {
  const fresh = hookEntries(hooksDir);
  const hooks = structuredClone(existing ?? {});
  const added = [];
  const removed = [];

  for (const event of new Set([...Object.keys(hooks), ...Object.keys(fresh)])) {
    const groups = (hooks[event] ?? [])
      .map((group) => {
        const kept = (group.hooks ?? []).filter((h) => {
          if (isOurs(h)) { removed.push(`${event}: ${h.command}`); return false; }
          return true;
        });
        return { ...group, hooks: kept };
      })
      .filter((group) => group.hooks.length > 0);

    if (!remove && fresh[event]) {
      groups.push(...structuredClone(fresh[event]));
      added.push(event);
    }

    if (groups.length > 0) hooks[event] = groups;
    else delete hooks[event];
  }

  return { hooks, added, removed };
}
```

- [ ] **Step 4: Implement `init.js` and `uninstall.js`**

```js
// src/cli/init.js
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { mergeHooks } from './hook-config.js';

export function runInit({ settingsPath, hooksDir, assumeYes = false, log = console.log, confirm }) {
  const existing = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
  const { hooks, added, removed } = mergeHooks(existing.hooks ?? {}, hooksDir);

  log(`agentpanel init will modify: ${settingsPath}`);
  for (const event of added) log(`  + ${event} -> agentpanel hook`);
  for (const gone of removed) log(`  - replacing stale entry ${gone}`);
  log('No other key in that file is touched.');

  if (!assumeYes && confirm && !confirm()) { log('Aborted. Nothing was written.'); return { written: false }; }

  if (existsSync(settingsPath)) copyFileSync(settingsPath, `${settingsPath}.agentpanel-backup`);
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify({ ...existing, hooks }, null, 2)}\n`);

  log('Done. Hooks take effect in sessions started from now on.');
  log('Note: Claude Code withholds hooks in a directory you have not trusted yet — accept the workspace');
  log('trust prompt there, or agentpanel will not see that session.');
  return { written: true };
}
```

```js
// src/cli/uninstall.js
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { mergeHooks } from './hook-config.js';

export function runUninstall({ settingsPath, stateDir, log = console.log }) {
  if (existsSync(settingsPath)) {
    const existing = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const { hooks, removed } = mergeHooks(existing.hooks ?? {}, '', { remove: true });
    writeFileSync(settingsPath, `${JSON.stringify({ ...existing, hooks }, null, 2)}\n`);
    for (const gone of removed) log(`  - removed ${gone}`);
  }
  rmSync(stateDir, { recursive: true, force: true });
  log(`  - removed ${stateDir} (database, logs, runtime file)`);
  log('agentpanel is fully removed. Stop any running daemon with: agentpanel stop');
}
```

- [ ] **Step 5: Run tests, confirm green, commit**

```bash
npm test
git add src/cli test/cli
git commit -m "feat: add idempotent hook installation and removal"
```

---
## Task 12: Frontmatter parser

Agent and skill files start with a YAML frontmatter block. We need a parser for the subset those files
actually use — not a YAML implementation, which would mean a runtime dependency.

**Files:**
- Create: `src/core/frontmatter.js`
- Test: `test/core/frontmatter.test.js`

**Interfaces:**
- Produces: `parseFrontmatter(text) => { data: object, body: string }`. Supported: `key: value`,
  quoted values, inline arrays `[a, b]`, block arrays (`- item` lines), and `true`/`false`/numbers.
  Unsupported constructs are kept as raw strings rather than throwing. Missing frontmatter yields
  `{ data: {}, body: text }`.

- [ ] **Step 1: Write the failing test**

```js
// test/core/frontmatter.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter } from '../../src/core/frontmatter.js';

test('parses a typical agent header', () => {
  const { data, body } = parseFrontmatter([
    '---',
    'name: reviewer',
    'description: Reviews a diff and reports defects. Read-only.',
    'tools: Read, Grep, Bash',
    'model: opus',
    '---',
    '',
    'You are a reviewer.',
  ].join('\n'));
  assert.equal(data.name, 'reviewer');
  assert.match(data.description, /^Reviews a diff/);
  assert.equal(data.tools, 'Read, Grep, Bash');
  assert.equal(body.trim(), 'You are a reviewer.');
});

test('parses inline arrays', () => {
  const { data } = parseFrontmatter('---\ntools: [Read, Write, Bash]\n---\n');
  assert.deepEqual(data.tools, ['Read', 'Write', 'Bash']);
});

test('parses block arrays', () => {
  const { data } = parseFrontmatter('---\ntools:\n  - Read\n  - Write\n---\n');
  assert.deepEqual(data.tools, ['Read', 'Write']);
});

test('strips matching quotes and keeps inner colons', () => {
  const { data } = parseFrontmatter('---\ndescription: "Use when: X happens"\n---\n');
  assert.equal(data.description, 'Use when: X happens');
});

test('parses booleans and numbers', () => {
  const { data } = parseFrontmatter('---\nenabled: true\nweight: 3\nname: 007\n---\n');
  assert.equal(data.enabled, true);
  assert.equal(data.weight, 3);
  assert.equal(data.name, '007', 'a quoted-looking id stays a string when it has a leading zero');
});

test('returns an empty object when there is no frontmatter', () => {
  const { data, body } = parseFrontmatter('# Just a heading\n');
  assert.deepEqual(data, {});
  assert.equal(body, '# Just a heading\n');
});

test('tolerates an unterminated block instead of throwing', () => {
  const { data } = parseFrontmatter('---\nname: broken\nno end marker');
  assert.deepEqual(data, {});
});

test('ignores comment lines and blank lines', () => {
  const { data } = parseFrontmatter('---\n# a comment\n\nname: x\n---\n');
  assert.deepEqual(data, { name: 'x' });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// src/core/frontmatter.js
function coerce(raw) {
  const v = raw.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v) && !/^0\d/.test(v)) return Number(v);
  if (/^\[.*\]$/.test(v)) {
    return v.slice(1, -1).split(',').map((s) => unquote(s.trim())).filter((s) => s.length > 0);
  }
  return unquote(v);
}

function unquote(v) {
  if ((v.startsWith('"') && v.endsWith('"') && v.length > 1)
   || (v.startsWith("'") && v.endsWith("'") && v.length > 1)) return v.slice(1, -1);
  return v;
}

export function parseFrontmatter(text) {
  const src = String(text ?? '');
  if (!src.startsWith('---')) return { data: {}, body: src };

  const end = src.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: src };

  const block = src.slice(src.indexOf('\n') + 1, end);
  const body = src.slice(src.indexOf('\n', end + 1) + 1);
  const data = {};
  let listKey = null;

  for (const line of block.split('\n')) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;

    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) { data[listKey].push(unquote(item[1].trim())); continue; }

    const pair = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (!pair) continue;

    const [, key, rest] = pair;
    if (rest.trim() === '') { data[key] = []; listKey = key; }
    else { data[key] = coerce(rest); listKey = null; }
  }

  for (const [k, v] of Object.entries(data)) if (Array.isArray(v) && v.length === 0) delete data[k];
  return { data, body };
}
```

- [ ] **Step 4: Run tests, confirm green, commit**

```bash
npm test
git add src/core/frontmatter.js test/core/frontmatter.test.js
git commit -m "feat: parse the frontmatter subset used by agents and skills"
```

---

## Task 13: Catalog scanners and route

**Files:**
- Create: `src/catalog/agents.js`, `src/catalog/skills.js`, `src/catalog/index.js`, `src/daemon/routes/catalog.js`
- Test: `test/catalog/catalog.test.js`

**Interfaces:**
- Consumes: `parseFrontmatter` (Task 12), path helpers (Task 1).
- Produces:
  - `scanAgents({ claudeDir, projectRoot }) => Agent[]` where
    `Agent = { kind: 'agent', name, description, tools, model, scope: 'user'|'project'|'plugin', source, path }`.
    `source` is the plugin id for plugin scope, otherwise `null`. `name` falls back to the filename stem.
  - `scanSkills({ claudeDir, projectRoot }) => Skill[]` where
    `Skill = { kind: 'skill', name, description, scope, source, version, path }`.
  - `scanCatalog(opts) => { agents, skills, scannedAt }`
  - `createCatalog(opts) => { get(), refresh(), watch(onChange), close() }` — caches until `refresh()`, and
    `watch` debounces filesystem events by 250 ms.
  - `catalogRoute({ catalog }) => Route` — `GET /api/catalog`.
- Scanning never throws on an unreadable directory; it skips it. A dashboard that dies because one plugin
  shipped a malformed file is worse than one that shows the rest.

- [ ] **Step 1: Write the failing test**

```js
// test/catalog/catalog.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanAgents, scanSkills, scanCatalog } from '../../src/catalog/index.js';

function fixtureTree() {
  const claudeDir = mkdtempSync(join(tmpdir(), 'ap-cat-'));
  const projectRoot = mkdtempSync(join(tmpdir(), 'ap-proj-'));

  mkdirSync(join(claudeDir, 'agents'), { recursive: true });
  writeFileSync(join(claudeDir, 'agents', 'reviewer.md'),
    '---\nname: reviewer\ndescription: Reviews code.\ntools: Read, Grep\nmodel: opus\n---\nbody');
  writeFileSync(join(claudeDir, 'agents', 'nameless.md'), '---\ndescription: No name key.\n---\nbody');
  writeFileSync(join(claudeDir, 'agents', 'notes.txt'), 'ignored');

  mkdirSync(join(projectRoot, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(projectRoot, '.claude', 'agents', 'local-helper.md'),
    '---\nname: local-helper\ndescription: Project scoped.\n---\nbody');

  mkdirSync(join(claudeDir, 'skills', 'brainstorm'), { recursive: true });
  writeFileSync(join(claudeDir, 'skills', 'brainstorm', 'SKILL.md'),
    '---\nname: brainstorm\ndescription: Turns ideas into designs.\n---\nbody');

  const plug = join(claudeDir, 'plugins', 'cache', 'official', 'superpowers', '6.3.0');
  mkdirSync(join(plug, 'skills', 'tdd'), { recursive: true });
  writeFileSync(join(plug, 'skills', 'tdd', 'SKILL.md'),
    '---\nname: test-driven-development\ndescription: TDD workflow.\n---\nbody');
  mkdirSync(join(plug, 'agents'), { recursive: true });
  writeFileSync(join(plug, 'agents', 'plugin-agent.md'),
    '---\nname: plugin-agent\ndescription: From a plugin.\n---\nbody');

  return { claudeDir, projectRoot };
}

test('finds user, project, and plugin agents with correct scopes', () => {
  const agents = scanAgents(fixtureTree());
  const byName = Object.fromEntries(agents.map((a) => [a.name, a]));
  assert.equal(byName.reviewer.scope, 'user');
  assert.equal(byName['local-helper'].scope, 'project');
  assert.equal(byName['plugin-agent'].scope, 'plugin');
  assert.equal(byName['plugin-agent'].source, 'superpowers');
});

test('agent fields are carried through', () => {
  const a = scanAgents(fixtureTree()).find((x) => x.name === 'reviewer');
  assert.equal(a.description, 'Reviews code.');
  assert.equal(a.tools, 'Read, Grep');
  assert.equal(a.model, 'opus');
  assert.equal(a.kind, 'agent');
});

test('a missing name falls back to the filename stem', () => {
  assert.ok(scanAgents(fixtureTree()).some((a) => a.name === 'nameless'));
});

test('non-markdown files are ignored', () => {
  assert.equal(scanAgents(fixtureTree()).some((a) => a.path.endsWith('.txt')), false);
});

test('finds user and plugin skills, with the plugin version', () => {
  const skills = scanSkills(fixtureTree());
  const byName = Object.fromEntries(skills.map((s) => [s.name, s]));
  assert.equal(byName.brainstorm.scope, 'user');
  assert.equal(byName['test-driven-development'].scope, 'plugin');
  assert.equal(byName['test-driven-development'].source, 'superpowers');
  assert.equal(byName['test-driven-development'].version, '6.3.0');
});

test('missing directories yield empty results rather than throwing', () => {
  const out = scanCatalog({ claudeDir: '/nonexistent', projectRoot: '/also-nonexistent' });
  assert.deepEqual(out.agents, []);
  assert.deepEqual(out.skills, []);
});

test('an unreadable or malformed file is skipped, not fatal', () => {
  const tree = fixtureTree();
  writeFileSync(join(tree.claudeDir, 'agents', 'broken.md'), '---\nthis is not: [valid');
  assert.ok(scanAgents(tree).length >= 3);
});

test('results are sorted by name for a stable UI', () => {
  const names = scanAgents(fixtureTree()).map((a) => a.name);
  assert.deepEqual(names, [...names].sort());
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the scanners**

```js
// src/catalog/agents.js
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { parseFrontmatter } from '../core/frontmatter.js';

function listFiles(dir, ext) {
  try {
    return readdirSync(dir)
      .filter((f) => extname(f) === ext)
      .map((f) => join(dir, f))
      .filter((p) => { try { return statSync(p).isFile(); } catch { return false; } });
  } catch { return []; }
}

function readAgent(path, scope, source) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return null; }
  const { data } = parseFrontmatter(text);
  return {
    kind: 'agent',
    name: typeof data.name === 'string' && data.name ? data.name : basename(path, '.md'),
    description: typeof data.description === 'string' ? data.description : '',
    tools: data.tools ?? null,
    model: typeof data.model === 'string' ? data.model : null,
    scope, source, path,
  };
}

// Plugin layout: <claudeDir>/plugins/cache/<marketplace>/<plugin>/<version>/{agents,skills}
export function pluginRoots(claudeDir) {
  const base = join(claudeDir, 'plugins', 'cache');
  const roots = [];
  for (const marketplace of safeList(base)) {
    for (const plugin of safeList(join(base, marketplace))) {
      for (const version of safeList(join(base, marketplace, plugin))) {
        roots.push({ dir: join(base, marketplace, plugin, version), plugin, marketplace, version });
      }
    }
  }
  return roots;
}

function safeList(dir) {
  try { return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch { return []; }
}

export function scanAgents({ claudeDir, projectRoot }) {
  const found = [];
  for (const p of listFiles(join(claudeDir, 'agents'), '.md')) found.push(readAgent(p, 'user', null));
  if (projectRoot) {
    for (const p of listFiles(join(projectRoot, '.claude', 'agents'), '.md')) found.push(readAgent(p, 'project', null));
  }
  for (const root of pluginRoots(claudeDir)) {
    for (const p of listFiles(join(root.dir, 'agents'), '.md')) found.push(readAgent(p, 'plugin', root.plugin));
  }
  return found.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}
```

```js
// src/catalog/skills.js
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parseFrontmatter } from '../core/frontmatter.js';
import { pluginRoots } from './agents.js';

function skillsIn(dir, scope, source, version) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()); }
  catch { return []; }

  const out = [];
  for (const entry of entries) {
    const path = join(dir, entry.name, 'SKILL.md');
    if (!existsSync(path)) continue;
    let text;
    try { text = readFileSync(path, 'utf8'); } catch { continue; }
    const { data } = parseFrontmatter(text);
    out.push({
      kind: 'skill',
      name: typeof data.name === 'string' && data.name ? data.name : basename(entry.name),
      description: typeof data.description === 'string' ? data.description : '',
      scope, source, version: version ?? null, path,
    });
  }
  return out;
}

export function scanSkills({ claudeDir, projectRoot }) {
  const found = [
    ...skillsIn(join(claudeDir, 'skills'), 'user', null, null),
    ...(projectRoot ? skillsIn(join(projectRoot, '.claude', 'skills'), 'project', null, null) : []),
  ];
  for (const root of pluginRoots(claudeDir)) {
    found.push(...skillsIn(join(root.dir, 'skills'), 'plugin', root.plugin, root.version));
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}
```

- [ ] **Step 4: Implement the cache, watcher, and route**

```js
// src/catalog/index.js
import { watch } from 'node:fs';
import { join } from 'node:path';
import { scanAgents } from './agents.js';
import { scanSkills } from './skills.js';

export { scanAgents, scanSkills };

export function scanCatalog({ claudeDir, projectRoot }) {
  return {
    agents: scanAgents({ claudeDir, projectRoot }),
    skills: scanSkills({ claudeDir, projectRoot }),
    scannedAt: Date.now(),
  };
}

export function createCatalog({ claudeDir, projectRoot, debounceMs = 250 }) {
  let cached = null;
  const watchers = [];
  let timer = null;

  const get = () => (cached ??= scanCatalog({ claudeDir, projectRoot }));
  const refresh = () => { cached = scanCatalog({ claudeDir, projectRoot }); return cached; };

  return {
    get, refresh,
    watch(onChange) {
      const targets = [join(claudeDir, 'agents'), join(claudeDir, 'skills'), join(claudeDir, 'plugins', 'cache')];
      if (projectRoot) targets.push(join(projectRoot, '.claude'));
      for (const dir of targets) {
        try {
          watchers.push(watch(dir, { recursive: true }, () => {
            clearTimeout(timer);
            timer = setTimeout(() => onChange(refresh()), debounceMs);
            timer.unref?.();
          }));
        } catch { /* directory absent or platform lacks recursive watch: skip it */ }
      }
    },
    close() { for (const w of watchers) { try { w.close(); } catch { /* already closed */ } } },
  };
}
```

```js
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
```

- [ ] **Step 5: Run tests, confirm green, commit**

```bash
npm test
git add src/catalog src/daemon/routes/catalog.js test/catalog
git commit -m "feat: scan agents and skills across user, project, and plugin scopes"
```

---
## Task 14: Daemon entry point and CLI

**Files:**
- Create: `src/daemon/index.js`, `src/daemon/routes/static.js`, `src/daemon/routes/auth.js`, `src/cli/index.js`, `bin/agentpanel.js`
- Modify: `src/daemon/server.js` — add prefix route matching (static assets need it)
- Test: `test/daemon/daemon.test.js`, `test/cli/cli.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1–13.
- Produces:
  - `startDaemon({ claudeDir, projectRoot, uiDir, host, portRange, now }) => { server, port, token, url, stop() }`.
    `url` is `http://127.0.0.1:<port>/auth?token=<token>`.
  - `authRoute({ token }) => Route` — `GET /auth`, `public: true`. On a matching `?token=`, sets
    `agentpanel_token=<token>; HttpOnly; SameSite=Strict; Path=/` and 302s to `/`. On a mismatch, 401.
  - `streamRoute({ hub }) => Route` — `GET /api/stream`, adds the response to the hub and holds it open.
  - `staticRoute({ uiDir }) => Route` — `prefix: '/'`, serves `index.html` for unknown paths so client-side
    routing works, with the resolved path confined to `uiDir`.
  - `main(argv) => Promise<number>` in `src/cli/index.js`, dispatching `init`, `start`, `stop`, `status`,
    `open`, `uninstall`, and returning a process exit code.
- Server change: a route may specify `prefix: '/x'` instead of `path`. Exact `path` matches are checked
  first; prefix matches are checked in declaration order afterwards.

- [ ] **Step 1: Write the failing test**

```js
// test/daemon/daemon.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDaemon } from '../../src/daemon/index.js';

function env() {
  const claudeDir = mkdtempSync(join(tmpdir(), 'ap-d-'));
  const uiDir = mkdtempSync(join(tmpdir(), 'ap-ui-'));
  mkdirSync(join(uiDir, 'assets'), { recursive: true });
  writeFileSync(join(uiDir, 'index.html'), '<!doctype html><title>agentpanel</title>');
  writeFileSync(join(uiDir, 'assets', 'app.js'), 'console.log(1)');
  return { claudeDir, uiDir, projectRoot: claudeDir };
}

test('binds loopback, writes a live runtime file, and reports a token url', async () => {
  const d = await startDaemon({ ...env(), portRange: { start: 18900, end: 18950 } });
  assert.ok(d.port >= 18900 && d.port <= 18950);
  assert.equal(d.server.address().address, '127.0.0.1');
  assert.match(d.url, /^http:\/\/127\.0\.0\.1:\d+\/auth\?token=[0-9a-f]{64}$/);
  await d.stop();
});

test('the auth route exchanges a token for a cookie and redirects', async () => {
  const d = await startDaemon({ ...env(), portRange: { start: 18951, end: 18990 } });
  const res = await fetch(`http://127.0.0.1:${d.port}/auth?token=${d.token}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/');
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /agentpanel_token=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  await d.stop();
});

test('the auth route rejects a wrong token', async () => {
  const d = await startDaemon({ ...env(), portRange: { start: 18991, end: 18999 } });
  const res = await fetch(`http://127.0.0.1:${d.port}/auth?token=${'0'.repeat(64)}`, { redirect: 'manual' });
  assert.equal(res.status, 401);
  await d.stop();
});

test('the cookie from /auth authenticates an api call', async () => {
  const d = await startDaemon({ ...env(), portRange: { start: 19000, end: 19010 } });
  const auth = await fetch(`http://127.0.0.1:${d.port}/auth?token=${d.token}`, { redirect: 'manual' });
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  const res = await fetch(`http://127.0.0.1:${d.port}/api/catalog`, { headers: { cookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.agents));
  await d.stop();
});

test('static assets are served and unknown paths fall back to index.html', async () => {
  const d = await startDaemon({ ...env(), portRange: { start: 19011, end: 19020 } });
  const auth = await fetch(`http://127.0.0.1:${d.port}/auth?token=${d.token}`, { redirect: 'manual' });
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  const asset = await fetch(`http://127.0.0.1:${d.port}/assets/app.js`, { headers: { cookie } });
  assert.equal(asset.status, 200);
  const spa = await fetch(`http://127.0.0.1:${d.port}/activity`, { headers: { cookie } });
  assert.equal(spa.status, 200);
  assert.match(await spa.text(), /<!doctype html>/i);
  await d.stop();
});

test('a traversal attempt cannot escape the ui directory', async () => {
  const d = await startDaemon({ ...env(), portRange: { start: 19021, end: 19030 } });
  const auth = await fetch(`http://127.0.0.1:${d.port}/auth?token=${d.token}`, { redirect: 'manual' });
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  const res = await fetch(`http://127.0.0.1:${d.port}/../../../../etc/passwd`, { headers: { cookie } });
  assert.notEqual(res.status, 200);
  await d.stop();
});

test('stop clears the runtime file so the next bootstrap starts fresh', async () => {
  const e = env();
  const d = await startDaemon({ ...e, portRange: { start: 19031, end: 19040 } });
  const { readRuntime } = await import('../../src/core/runtime-file.js');
  const file = join(e.claudeDir, 'agentpanel', 'daemon.json');
  assert.equal(readRuntime(file).port, d.port);
  await d.stop();
  assert.equal(readRuntime(file), null);
});

test('a second daemon takes the next port instead of failing', async () => {
  const a = await startDaemon({ ...env(), portRange: { start: 19041, end: 19050 } });
  const b = await startDaemon({ ...env(), portRange: { start: 19041, end: 19050 } });
  assert.notEqual(a.port, b.port);
  await a.stop(); await b.stop();
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Add prefix matching to the server**

In `src/daemon/server.js`, replace the single `routes.find(...)` line with:

```js
    const route = routes.find((r) => r.method === req.method && r.path === url.pathname)
      ?? routes.find((r) => r.method === req.method && r.prefix !== undefined && url.pathname.startsWith(r.prefix));
```

- [ ] **Step 4: Implement the auth and static routes**

```js
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
```

```js
// src/daemon/routes/static.js
import { readFile } from 'node:fs/promises';
import { join, resolve, extname, sep } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon',
};

export function staticRoute({ uiDir }) {
  const root = resolve(uiDir);

  return {
    method: 'GET',
    prefix: '/',
    handler: async (req, res, ctx) => {
      const requested = resolve(join(root, decodeURIComponent(ctx.url.pathname)));
      const inside = requested === root || requested.startsWith(root + sep);
      const isAsset = inside && extname(requested) !== '';

      const file = isAsset ? requested : join(root, 'index.html');
      try {
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
        res.end(body);
      } catch {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"not_found"}');
      }
    },
  };
}
```

- [ ] **Step 5: Implement the daemon entry**

```js
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
```

- [ ] **Step 6: Implement the CLI**

```js
// src/cli/index.js
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { claudeHome, stateDir, userSettingsPath, runtimeFilePath } from '../core/paths.js';
import { readLiveRuntime, clearRuntime } from '../core/runtime-file.js';
import { startDaemon } from '../daemon/index.js';
import { runInit } from './init.js';
import { runUninstall } from './uninstall.js';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const OPENERS = { darwin: 'open', win32: 'start', linux: 'xdg-open' };

export async function main(argv = process.argv.slice(2), log = console.log) {
  const [command = 'status', ...rest] = argv;

  switch (command) {
    case 'init':
      runInit({
        settingsPath: userSettingsPath(),
        hooksDir: join(pkgRoot, 'hooks'),
        assumeYes: rest.includes('--yes'),
        log,
      });
      return 0;

    case 'start': {
      const live = readLiveRuntime();
      if (live) { log(`Already running on port ${live.port} (pid ${live.pid}).`); return 0; }
      const daemon = await startDaemon({
        claudeDir: claudeHome(),
        projectRoot: process.cwd(),
        uiDir: join(pkgRoot, 'dist', 'ui'),
      });
      log(`agentpanel listening on http://127.0.0.1:${daemon.port}`);
      log(`Open: ${daemon.url}`);
      for (const signal of ['SIGINT', 'SIGTERM']) {
        process.on(signal, () => { daemon.stop().then(() => process.exit(0)); });
      }
      return null;   // keep the process alive
    }

    case 'stop': {
      const live = readLiveRuntime();
      if (!live) { log('Not running.'); clearRuntime(); return 0; }
      process.kill(live.pid, 'SIGTERM');
      log(`Stopped pid ${live.pid}.`);
      return 0;
    }

    case 'status': {
      const live = readLiveRuntime();
      log(live ? `running  pid=${live.pid}  port=${live.port}  since=${new Date(live.startedAt).toISOString()}`
               : 'stopped');
      return live ? 0 : 1;
    }

    case 'open': {
      const live = readLiveRuntime();
      if (!live) { log('Not running. Start it with: agentpanel start'); return 1; }
      const url = `http://127.0.0.1:${live.port}/auth?token=${live.token}`;
      const opener = OPENERS[process.platform];
      if (opener) execFile(opener, [url], () => {});
      log(url);
      return 0;
    }

    case 'uninstall':
      runUninstall({ settingsPath: userSettingsPath(), stateDir: stateDir(), log });
      return 0;

    default:
      log('usage: agentpanel <init|start|stop|status|open|uninstall>');
      log(`runtime file: ${runtimeFilePath()}`);
      return 1;
  }
}
```

```js
// bin/agentpanel.js
#!/usr/bin/env node
import { main } from '../src/cli/index.js';

const code = await main();
if (code !== null) process.exit(code);
```

- [ ] **Step 7: Write the CLI test**

```js
// test/cli/cli.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../src/cli/index.js';

test('status reports stopped and exits 1 when nothing is running', async () => {
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ap-cli-'));
  const lines = [];
  const code = await main(['status'], (l) => lines.push(l));
  assert.equal(code, 1);
  assert.equal(lines[0], 'stopped');
  delete process.env.CLAUDE_CONFIG_DIR;
});

test('an unknown command prints usage and exits 1', async () => {
  const lines = [];
  assert.equal(await main(['nonsense'], (l) => lines.push(l)), 1);
  assert.match(lines[0], /^usage:/);
});

test('open reports not-running rather than launching a browser', async () => {
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'ap-cli-'));
  const lines = [];
  assert.equal(await main(['open'], (l) => lines.push(l)), 1);
  assert.match(lines[0], /Not running/);
  delete process.env.CLAUDE_CONFIG_DIR;
});
```

- [ ] **Step 8: Run tests, confirm green, commit**

```bash
chmod +x bin/agentpanel.js
npm test
git add bin src/daemon src/cli test/daemon/daemon.test.js test/cli/cli.test.js
git commit -m "feat: add daemon entry point and command line interface"
```

---
## Task 15: UI shell and live agent rail

The rail is the product's reason to exist. Build it before the browsable pages.

**Files:**
- Create: `ui/index.html`, `ui/vite.config.js`, `ui/src/main.jsx`, `ui/src/api.js`, `ui/src/styles.css`,
  `ui/src/components/{Layout,LiveRail,RunRow}.jsx`
- Modify: `package.json` — add devDependencies and the `build:ui` script
- Test: `ui/test/{LiveRail,api}.test.jsx`

**Interfaces:**
- Produces:
  - `connectStream({ onEvent, onError }) => () => void` in `api.js`, wrapping `EventSource('/api/stream')`.
    The cookie set by `/auth` authenticates it; `EventSource` cannot send an `Authorization` header, which is
    exactly why the cookie exchange exists.
  - `fetchJson(path) => Promise<object>` — throws `Error('unauthorized')` on 401 so the UI can tell the user
    to reopen the token URL instead of rendering an empty dashboard.
  - `<LiveRail runs={Run[]} now={number} />` and `<RunRow run={Run} now={number} />`.
  - `formatElapsed(ms) => string` — `'0s'`, `'42s'`, `'2m14s'`, `'1h03m'`.
- `package.json` gains: devDependencies `vite`, `@vitejs/plugin-react`, `react`, `react-dom`, `vitest`,
  `@testing-library/react`, `jsdom`; scripts `"build:ui": "vite build --config ui/vite.config.js"` and
  `"test:ui": "vitest run --root ui"`. Runtime `dependencies` stays `{}` — React ships prebuilt in `dist/ui`.

- [ ] **Step 1: Write the failing test**

```jsx
// ui/test/LiveRail.test.jsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LiveRail } from '../src/components/LiveRail.jsx';
import { formatElapsed } from '../src/components/RunRow.jsx';

const run = (over = {}) => ({
  id: 's1:t1', sessionId: 's1', agentType: 'programmer', description: 'add auth',
  status: 'running', startedAt: 1000, endedAt: null, durationMs: null, ...over,
});

describe('formatElapsed', () => {
  it('formats each magnitude', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(42_000)).toBe('42s');
    expect(formatElapsed(134_000)).toBe('2m14s');
    expect(formatElapsed(3_780_000)).toBe('1h03m');
  });
  it('never renders a negative clock', () => {
    expect(formatElapsed(-5)).toBe('0s');
  });
});

describe('LiveRail', () => {
  it('shows agent type, description, and a live elapsed time', () => {
    render(<LiveRail runs={[run()]} now={135_000} />);
    expect(screen.getByText('programmer')).toBeTruthy();
    expect(screen.getByText('add auth')).toBeTruthy();
    expect(screen.getByText('2m14s')).toBeTruthy();
  });

  it('freezes the clock for finished runs at their recorded duration', () => {
    render(<LiveRail runs={[run({ status: 'done', endedAt: 5000, durationMs: 4000 })]} now={999_999} />);
    expect(screen.getByText('4s')).toBeTruthy();
  });

  it('labels a stale run so a dead spinner is never shown', () => {
    render(<LiveRail runs={[run({ status: 'stale', endedAt: 9000, durationMs: 8000 })]} now={999_999} />);
    expect(screen.getByText(/stale/i)).toBeTruthy();
  });

  it('explains the empty state instead of rendering nothing', () => {
    render(<LiveRail runs={[]} now={0} />);
    expect(screen.getByText(/no agents running/i)).toBeTruthy();
  });

  it('sorts running runs above finished ones', () => {
    render(<LiveRail now={10_000} runs={[
      run({ id: 'a', status: 'done', endedAt: 2000, durationMs: 1000, agentType: 'qa' }),
      run({ id: 'b', status: 'running', agentType: 'reviewer' }),
    ]} />);
    const rows = screen.getAllByRole('listitem');
    expect(rows[0].textContent).toContain('reviewer');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test:ui`
Expected: FAIL — the components do not exist.

- [ ] **Step 3: Implement `RunRow` and `LiveRail`**

```jsx
// ui/src/components/RunRow.jsx
export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

const DOT = { running: 'dot running', done: 'dot done', error: 'dot error', stale: 'dot stale' };

export function RunRow({ run, now }) {
  const elapsed = run.status === 'running' ? now - run.startedAt : (run.durationMs ?? 0);
  return (
    <li className={`run ${run.status}`}>
      <span className={DOT[run.status] ?? 'dot'} aria-hidden="true" />
      <span className="agent">{run.agentType ?? 'unknown'}</span>
      <span className="desc" title={run.description ?? ''}>{run.description}</span>
      <span className="elapsed">{formatElapsed(elapsed)}</span>
      {run.status === 'stale' && <span className="badge">stale</span>}
      <span className="sr-only">{`status ${run.status}`}</span>
    </li>
  );
}
```

```jsx
// ui/src/components/LiveRail.jsx
import { RunRow } from './RunRow.jsx';

const rank = (r) => (r.status === 'running' ? 0 : 1);

export function LiveRail({ runs, now }) {
  const ordered = [...runs].sort((a, b) => rank(a) - rank(b) || b.startedAt - a.startedAt);

  return (
    <aside className="rail" aria-label="Live agents">
      <h2>Live agents</h2>
      {ordered.length === 0
        ? <p className="empty">No agents running. Dispatch one from any Claude Code session and it appears here.</p>
        : <ul>{ordered.map((run) => <RunRow key={run.id} run={run} now={now} />)}</ul>}
    </aside>
  );
}
```

- [ ] **Step 4: Implement the stream client**

```js
// ui/src/api.js
export async function fetchJson(path) {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) throw new Error(`request_failed_${res.status}`);
  return res.json();
}

const EVENTS = ['run.open', 'run.close', 'run.enrich', 'session.end', 'catalog.changed'];

export function connectStream({ onEvent, onError }) {
  const source = new EventSource('/api/stream');
  for (const name of EVENTS) {
    source.addEventListener(name, (e) => onEvent(name, JSON.parse(e.data)));
  }
  source.onerror = () => onError?.(new Error('stream_disconnected'));
  return () => source.close();
}
```

- [ ] **Step 5: Implement the shell**

`ui/src/main.jsx` mounts `<Layout>`, holds `runs` state seeded from `GET /api/runs`, subscribes with
`connectStream`, applies `run.open` / `run.close` / `run.enrich` by run `id`, and ticks a `now` value every
second so elapsed times advance without re-fetching. On an `unauthorized` error it renders a single line:
"Session expired — reopen the URL printed by `agentpanel open`."

```jsx
// ui/src/main.jsx
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Layout } from './components/Layout.jsx';
import { LiveRail } from './components/LiveRail.jsx';
import { connectStream, fetchJson } from './api.js';
import './styles.css';

function App() {
  const [runs, setRuns] = useState([]);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchJson('/api/runs').then((d) => setRuns([...d.active, ...d.recent])).catch((e) => setError(e.message));
    return connectStream({
      onEvent: (_name, run) => setRuns((prev) => {
        if (!run?.id) return prev;
        const rest = prev.filter((r) => r.id !== run.id);
        return [run, ...rest];
      }),
      onError: () => setError('stream_disconnected'),
    });
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (error === 'unauthorized') {
    return <p className="fatal">Session expired — reopen the URL printed by <code>agentpanel open</code>.</p>;
  }

  return <Layout rail={<LiveRail runs={runs} now={now} />} />;
}

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
```

- [ ] **Step 6: Implement `Layout` and the stylesheet**

```jsx
// ui/src/components/Layout.jsx
import { useRoute } from '../router.jsx';

const NAV = [
  { path: '/', label: 'Chat' },
  { path: '/agents', label: 'Agents' },
  { path: '/skills', label: 'Skills' },
  { path: '/activity', label: 'Activity' },
];

export function Layout({ rail, children }) {
  const { path, navigate } = useRoute();

  return (
    <div className="shell">
      <nav aria-label="Sections">
        <h1>agentpanel</h1>
        <ul>
          {NAV.map((item) => (
            <li key={item.path}>
              <a href={item.path}
                 aria-current={path === item.path ? 'page' : undefined}
                 onClick={(e) => { e.preventDefault(); navigate(item.path); }}>
                {item.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <main>{children}</main>
      {rail}
    </div>
  );
}
```

`ui/src/styles.css` defines the palette as custom properties on `:root` and a dark override under
`@media (prefers-color-scheme: dark)`, then lays the shell out as a three-column grid that collapses the rail
below the main column under 900px:

```css
:root {
  --bg: #0f1115; --panel: #161a21; --line: #262c36;
  --text: #e6e9ef; --muted: #9aa4b2;
  --running: #4ade80; --done: #64748b; --error: #f87171; --stale: #fbbf24;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
}
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, sans-serif; }
.shell { display: grid; grid-template-columns: 200px 1fr 320px; min-height: 100vh; }
.rail { border-left: 1px solid var(--line); padding: 16px; }
.run { display: grid; grid-template-columns: 10px 1fr auto; gap: 8px; align-items: baseline; padding: 8px 0; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--done); }
.dot.running { background: var(--running); animation: pulse 1.6s ease-in-out infinite; }
.dot.error { background: var(--error); } .dot.stale { background: var(--stale); }
.agent, .elapsed, .mono { font-family: var(--mono); }
.empty { color: var(--muted); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
@keyframes pulse { 50% { opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) { .dot.running { animation: none; } }
@media (max-width: 900px) { .shell { grid-template-columns: 1fr; } }
```

- [ ] **Step 7: Run both suites, confirm green, commit**

```bash
npm run test:ui && npm test
git add ui package.json
git commit -m "feat: add dashboard shell and live agent rail"
```

---

## Task 16: Catalog and activity pages

**Files:**
- Create: `ui/src/pages/{Agents,Skills,Activity}.jsx`, `ui/src/router.jsx`
- Test: `ui/test/pages.test.jsx`

**Interfaces:**
- Consumes: `fetchJson` (Task 15), `GET /api/catalog`, `GET /api/runs`.
- Produces: three page components taking their data as props (so they are testable without network), and a
  `useRoute()` hook over `history.pushState` — no router dependency for four routes.
- Every page states its empty case in words. A blank panel is indistinguishable from a broken one.

- [ ] **Step 1: Write the failing test**

```jsx
// ui/test/pages.test.jsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Agents } from '../src/pages/Agents.jsx';
import { Skills } from '../src/pages/Skills.jsx';
import { Activity } from '../src/pages/Activity.jsx';

const agents = [
  { kind: 'agent', name: 'reviewer', description: 'Reviews code.', tools: 'Read, Grep', model: 'opus', scope: 'user', source: null },
  { kind: 'agent', name: 'plugin-agent', description: 'From a plugin.', tools: null, model: null, scope: 'plugin', source: 'superpowers' },
];

const skills = [
  { kind: 'skill', name: 'brainstorming', description: 'Turns ideas into designs.', scope: 'plugin', source: 'superpowers', version: '6.3.0' },
];

describe('Agents page', () => {
  it('lists each agent with its scope badge', () => {
    render(<Agents agents={agents} />);
    expect(screen.getByText('reviewer')).toBeTruthy();
    expect(screen.getByText('user')).toBeTruthy();
    expect(screen.getByText('plugin')).toBeTruthy();
  });

  it('shows the plugin source when there is one', () => {
    render(<Agents agents={agents} />);
    expect(screen.getByText(/superpowers/)).toBeTruthy();
  });

  it('names the empty state', () => {
    render(<Agents agents={[]} />);
    expect(screen.getByText(/no agents found/i)).toBeTruthy();
  });
});

describe('Skills page', () => {
  it('shows the plugin version', () => {
    render(<Skills skills={skills} />);
    expect(screen.getByText(/6\.3\.0/)).toBeTruthy();
  });

  it('filters by the search term', async () => {
    render(<Skills skills={[...skills, { kind: 'skill', name: 'zzz-other', description: '', scope: 'user', source: null, version: null }]} initialQuery="brain" />);
    expect(screen.queryByText('zzz-other')).toBeNull();
    expect(screen.getByText('brainstorming')).toBeTruthy();
  });
});

describe('Activity page', () => {
  it('renders finished runs with their duration', () => {
    render(<Activity runs={[{ id: 'a', agentType: 'qa', description: 'tests', status: 'done', startedAt: 0, durationMs: 5000 }]} />);
    expect(screen.getByText('qa')).toBeTruthy();
    expect(screen.getByText('5s')).toBeTruthy();
  });

  it('tells the user when hooks are not installed rather than showing an empty list', () => {
    render(<Activity runs={[]} hooksInstalled={false} />);
    expect(screen.getByText(/agentpanel init/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test:ui`
Expected: FAIL — pages do not exist.

- [ ] **Step 3: Implement the pages**

```jsx
// ui/src/pages/Agents.jsx
export function Agents({ agents }) {
  if (agents.length === 0) {
    return <p className="empty">No agents found in ~/.claude/agents, this project, or any enabled plugin.</p>;
  }
  return (
    <ul className="cards">
      {agents.map((a) => (
        <li key={`${a.scope}:${a.source ?? ''}:${a.name}`} className="card">
          <h3>{a.name}</h3>
          <p>{a.description}</p>
          <dl>
            <dt>scope</dt><dd><span className={`badge ${a.scope}`}>{a.scope}</span></dd>
            {a.source && <><dt>from</dt><dd>{a.source}</dd></>}
            {a.model && <><dt>model</dt><dd>{a.model}</dd></>}
            {a.tools && <><dt>tools</dt><dd className="mono">{Array.isArray(a.tools) ? a.tools.join(', ') : a.tools}</dd></>}
          </dl>
        </li>
      ))}
    </ul>
  );
}
```

```jsx
// ui/src/pages/Skills.jsx
import { useState } from 'react';

export function Skills({ skills, initialQuery = '' }) {
  const [query, setQuery] = useState(initialQuery);
  const term = query.trim().toLowerCase();
  const shown = term
    ? skills.filter((s) => `${s.name} ${s.description}`.toLowerCase().includes(term))
    : skills;

  return (
    <div>
      <label className="search">
        <span className="sr-only">Search skills</span>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search skills" />
      </label>
      {shown.length === 0
        ? <p className="empty">No skills match. Skills live in ~/.claude/skills and in enabled plugins.</p>
        : <ul className="cards">
            {shown.map((s) => (
              <li key={`${s.scope}:${s.source ?? ''}:${s.name}`} className="card">
                <h3>{s.name}</h3>
                <p>{s.description}</p>
                <dl>
                  <dt>scope</dt><dd><span className={`badge ${s.scope}`}>{s.scope}</span></dd>
                  {s.source && <><dt>from</dt><dd>{s.source}{s.version ? ` ${s.version}` : ''}</dd></>}
                </dl>
              </li>
            ))}
          </ul>}
    </div>
  );
}
```

```jsx
// ui/src/pages/Activity.jsx
import { formatElapsed } from '../components/RunRow.jsx';

export function Activity({ runs, hooksInstalled = true }) {
  if (!hooksInstalled) {
    return <p className="empty">Agent tracking is off because the hooks are not installed. Run <code>npx agentpanel init</code>, then start a new Claude Code session.</p>;
  }
  if (runs.length === 0) {
    return <p className="empty">No agent runs recorded yet. They appear here as soon as any session dispatches a subagent.</p>;
  }
  return (
    <table className="activity">
      <thead><tr><th>agent</th><th>description</th><th>status</th><th>duration</th></tr></thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r.id}>
            <td>{r.agentType ?? 'unknown'}</td>
            <td>{r.description}</td>
            <td><span className={`badge ${r.status}`}>{r.status}</span></td>
            <td>{formatElapsed(r.durationMs ?? 0)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 4: Wire the routes**

```jsx
// ui/src/router.jsx
import { useEffect, useState, useCallback } from 'react';

export function useRoute() {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((next) => {
    window.history.pushState({}, '', next);
    setPath(next);
  }, []);

  return { path, navigate };
}
```

Then in `main.jsx`, pick the page from `path` and fetch the catalog once, refetching when a
`catalog.changed` event arrives:

```jsx
const [catalog, setCatalog] = useState({ agents: [], skills: [] });
const { path } = useRoute();

useEffect(() => { fetchJson('/api/catalog').then(setCatalog).catch(() => {}); }, [reloadKey]);

const page = path === '/agents'   ? <Agents agents={catalog.agents} />
           : path === '/skills'   ? <Skills skills={catalog.skills} />
           : path === '/activity' ? <Activity runs={runs.filter((r) => r.status !== 'running')} />
           : <p className="empty">Orchestrator chat arrives in Plan 2. Live agent activity is on the right.</p>;
```

`reloadKey` is a counter bumped by the `catalog.changed` stream event.

- [ ] **Step 5: Run both suites, confirm green, commit**

```bash
npm run test:ui && npm test
git add ui
git commit -m "feat: add agents, skills, and activity pages"
```

---
## Task 17: End-to-end smoke, packaging, docs, CI

The last task proves the pieces work together as a real install, then makes the result publishable.

**Files:**
- Create: `test/e2e/smoke.test.js`, `README.md`, `LICENSE`, `.github/workflows/ci.yml`
- Modify: `package.json` — publish metadata and scripts

**Interfaces:**
- Consumes: everything.
- Produces: a smoke test that drives the real hook script against a real daemon, a README, and CI.

- [ ] **Step 1: Write the end-to-end smoke test**

```js
// test/e2e/smoke.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDaemon } from '../../src/daemon/index.js';

const HOOK = fileURLToPath(new URL('../../hooks/agentpanel-hook.sh', import.meta.url));

function fire(payload, configDir) {
  return new Promise((resolve) => {
    const child = execFile('bash', [HOOK], { env: { ...process.env, CLAUDE_CONFIG_DIR: configDir } },
      () => resolve());
    child.stdin.end(JSON.stringify(payload));
  });
}

test('a dispatched subagent appears and then completes, end to end', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'ap-e2e-'));
  const uiDir = mkdtempSync(join(tmpdir(), 'ap-e2e-ui-'));
  mkdirSync(uiDir, { recursive: true });
  writeFileSync(join(uiDir, 'index.html'), '<!doctype html><title>t</title>');

  const daemon = await startDaemon({
    claudeDir, projectRoot: claudeDir, uiDir, portRange: { start: 19100, end: 19150 },
  });

  const base = { session_id: 'e2e', cwd: '/proj', tool_name: 'Agent', tool_use_id: 'tu_e2e' };
  const get = async () => {
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/runs`,
      { headers: { authorization: `Bearer ${daemon.token}` } });
    return res.json();
  };

  await fire({ ...base, hook_event_name: 'PreToolUse',
    tool_input: { subagent_type: 'programmer', description: 'wire it up', prompt: 'go' } }, claudeDir);

  let state = await get();
  assert.equal(state.active.length, 1);
  assert.equal(state.active[0].agentType, 'programmer');
  assert.equal(state.active[0].description, 'wire it up');

  await fire({ ...base, hook_event_name: 'PostToolUse', tool_response: 'finished', duration_ms: 1234 }, claudeDir);

  state = await get();
  assert.equal(state.active.length, 0);
  assert.equal(state.recent[0].status, 'done');
  assert.equal(state.recent[0].durationMs, 1234);

  await daemon.stop();
});

test('the hook script does not disturb a session when the daemon is stopped', async () => {
  const claudeDir = mkdtempSync(join(tmpdir(), 'ap-e2e-off-'));
  await fire({ hook_event_name: 'PreToolUse', session_id: 'x' }, claudeDir);
  // Reaching this line without a throw or hang is the assertion.
  assert.ok(true);
});
```

- [ ] **Step 2: Run it and confirm it passes against the real pieces**

Run: `npm test`
Expected: PASS. If the first test fails at the `active.length` assertion, the hook script and the route
disagree — debug there before touching anything else.

- [ ] **Step 3: Finish `package.json` for publishing**

```json
{
  "name": "agentpanel",
  "version": "0.1.0",
  "description": "Local dashboard for Claude Code: live subagent activity, agent and skill catalog",
  "keywords": ["claude", "claude-code", "dashboard", "agents", "observability"],
  "license": "MIT",
  "type": "module",
  "bin": { "agentpanel": "bin/agentpanel.js" },
  "engines": { "node": ">=22.5.0" },
  "files": ["bin", "src", "hooks", "dist", "README.md", "LICENSE"],
  "scripts": {
    "test": "node --test --disable-warning=ExperimentalWarning test/**/*.test.js",
    "test:ui": "vitest run --root ui",
    "build:ui": "vite build --config ui/vite.config.js",
    "prepack": "npm run build:ui"
  },
  "dependencies": {},
  "repository": { "type": "git", "url": "git+https://github.com/<owner>/agentpanel.git" }
}
```

Publishing uses `npm publish --provenance --access public` from CI, never from a laptop.

- [ ] **Step 4: Write the README**

It must contain, in this order: what it does (one paragraph and one screenshot), install
(`npx agentpanel init`), what `init` writes and how to undo it (`npx agentpanel uninstall`), the commands,
and a **Security** section stating plainly:

- The daemon binds `127.0.0.1` and every route requires a token.
- Hooks run shell commands with your full user permissions. Quote the official warning:
  "Command hooks execute shell commands with your full user permissions. They can modify, delete, or access
  any files your user account can access. Review and test all hook commands before adding them to your
  configuration."
- Claude Code withholds hooks in a directory you have not accepted the workspace trust prompt for, so the
  dashboard will not autostart there. This is Claude Code's behaviour, not a bug in agentpanel.
- agentpanel reads hook payloads that include prompts and tool output, stores them in
  `~/.claude/agentpanel/data.db`, and redacts secret-shaped strings before writing. Redaction is
  pattern-based and cannot be complete. Nothing is ever sent off the machine.

Also state the Plan 2 scope so readers know chat is coming and is not missing by accident.

- [ ] **Step 5: Add CI**

```yaml
# .github/workflows/ci.yml
name: ci
on: [push, pull_request]
jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest]
        node: ['22.5', '24']
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '${{ matrix.node }}' }
      - run: npm ci
      - run: npm test
      - run: npm run test:ui
      - run: npm run build:ui
```

- [ ] **Step 6: Verify the packaged install, then commit**

```bash
npm pack --dry-run          # confirm hooks/ and dist/ are included, and that node_modules is not
npm test && npm run test:ui
git add README.md LICENSE .github package.json test/e2e
git commit -m "chore: add end-to-end smoke test, packaging, docs, and CI"
```

---

## Definition of done for Plan 1

- `npx agentpanel init` installs five hooks into `~/.claude/settings.json` and touches nothing else.
- Starting any Claude Code session in a trusted directory brings the daemon up on 8888 (or the next free port).
- `agentpanel open` opens a dashboard that lists every agent and skill, with scope and plugin provenance.
- Dispatching a subagent from any session — terminal or otherwise — makes a row appear in the live rail
  within a second, with a ticking timer, and mark itself done when the subagent finishes.
- `npx agentpanel uninstall` leaves `settings.json` byte-identical to its pre-install state apart from
  formatting, and removes the state directory.
- `npm test` and `npm run test:ui` pass on Node 22.5 and 24, on macOS and Ubuntu.

## Not in Plan 1

Orchestrator chat, the SDK session, the permission approval UI, the project switcher, agent creation, skill
installation, and marketplace browsing. Those are Plan 2, written after this plan lands so it builds on real
interfaces rather than predicted ones.
