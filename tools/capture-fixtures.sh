#!/usr/bin/env bash
# Captures real hook stdin payloads WITHOUT touching ~/.claude/settings.json.
# Uses an isolated settings file passed via `claude --settings`.
#
# Usage: tools/capture-fixtures.sh [destination-dir]
#
# The captures contain your real prompts and tool output. They are written to a directory you name
# (default ./captured-fixtures), never left behind in the OS temp directory, and must be redacted by
# hand before anything is copied into test/fixtures/hooks/.
set -euo pipefail

# Resolved before the `cd` below: a relative destination must land beside the caller, not inside the
# temp directory this script deletes on the way out.
DEST="${1:-captured-fixtures}"
case "$DEST" in /*) ;; *) DEST="$PWD/$DEST" ;; esac
OUT="$(mktemp -d)"
# Whatever happens — a failed run, ^C, a `claude` that never dispatched anything — the raw captures
# do not stay in a world-traversable temp directory.
trap 'rm -rf "$OUT"' EXIT INT TERM

cat > "$OUT/settings.json" <<JSON
{
  "hooks": {
    "SessionStart":  [{ "hooks": [{ "type": "command", "command": "cat > $OUT/session-start.json" }] }],
    "SessionEnd":    [{ "hooks": [{ "type": "command", "command": "cat > $OUT/session-end.json" }] }],
    "SubagentStop":  [{ "hooks": [{ "type": "command", "command": "cat > $OUT/subagent-stop.json" }] }],
    "PreToolUse":    [{ "matcher": "Agent|Task", "hooks": [{ "type": "command", "command": "cat > $OUT/pre-tool-use-task.json" }] }],
    "PostToolUse":   [{ "matcher": "Agent|Task", "hooks": [{ "type": "command", "command": "cat > $OUT/post-tool-use-task.json" }] }]
  }
}
JSON

# The dispatch tool is named `Agent` on some Claude Code builds and `Task` on others — the matcher
# above accepts either, and the prompt asks for the behaviour rather than one build's tool name.
cd "$OUT"
claude --settings "$OUT/settings.json" -p \
  "Dispatch one Explore subagent with the prompt 'echo hello and stop'. Then stop."

mkdir -p "$DEST"
chmod 700 "$DEST"
cp "$OUT"/*.json "$DEST"/ 2>/dev/null || true
rm -f "$DEST/settings.json"
chmod 600 "$DEST"/*.json 2>/dev/null || true
echo "captured to $DEST"
ls -la "$DEST"
echo "These hold real prompts and tool output. Redact them before copying into test/fixtures/hooks/."
