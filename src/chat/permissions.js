// src/chat/permissions.js
//
// The approval gate between an SDK session and the tools it wants to run. This is a security
// boundary, and it fails closed in every direction: an unanswered request denies, an aborted
// session denies, a shutdown denies, an unrecognised decision is refused. The one thing this module
// must never do is return `null` — the SDK reads that as "the host answered out of band" and parks
// the tool call forever with no deadline.
import { randomUUID } from 'node:crypto';

// Read-only tools, auto-allowed so the dashboard is usable at all: without this every question about
// a codebase becomes a dozen approval prompts, and a user who is clicking through prompts to get
// work done is not reading them. Deliberately three, deliberately named — nothing that writes,
// executes, or reaches the network is on this list, and `canUseTool` is only consulted for calls the
// user's own settings did not already decide.
export const AUTO_ALLOW_TOOLS = ['Read', 'Glob', 'Grep'];

export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

const DENY_TIMEOUT = 'No answer in the agentpanel dashboard within the approval window, so the request timed out and the tool was not run. Ask again if you still need it.';
const DENY_ABORTED = 'The session was interrupted before this permission request was answered, so the tool was not run.';
const DENY_CLOSED = 'agentpanel stopped while this permission request was open, so the tool was not run.';
const DENY_USER = 'The user denied this tool call in the agentpanel dashboard.';

const DECISIONS = new Set(['allow', 'deny', 'always']);

export function createPermissionGate({
  hub,
  now = Date.now,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  autoAllow = AUTO_ALLOW_TOOLS,
  newId = randomUUID,
}) {
  const autoAllowed = new Set(autoAllow);
  const pending = new Map();

  function settle(id, decision, result) {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener('abort', entry.onAbort);
    hub.broadcast('permission.resolved', { id, projectPath: entry.projectPath, decision, ts: now() });
    entry.resolve(result);
    return true;
  }

  const deny = (message) => ({ behavior: 'deny', message });

  function request(projectPath, toolName, input, options) {
    const { signal, toolUseID, agentID, decisionReason, title, description } = options ?? {};
    // Already aborted before we got here: broadcasting a request the UI could answer would show the
    // user a prompt for a session that is gone.
    if (signal?.aborted) return Promise.resolve(deny(DENY_ABORTED));

    const id = newId();
    const ts = now();
    return new Promise((resolve) => {
      const onAbort = () => settle(id, 'aborted', deny(DENY_ABORTED));
      const timer = setTimeout(() => settle(id, 'timeout', deny(DENY_TIMEOUT)), timeoutMs);
      timer.unref?.();                          // an open prompt must not hold the process open
      signal?.addEventListener('abort', onAbort, { once: true });

      pending.set(id, {
        id, projectPath, toolName, ts, resolve, timer, signal, onAbort,
        descriptor: { id, projectPath, toolName, toolUseId: toolUseID ?? null, ts },
      });

      hub.broadcast('permission.request', {
        id,
        projectPath,
        toolName,
        // The raw input, not a redacted preview: approving a command you cannot read is not
        // approval. This crosses an authenticated loopback channel only, and what lands in the
        // database is redacted separately.
        input: input ?? {},
        toolUseId: toolUseID ?? null,
        agentId: agentID ?? null,
        reason: decisionReason ?? null,
        title: title ?? null,
        description: description ?? null,
        expiresAt: ts + timeoutMs,
        ts,
      });
    });
  }

  return {
    // One `canUseTool` per project, so a request can never be attributed to — or answered from —
    // another project's session.
    forProject(projectPath) {
      return async (toolName, input, options) => {
        if (autoAllowed.has(toolName)) return { behavior: 'allow' };
        return request(projectPath, toolName, input, options);
      };
    },

    resolve(id, decision) {
      if (!DECISIONS.has(decision)) return { ok: false, reason: 'bad_decision' };
      if (!pending.has(id)) return { ok: false, reason: 'unknown_request' };
      const { toolName } = pending.get(id);
      const result = decision === 'deny'
        ? deny(DENY_USER)
        : decision === 'always'
          // Session scope only. The SDK's own `suggestions` may target userSettings or
          // projectSettings, which would write a permanent rule into the user's files from a single
          // click in a browser tab. "Always" here means "for the rest of this conversation".
          ? { behavior: 'allow', updatedPermissions: [{ type: 'addRules', rules: [{ toolName }], behavior: 'allow', destination: 'session' }] }
          : { behavior: 'allow' };
      settle(id, decision, result);
      return { ok: true };
    },

    // Everything still open for one project — used when a session is interrupted or reset, and to
    // let a reconnecting tab re-render the prompts it missed.
    list(projectPath) {
      const all = [...pending.values()];
      const rows = projectPath === undefined ? all : all.filter((e) => e.projectPath === projectPath);
      return rows.map((e) => e.descriptor);
    },

    abortProject(projectPath) {
      for (const entry of [...pending.values()]) {
        if (entry.projectPath === projectPath) settle(entry.id, 'aborted', deny(DENY_ABORTED));
      }
    },

    close() {
      for (const entry of [...pending.values()]) settle(entry.id, 'closed', deny(DENY_CLOSED));
    },
  };
}
