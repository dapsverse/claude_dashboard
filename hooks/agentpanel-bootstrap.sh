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
