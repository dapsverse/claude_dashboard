#!/usr/bin/env bash
# Forwards one Claude Code hook payload to the agentpanel daemon.
# Contract: always exit 0, never write to stdout. Claude Code injects SessionStart
# stdout into the model's context, and a non-zero exit shows a hook error in the transcript.
set -u

# Drain stdin FIRST, before any early exit. Claude Code writes the payload to this script's stdin, and
# exiting without reading it hands the writer an EPIPE once the payload exceeds the pipe buffer. The
# most common state of all — daemon.json absent because the daemon has not started yet — must not be
# the one that breaks the caller.
payload="$(cat)"

runtime="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/agentpanel/daemon.json"
[ -r "$runtime" ] || exit 0
[ -n "$payload" ] || exit 0

port="$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$runtime" | head -1)"
token="$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([0-9a-f]*\)".*/\1/p' "$runtime" | head -1)"
[ -n "$port" ] && [ -n "$token" ] || exit 0

# The token never appears in a command line. `-H "Authorization: Bearer $token"` would put it in
# curl's argv, and /proc/<pid>/cmdline is world-readable on Linux — with this hook firing on every
# SessionStart, Agent dispatch, SubagentStop and SessionEnd, that window reopens constantly. curl
# reads the header from a config file on a pipe instead; `printf` is a bash builtin, so no process
# anywhere in this pipeline is exec'd with the token among its arguments. The `token` extraction
# above matches hex only, so no value can escape the quoted config line.
printf '%s' "$payload" | curl -sS -o /dev/null --max-time 1 \
  -K <(printf 'header = "Authorization: Bearer %s"\n' "$token") \
  -X POST "http://127.0.0.1:${port}/api/hooks" \
  -H "Content-Type: application/json" \
  --data-binary @- >/dev/null 2>&1

exit 0
