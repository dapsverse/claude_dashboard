#!/usr/bin/env bash
# SessionStart: start the agentpanel daemon if it is not already running, then get out of the way.
# Contract: always exit 0, never write to stdout.
set -u

claude_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
state_dir="${claude_dir}/agentpanel"
runtime="${state_dir}/daemon.json"
logfile="${state_dir}/daemon.log"

cat >/dev/null   # drain stdin so Claude Code never blocks writing the payload

if [ -r "$runtime" ]; then
  pid="$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$runtime" | head -1)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then exit 0; fi
fi

entry="$(cd "$(dirname "$0")/.." && pwd)/bin/agentpanel.js"
[ -f "$entry" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0

# This directory holds the daemon's token, its database of prompts, and its log. Create it 0700 from
# the start: `mkdir -p` ignores the mode for a directory that already exists, so a directory made
# world-readable once stays that way, and the daemon re-asserts these modes on startup for exactly
# that case. The umask also applies to everything the daemon itself creates below.
umask 077
mkdir -m 700 -p "$state_dir"
: >>"$logfile"                        # 0600 under the umask above when it does not exist yet
chmod 600 "$logfile" 2>/dev/null      # ...and when a laxer version of this script created it

nohup node --disable-warning=ExperimentalWarning "$entry" start \
  >>"$logfile" 2>&1 &

exit 0
