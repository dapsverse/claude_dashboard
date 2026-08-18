// src/cli/hook-config.js
import { join } from 'node:path';

export const OUR_MARKER = 'agentpanel';
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
    let strippedAny = false;
    // A group we do not recognise — a bare handler object, null, anything without a `hooks` array —
    // belongs to the user or another tool. Pass it through untouched. Coercing it to an empty group
    // would silently delete configuration we did not write, which is the one thing this must never do.
    const isGroup = (g) => g && typeof g === 'object' && Array.isArray(g.hooks);
    const groups = (hooks[event] ?? [])
      .map((group) => {
        if (!isGroup(group)) return group;
        const kept = group.hooks.filter((h) => {
          if (isOurs(h)) { strippedAny = true; return false; }
          return true;
        });
        return { ...group, hooks: kept };
      })
      .filter((group) => !isGroup(group) || group.hooks.length > 0);

    if (strippedAny) removed.push(event);

    if (!remove && fresh[event]) {
      groups.push(...structuredClone(fresh[event]));
      added.push(event);
    }

    if (groups.length > 0) hooks[event] = groups;
    else delete hooks[event];
  }

  return { hooks, added, removed };
}
