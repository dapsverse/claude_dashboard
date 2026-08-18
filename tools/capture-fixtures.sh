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
