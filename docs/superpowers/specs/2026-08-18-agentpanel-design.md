# agentpanel — Design Spec

Date: 2026-08-18
Status: approved for planning
Package: `agentpanel` (npm, unscoped — verified available 2026-08-18)
Repository: public, English-only

## 1. Problem

Claude Code runs entirely in a terminal. Three things are invisible or awkward there:

1. **Subagent activity.** When the orchestrator dispatches subagents, the user cannot see which agents are
   running, for how long, or in which session. Long parallel fan-outs are opaque.
2. **Inventory.** Agents live in `~/.claude/agents/*.md`, project `.claude/agents/`, and plugin directories.
   Skills live in `~/.claude/skills/`, plugin `*/skills/`, and project `.claude/skills/`. There is no single
   view of what exists, where it came from, or whether it is enabled.
3. **Authoring.** Creating an agent means hand-writing frontmatter. Installing a skill means remembering
   `claude plugin` subcommands and which marketplace a plugin belongs to.

agentpanel is a local web dashboard that solves all three, and hosts the orchestrator chat itself.

## 2. Goals

- Auto-start on `SessionStart`; reachable at `http://127.0.0.1:8888` (scans upward on collision).
- Chat with the orchestrator from the browser, with streaming output and visible tool calls.
- Live indicators for every running subagent, across every Claude Code session on the machine.
- Browsable catalog of agents and skills with provenance.
- Guided creation of agents; guided installation and scaffolding of skills.
- Safe by default, and honest about what it does not protect against.

## 3. Non-goals (v1)

Remote access, tunnels, or multi-user. Cost/usage analytics. Transcript editing. Mobile layout.
Non-English UI. Support for harnesses other than Claude Code.

## 4. Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Chat model | Dashboard owns its own SDK session; it is the primary surface | Claude Code exposes no API to attach to a running interactive session. Bridging is impossible, so the dashboard leads rather than mirrors. |
| Project scope | Multi-project switcher, one daemon | User works across many repos; one daemon keeps a single port, PID, and token. |
| Permissions | Approval UI in the dashboard via SDK `canUseTool` | Safe default for a public tool, and a visible permission log is a genuine feature. |
| Observability | Global hooks observe all sessions | Terminal work stays visible; the dashboard becomes a single pane of glass. |
| Agent tracking source | Hooks only — including for the dashboard's own session | One event path. Merging SDK stream events with hook events would require reconciling two descriptions of the same `Task` call. |
| Distribution | npm package + `init` CLI, prebuilt UI shipped | No build step for users; hooks installed by an explicit, reviewable command. |
| Runtime | Node ≥ 22, `node:sqlite`, no native dependencies | Zero-compile install. Verified: local Node is v24.6.0, npm 11.5.1. |

## 5. Verified environment facts (probed 2026-08-18)

- Claude Code CLI `2.1.234`; `@anthropic-ai/claude-agent-sdk` `0.3.234` — versions track together.
- CLI supports `--print --input-format stream-json --output-format stream-json --include-partial-messages`,
  `--resume`, `--fork-session`, `--agents`, `--mcp-config`.
- `claude plugin` provides `install`, `list`, `enable`, `disable`, `init`, `details`, `prune`, and
  `plugin marketplace add|list|remove|update`.
- Marketplace clones are cached under `~/.claude/plugins/marketplaces/<name>/`, so the plugin catalog can be
  browsed offline.
- Installed plugins are recorded in `~/.claude/plugins/installed_plugins.json` (schema `version: 2`) with
  `installPath`, `version`, `installedAt`, `gitCommitSha`.
- Session transcripts are JSONL at `~/.claude/projects/<slug>/<session-id>.jsonl`; entries carry
  `sessionId`, `cwd`, `gitBranch`, `isSidechain`, `parentUuid`, `uuid`, `timestamp`, `version`.
  `isSidechain: true` marks subagent traffic — the fallback signal if hooks are unavailable.
- Port 8888 free at time of probe.
- Hook input schemas are shipped as types in the SDK package (`sdk.d.ts`, `claudeCodeVersion: 2.1.234`).
  Verified: `BaseHookInput` = `session_id`, `transcript_path`, `cwd`, `prompt_id?`, `permission_mode?`,
  `agent_id?`, `agent_type?`, `effort?`. `PreToolUseHookInput` adds `tool_name`, `tool_input`,
  and **`tool_use_id: string` (required)**. `PostToolUseHookInput` adds `tool_response`,
  `tool_use_id: string`, `duration_ms?`. `SubagentStartHookInput` = `agent_id`, `agent_type`.
  `SubagentStopHookInput` = `agent_id`, `agent_type`, `agent_transcript_path`, `stop_hook_active`,
  `last_assistant_message?`, `background_tasks?`.
- `HOOK_EVENTS` contains 31 events, including `SubagentStart`, `SubagentStop`, `TaskCreated`,
  `TaskCompleted`, `PostToolUseFailure`, and `SessionEnd`.
- `node:sqlite` works on Node 24.6.0 without flags but prints an ExperimentalWarning; verified suppressed
  by spawning with `--disable-warning=ExperimentalWarning`.

## 6. Architecture

```
SessionStart hook (fires in every Claude Code session, any directory)
  └─ bootstrap script: is daemon alive? → no → spawn detached daemon → exit 0 immediately

daemon (single Node process)
  ├─ GET  /                 prebuilt React SPA
  ├─ GET  /auth?token=…     sets httpOnly SameSite=Strict cookie, redirects to /
  ├─ GET  /api/stream       SSE: chat deltas, agent events, permission requests, catalog changes
  ├─ POST /api/chat         user message → SDK session for the active project
  ├─ POST /api/permissions/:id   allow | deny | always-allow
  ├─ POST /api/hooks        ingest hook payloads from all sessions machine-wide
  ├─ GET  /api/catalog      agents + skills, scanned live
  ├─ POST /api/agents       create agent file
  ├─ POST /api/skills       scaffold skill or run a plugin command
  └─ SQLite ~/.claude/agentpanel/data.db   (mode 0600)

runtime state file  ~/.claude/agentpanel/daemon.json  (mode 0600)  { pid, port, token, startedAt, version }
```

**Startup.** The daemon binds `127.0.0.1`, trying port 8888 and scanning up to 8988. It writes `daemon.json`
with the winning port and a freshly generated token, then removes the file on clean shutdown. A stale file
whose PID is dead is overwritten.

**Bootstrap hook.** Reads `daemon.json`; if the PID is alive it exits immediately. Otherwise it spawns the
daemon detached (stdio to a log file) and exits. It never blocks session start and never writes to stdout on
the success path.

**Session lifecycle.** SDK sessions are created lazily — the daemon boots without one, and a session starts
only when a project's chat is first used. Session IDs are persisted, so a daemon restart resumes rather than
loses the conversation.

**Hook scripts.** Each hook reads its JSON payload on stdin and POSTs it to `/api/hooks` with the bearer
token from `daemon.json`. Every script fails open and silent: if the daemon is down, the port moved, or curl
is missing, it exits 0 without output. A dashboard must never be able to break a terminal session.

Hooks installed by `init`:

| Event | Matcher | Purpose |
|---|---|---|
| `SessionStart` | — | bootstrap daemon, register session |
| `PreToolUse` | `Task` | open an `AgentRun` keyed by `(session_id, tool_use_id)` |
| `SubagentStart` | — | record subagent lifecycle; enrichment only |
| `PostToolUse` | `Task` | close the `AgentRun` |
| `SubagentStop` | — | backstop close |
| `SessionEnd` | — | mark session ended, sweep its open runs |

## 7. Data model

```
Project     id = sha1(absolute path), path, name, lastActiveAt
Session     id = Claude session_id, projectId, source: dashboard | terminal,
            status: active | idle | ended, startedAt, lastEventAt
AgentRun    id, sessionId, agentType, description, status: running | done | error | stale,
            startedAt, endedAt, durationMs, resultPreview
Message     id, sessionId, role, blocks (JSON), ts        # dashboard sessions only
Permission  id, sessionId, tool, input (JSON), decision, decidedAt
```

The agent and skill catalog is **not** stored in SQLite. It is scanned from the filesystem on demand, cached
by mtime, and watched with a debounced `fs.watch` that pushes changes over SSE. The filesystem is the source
of truth; a cache that can disagree with it would be a bug generator.

**Run correlation.** `tool_use_id` is a required field on both `PreToolUseHookInput` and
`PostToolUseHookInput` (verified in the shipped SDK types), so correlation is exact — `(session_id,
tool_use_id)` is the primary key for a run, and no heuristic matching is needed. `SubagentStart` /
`SubagentStop` supply `agent_id` and `agent_type` and are the authoritative open/close signals; the
`PreToolUse[Task]` payload enriches the run with the dispatch `description` and `prompt` from `tool_input`,
and `PostToolUse[Task]` supplies `tool_response` and `duration_ms` for the result preview.

The two signal pairs cannot be joined. `SubagentStartHookInput` carries `agent_id` but no `tool_use_id`,
and the `agent_id` on a `PreToolUse[Task]` payload identifies the *parent* context, not the subagent about to
start. Rather than invent a correlation that the data does not support, the Task tool events are the single
primary source of runs: they carry `tool_use_id` for exact pairing, `tool_input.subagent_type`,
`tool_input.description`, and `tool_input.prompt` on open, and `tool_response` plus `duration_ms` on close.

`SubagentStop` is a secondary, explicitly best-effort signal. It is used to close orphaned runs and to attach
`last_assistant_message` and `agent_transcript_path`, matched to the oldest open run with the same
`(session_id, agent_type)`. That match is a heuristic and is labelled as such in the code; when it is
ambiguous the enrichment is skipped rather than guessed, because a wrong transcript link is worse than none.

A sweeper marks runs `stale` when no close signal arrives within 30 minutes or their parent session ends —
a visibly stale row is better than a spinner that lies indefinitely.

**Retention.** Events older than 7 days are pruned on startup and daily; the window is configurable.

**Degraded mode.** If the hooks are not installed, the agent panel says so and links to `npx agentpanel init`
rather than rendering an empty list that implies nothing is running.

## 8. UI

```
┌ sidebar ────┬ main ───────────────────────┬ right rail ────────┐
│ project ▾   │  Chat (orchestrator)        │ LIVE AGENTS        │
│             │  streaming markdown         │ ● programmer  2m14s│
│ ▸ Chat      │  tool cards (collapsed)     │   terminal · nusa… │
│ ▸ Agents  8 │  agent chips → run detail   │ ● qa          0m31s│
│ ▸ Skills 42 │  permission modal inline    │ ○ reviewer    done │
│ ▸ Activity  │                             │ all sessions       │
└─────────────┴─────────────────────────────┴────────────────────┘
```

Routes: `/` chat · `/agents` · `/agents/new` · `/skills` · `/skills/add` · `/activity` · `/settings`.

- **Chat** — streaming tokens; `tool_use` blocks render as collapsed cards that expand to full input and
  result; `Task` calls render as agent chips linking to the live run.
- **Live rail** — one row per `AgentRun`, status dot, client-side elapsed counter, `terminal` / `dashboard`
  badge, click opens a drawer with the dispatch prompt and result preview.
- **Agents** — cards showing name, description, tools, model, and scope badge (user / project / plugin);
  `Edit` opens the raw `.md`.
- **Skills** — grouped by source, searchable; plugin skills show marketplace and version, with a `Disable`
  action calling `claude plugin disable`.
- **Activity** — historical runs, filterable by project, agent, and status.

Design language: dark-first, dense, monospace for identifiers — a control room, not a marketing page.
Full keyboard navigation, including `⌘K` for the project switcher, and WCAG AA contrast.

## 9. Creation flows

### Add skill — three tabs

| Tab | Flow | Command |
|---|---|---|
| Marketplace | Browse the offline catalog from `~/.claude/plugins/marketplaces/*/.claude-plugin/marketplace.json`, search, inspect inventory, install | `claude plugin install <name>@<marketplace>` |
| Add marketplace | Paste a GitHub repo, URL, or local path; refresh catalog | `claude plugin marketplace add <source>` |
| Create new | Form (name, description, body) scaffolds a skill and writes `SKILL.md` | `claude plugin init <name>` |

### Add agent

Form fields map one-to-one onto agent frontmatter: `name` (kebab-case, uniqueness-checked across all scopes),
`description` (the routing text — labelled as such in the UI), `tools` (multi-select, default inherit-all),
`model` (inherit / opus / sonnet / haiku), `scope` (user or project), and the system-prompt body.

A **Draft with orchestrator** action sends the form intent to the SDK session, which runs the existing
`new-agent` skill and streams a draft back into the form for review. It never writes a file directly.

Both flows preview the exact file content before writing, back up any file they overwrite, and optionally
append a row to a configured `registryFile` (off by default; set to `AGENT_REGISTRY.md` for this machine).

**Command execution.** `claude plugin …` runs through `execFile` with an argv array — never a shell string,
so user input is never interpolated into a command line. Stdout streams to a console pane, with a 60-second
timeout and the exit code surfaced.

**Activation notice.** After any install or creation, the UI states that new skills and agents load on the
next session. The catalog will show the file immediately; the running session will not see it. Leaving this
unsaid would read as a bug.

## 10. Security

The daemon can execute arbitrary code as the user, through Claude. The threat model covers other local
processes, web pages open in the user's browser (CSRF and DNS rebinding), malicious marketplace plugins, and
prompt injection reaching the orchestrator through repository content.

1. **Loopback only.** Binds `127.0.0.1`. A non-loopback bind requires an explicit `--unsafe-bind` flag that
   prints a warning; no config-file path reaches it.
2. **Token on every route**, `/api/hooks` included. A 32-byte random token is generated per daemon start and
   stored in `daemon.json` (mode `0600`). Browsers exchange it once at `/auth?token=…` for an
   `httpOnly; SameSite=Strict` cookie. Hook scripts read it from the file.
3. **Host and Origin validation.** Requests whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>` are
   rejected, which closes DNS rebinding. State-changing routes additionally require a matching `Origin`.
4. **No bypass button.** The default permission mode asks for everything except read-only tools.
   `bypassPermissions` exists only as a config-file value with a startup warning. A public tool should not
   ship a control that disarms the sandbox.
5. **Write confinement.** Catalog writes are limited to `~/.claude/**` and the selected project's
   `.claude/**`. Paths are re-checked after resolution so `..` segments and symlinks cannot escape.
6. **No sharing, tunnels, or remote mode** in v1; any future remote capability needs its own threat model.
7. **Data at rest.** `data.db` is mode `0600`. Tool inputs are stored for the activity view, so common secret
   patterns (`sk-`, `ghp_`, `AKIA`, `PRIVATE KEY`, long hex runs) are redacted before write, and a
   "clear history" action exists.
8. **Supply chain.** Minimal dependencies, committed lockfile, npm publish with provenance. `init` prints
   every file it will modify — `settings.json` included — before touching anything, and is idempotent.

**Documented limitation.** The permission modal is the last line of defense against prompt injection. If a
user enables auto-approval, a poisoned repository file can reach `Bash`. The README states this plainly
rather than implying that a dashboard makes Claude Code safe.

## 11. Testing

Test-driven, with no live token spend in the default suite.

- **Unit** — frontmatter parser; port scanner; run correlator including FIFO fallback and stale sweep; secret
  redaction; path confinement against `..`, symlinks, and post-resolution escapes; catalog scanner.
- **Integration** (`node:test` + `fetch`) — hook POST produces the expected SSE frame; the auth matrix of
  missing token, wrong token, bad `Origin`, bad `Host`, cookie versus bearer; `init` writes `settings.json`
  idempotently without duplicating hook entries.
- **Fake SDK** — `query()` sits behind an interface and is faked in tests, so streaming and `canUseTool` are
  testable offline. A real-SDK smoke test is gated behind `E2E_LIVE=1`.
- **Hook scripts** — fixture payloads captured once from a real session are piped in; assert fail-open
  behaviour when the daemon is down.
- **UI** — vitest and testing-library for the rail, elapsed timer, and permission modal; one Playwright smoke
  test covering send, stream, approve.
- **CI** — Node 22 and 24, on macOS and Ubuntu.

## 12. Milestones

| M | Scope | Standalone value |
|---|---|---|
| M0 | daemon, auth, port scan, SPA shell, `daemon.json` | foundation |
| M1 | catalog scanner, agents and skills pages | useful read-only |
| M2 | hooks, `init` CLI, live rail, activity view | live agent visibility |
| M3 | SDK chat, streaming, permission UI, project switcher | orchestrator chat |
| M4 | add agent, add skill, marketplace browse | authoring |
| M5 | npm publish, README, docs, CI | public release |

## 13. Risks

| Risk | Mitigation |
|---|---|
| `stream-json` and hook payload schemas are unversioned and can change between CLI releases | Pin a tested CLI/SDK version range; validate payload shape at startup and warn loudly on mismatch; keep the JSONL `isSidechain` reader as a fallback |
| ~~Hook payload may not carry `tool_use_id`~~ — RESOLVED 2026-08-18 | Verified required on both `PreToolUse` and `PostToolUse` in the SDK's shipped types. Stale sweeper retained for crashed or killed sessions, which produce no close event at all |
| Daemon crash loses in-flight sessions | Session IDs persisted; reconnect resumes via `--resume` semantics |
| Hooks are global and fire for unrelated projects | Every event is filtered and attributed by `cwd` and `session_id`; the UI scopes to the selected project |
| Uninstall leaves hooks behind | `npx agentpanel uninstall` removes hooks, state directory, and database, and prints what it removed |
| Name confusion with the existing `agentdeck` npm package in an adjacent category | Name chosen as `agentpanel` specifically to avoid it |
