# agentpanel

A local dashboard for [Claude Code](https://docs.claude.com/en/docs/claude-code): it watches every
Claude Code session on your machine through hooks, and shows subagents as they dispatch and finish
in a live rail, alongside a catalog of every agent and skill available to you — with the scope
(user, project, or plugin) each one comes from.

![agentpanel dashboard showing the live agent rail](https://raw.githubusercontent.com/dapsverse/claude_dashboard/main/docs/assets/screenshot.png)

## Install

macOS and Linux. Node 22.13 or newer.

```
npm install -g agentpanel
agentpanel init
```

**Install it globally — not through `npx`.** `init` writes the *absolute paths* of the two hook
scripts into `~/.claude/settings.json`, and Claude Code runs those paths on every session. Under
`npx` they point into `~/.npm/_npx/<hash>/node_modules/agentpanel`, a cache directory that
`npm cache clean` deletes and that a new version re-hashes to a different name. When it goes, the
hooks stop firing with no error anywhere — the dashboard simply never starts again. `init` warns you
if it notices it is running from there.

`init` prints exactly what it is about to change — which hook events it will add to
`~/.claude/settings.json`, and the one file it writes to `~/.claude/commands/` — and writes nothing
until you confirm:

```
agentpanel init --yes
```

Before its first edit it backs up your existing `settings.json` to
`settings.json.agentpanel-backup`. That backup is written once and never overwritten, so running
`init` again cannot replace your pre-install file with one that already contains agentpanel's hooks.
From the next Claude Code session onward (in any directory whose workspace trust prompt you have
accepted — see below), the daemon starts itself and `agentpanel open` shows the dashboard.

To remove everything `init` added:

```
agentpanel uninstall
```

`uninstall` stops the running daemon first — it has to, since the file that records the daemon's pid
lives in the state directory it is about to delete — then restores `settings.json` to its pre-install
state (aside from formatting) and deletes the state directory: the runtime file, the log, and the
database. If the daemon will not exit, uninstall says so and prints the pid rather than claiming
success. One thing it deliberately does not remove: the `settings.json.agentpanel-backup` file. That
backup is your safety net for a tool that rewrites your settings, so uninstall only reports its path
(if it exists) rather than deleting it — removing it afterward is your call.

## Commands

| Command                | What it does                                                          |
|-------------------------|------------------------------------------------------------------------|
| `agentpanel init`       | Installs the five hooks that feed the dashboard, plus the `/dashboard` command. Requires `--yes` to write. |
| `agentpanel start`      | Starts the daemon by hand (normally the `SessionStart` hook does this). |
| `agentpanel stop`       | Stops the running daemon.                                             |
| `agentpanel status`     | Reports whether a daemon is running, and on which port.                |
| `agentpanel open`       | Opens the dashboard in your default browser, and prints its token URL. |
| `agentpanel dashboard`  | Starts the daemon if needed, then opens the browser. Prints no token — this is what `/dashboard` runs. |
| `agentpanel uninstall`  | Removes the hooks, the `/dashboard` command, the state directory, and the database. |

### `/dashboard`

`init` also writes `~/.claude/commands/dashboard.md`, so from the next Claude Code session you can
open the dashboard without leaving the terminal:

```
/dashboard
```

It starts the daemon if it is not running, opens your browser already signed in, and reports the
port. It deliberately **does not print the sign-in URL**: that URL carries a live token for a server
that can approve tool calls, and a slash command's output is read back into the session and written
to that session's transcript on disk. Use `agentpanel open` in a plain terminal when you actually
want the URL.

If you already have a `/dashboard` command of your own, `init` leaves it alone, says so, and installs
the hooks anyway. `uninstall` removes only a command file carrying agentpanel's own marker — never
one you wrote.

## Security

- The daemon binds `127.0.0.1` only, and every route except `/api/health` requires a bearer token
  read from a `0600` file. It is never reachable from the network, on purpose. Requests must also
  carry a loopback `Host` header and, if they carry an `Origin` at all, agentpanel's own — reads
  included, not only writes.

- **The dashboard cookie is visible to every other server on `127.0.0.1` in the same browser
  profile.** Cookies are scoped by host, not by port: once you open the dashboard, the browser
  attaches `agentpanel_token` to requests it makes to *any* `127.0.0.1` port — a project dev server,
  something an `npm postinstall` started. That server sees the token in the request it receives.
  agentpanel rejects requests carrying a foreign `Origin`, which stops a page on another local port
  from calling the daemon through your browser, but it cannot stop the header being sent in the first
  place while `EventSource` has no way to send a bearer token. If that matters to you: use a separate
  browser profile for the dashboard, or run `agentpanel stop` when you are not looking at it.

- The hook path never puts the token on a command line: the hook script hands it to `curl` through a
  config file on a pipe rather than `-H`, because `/proc/<pid>/cmdline` is world-readable on Linux and
  the hook fires on every session start, agent dispatch, subagent stop and session end. The state
  directory is `0700` and the daemon's log `0600`; `agentpanel start` prints the token-bearing URL
  only when stdout is a terminal, never into the log it writes when the `SessionStart` hook starts it
  detached. **`agentpanel open` does not get the same treatment**: it execs the platform opener
  (`open` on macOS, `xdg-open` on Linux) with the token-bearing URL as an argument, because neither
  opener has a way to receive a URL that isn't argv, and each in turn launches the browser with that
  same URL as one of *its* arguments. On Linux that means the token sits in the browser process's own
  `/proc/<pid>/cmdline` for as long as that browser process runs — not just for the moment `open`/
  `xdg-open` executes, and longer than the curl-through-a-hook case above, which only exists for the
  duration of one hook invocation. There is no reliable cross-platform way to hand a URL to `open` or
  `xdg-open` without argv, so if this matters to you: close the tab agentpanel opened once you are
  done with it, or open the printed URL yourself in a private/incognito window you control the
  lifetime of.

- **Hooks run shell commands with your full user permissions.** This is Claude Code's own warning,
  not ours, and it is worth repeating in full:

  > Command hooks execute shell commands with your full user permissions. They can modify, delete,
  > or access any files your user account can access. Review and test all hook commands before
  > adding them to your configuration.

  `agentpanel init` installs exactly two scripts (`hooks/agentpanel-hook.sh` and
  `hooks/agentpanel-bootstrap.sh`), both in this repository, both short enough to read before you
  trust them.

- Claude Code withholds hooks in a directory whose workspace trust prompt you have not accepted, so
  the dashboard will not autostart there — nothing shows up until you trust the workspace. That is
  Claude Code's behaviour, not an agentpanel bug.

- agentpanel's hook payloads include prompts and tool output. agentpanel stores what it receives in
  `~/.claude/agentpanel/data.db` and redacts secret-shaped strings — private keys, provider API
  tokens, JWTs, long hex digests — before writing. Redaction is pattern-based and cannot be
  complete: it catches the shapes it knows, nothing more. One consequence worth knowing: a private
  key captured without its closing `-----END ... PRIVATE KEY-----` marker causes everything after
  the `BEGIN` marker to be redacted, because a truncated capture has no reliable end to stop at, and
  redacting too much is the safe failure here. agentpanel has no telemetry and no server of its
  own: it never sends anything anywhere on its own account, and the observability half — hooks,
  catalog, live rail — makes no network call at all beyond the loopback ones between the hook
  scripts, the daemon, and your browser.

- **The orchestrator chat does reach Anthropic, because that is what a Claude session is.** When you
  send a message from the dashboard the daemon runs a Claude Agent SDK session on your machine, and
  that session talks to the Anthropic API exactly as `claude` in your terminal does, under the same
  login. It loads *your* configuration — `settingSources: ['user', 'project', 'local']`, so your
  CLAUDE.md, agents, skills and plugins are all in play. Tool calls the session cannot decide on its
  own stop at an approval prompt in the dashboard; an unanswered prompt is denied, never allowed, and
  the session never runs in `bypassPermissions` mode. Read-only `Read`, `Glob` and `Grep` calls are
  auto-approved so ordinary questions do not become a wall of prompts. Claude Code's own policy layer
  sits above this gate and may settle some calls before agentpanel is consulted, in either direction.

## Dependencies

One runtime dependency: [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk),
which is what runs the orchestrator chat's session (it brings `@anthropic-ai/sdk`,
`@modelcontextprotocol/sdk` and `zod` as peers). Everything else the daemon does — HTTP, SSE,
SQLite, the hook path, the catalog scanner — is Node's standard library. React and Vite are
devDependencies; the dashboard ships prebuilt in `dist/ui`.

## Not in this release

This is Plan 1 plus the daemon half of Plan 2's orchestrator chat: hooks, the daemon, the catalog,
the live rail, and the HTTP/SSE surface an SDK session and its approval gate are driven through. The
chat *interface* — the message view, the approval prompts, the project switcher — is still being
built, along with agent creation, skill installation, and marketplace browsing. If you were
expecting to talk to Claude from this dashboard, that is coming — it is not missing by accident.

## Development

```
npm install
npm test          # node's built-in test runner, including an end-to-end smoke test
npm run test:ui    # vitest, for the React dashboard
npm run build:ui   # bundles the dashboard into dist/ui
```

`npm test` includes `test/e2e/smoke.test.js`, which drives the real hook script
(`hooks/agentpanel-hook.sh`) against a real daemon over HTTP — the only test that proves the shell
script, the HTTP route, the correlator, and the store all agree with each other.

The chat suite runs against a fake SDK, so `npm test` never spends a token or touches the network.
The two tests that drive the real Claude Agent SDK are opt-in:

```
E2E_LIVE=1 node --test test/chat/live.test.js
```

Run those from a shell that is not itself inside a Claude Code session — a child session inherits
the parent's permission behaviour through the environment, and the approval test would then pass
for the wrong reason.

Publishing is done from CI, never from a laptop: `.github/workflows/release.yml` runs both suites
and the UI build, then `npm publish --provenance --access public` on a published GitHub release,
authenticated by the `NPM_TOKEN` repository secret. Provenance ties the published tarball to that
workflow run and commit, which a laptop publish cannot do.

`vite dev` proxies `/api` and `/auth` to a daemon on port 8888 (set `AGENTPANEL_DEV_PORT` if
`agentpanel status` reports another one). Authenticate the dev session once by opening
`http://localhost:5173/auth?token=<the token from agentpanel open>`.

## License

MIT — see [LICENSE](LICENSE).
