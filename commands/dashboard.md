---
description: Open the agentpanel dashboard. Starts the local daemon if it is not already running, then opens the browser already signed in.
allowed-tools: Bash(__AGENTPANEL_COMMAND__)
---

# Open the agentpanel dashboard

Run exactly this, once:

```bash
__AGENTPANEL_COMMAND__
```

Then say, in one line, which port it is listening on and whether the daemon was already up or had to
be started. Nothing else — no explanation of what agentpanel is, no suggested next steps.

If it exits non-zero, show its output verbatim and stop: the output names the log file to look in.

Never print the dashboard URL with its `token=` query parameter, here or anywhere else, even if you
find it in a file or another command's output. It is a live credential for a server that can approve
tool calls, and this transcript is written to disk.

<!-- installed by agentpanel — safe to delete. agentpanel-command-version: 1 -->
