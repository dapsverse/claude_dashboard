// src/daemon/sweepers.js
//
// The bridge from "that agent is gone" to the run row that still says 'running'.
//
// Two facts used to disagree. The activity feed knew a subagent had been stopped — the office scene
// rendered the word on its speech bubble — while `runs.status` stayed 'running' for the next half
// hour, so the actor kept its desk forever. `runs.endRun` existed for exactly this and nothing ever
// called it. This is the caller.
//
// Liveness is read from two sources, best first:
//
//   1. The SDK's own task_notification. When a dispatched task is stopped, cancelled or fails, the
//      session manager reports the status here with the tool_use_id it belongs to — the same id the
//      PreToolUse hook built the run id from, so this is an exact join and not a guess. It is also
//      the only signal a mid-session stop produces at all: an interrupted subagent never fires the
//      SubagentStop hook that would otherwise close its run.
//
//   2. Silence. A working session touches its row on every hook and, for the sessions whose SDK
//      stream the daemon holds, on every progress message. A run whose session has said nothing for
//      RUN_SILENCE_TIMEOUT_MS is presumed gone.
//
// What this deliberately is NOT is a shorter version of core/sweeper.js. Closing a run because it
// is old kicks out healthy long-lived agents — twenty-minute agents are ordinary in this repo — so
// age never enters the decision here. Only the last sign of life does. The 30-minute age net still
// exists in core/sweeper.js and stays the last resort behind this.

import { runId } from '../core/correlator.js';

// Short on purpose, and to be read against the 30-minute stale window in core/sweeper.js: that one
// gives up waiting, this one already knows. A stopped agent should leave its desk while the user is
// still looking at the screen.
export const LIVENESS_SWEEP_INTERVAL_MS = 15 * 1000;

// How long a run's session may say nothing before the run is presumed dead. The trade-off, stated
// rather than hidden: a session driven from an outside terminal gives us no SDK stream, so hooks are
// its only heartbeat, and a subagent sitting inside one very long tool call emits none — such an
// agent can be closed while it is still alive. Five minutes is the compromise between that and
// leaving a killed agent on screen. Source 1 above needs none of this and closes a stopped agent
// within one sweep; this window only covers the deaths nobody reported.
export const RUN_SILENCE_TIMEOUT_MS = 5 * 60 * 1000;

// Terminal statuses that mean the agent is not coming back. A completed task is left out on
// purpose: its SubagentStop is on the way with a real duration and result, and closing it here
// would overwrite that with the word 'interrupted'.
const DEAD_TASK_STATUSES = new Set([
  'stopped', 'cancelled', 'canceled', 'interrupted', 'aborted', 'killed', 'failed', 'error', 'timed_out',
]);

export function sweepDeadRuns({
  runs, sessions, hub, now = Date.now,
  interval = LIVENESS_SWEEP_INTERVAL_MS,
  silenceMs = RUN_SILENCE_TIMEOUT_MS,
}) {
  // sessionId -> when that session last gave any sign of life. In memory rather than on the sessions
  // row because progress messages arrive many times a minute, and the row only has to survive a
  // restart, not every tick.
  const lastSeen = new Map();
  // runId -> { status, at } for an ending the SDK has already reported. Recorded rather than acted
  // on immediately, so the sweep stays the single place that closes rows and broadcasts.
  const reported = new Map();
  // Nothing observed before this process started counts as silence: on a restart the heartbeats are
  // empty, and without this floor every run open at boot would be swept on the first tick.
  const bootedAt = now();

  let handle = null;
  let sweeping = false;

  // The SDK reports the Task's tool_use_id; the run id is `${sessionId}:${toolUseId}`. The exact key
  // is kept even when no row carries it yet — PreToolUse and PostToolUse race, so the row can be a
  // millisecond behind, and a later pass will find it. The suffix scan is the fallback for a status
  // that arrives before `system/init` said which session id we are on; a tool_use_id is unique on
  // its own, so it cannot collide with another agent's run.
  function resolveRunId(sessionId, toolUseId) {
    if (typeof toolUseId !== 'string' || toolUseId === '') return null;
    if (typeof sessionId === 'string' && sessionId !== '') return runId(sessionId, toolUseId);
    const suffix = `:${toolUseId}`;
    return runs.listActive().find((run) => run.id.endsWith(suffix))?.id ?? null;
  }

  // Every activity message a live session emits, whatever it says. The heartbeat is the point; the
  // task_notification branch is the exact signal layered on top of it.
  function noteActivity({ sessionId, kind, data } = {}) {
    if (typeof sessionId === 'string' && sessionId !== '') lastSeen.set(sessionId, now());
    if (kind !== 'task_notification') return;
    const status = typeof data?.status === 'string' ? data.status.toLowerCase() : null;
    if (status === null || !DEAD_TASK_STATUSES.has(status)) return;
    const id = resolveRunId(sessionId, data?.toolUseId);
    if (id !== null) reported.set(id, { status, at: now() });
  }

  function deadReason(run, t) {
    if (reported.has(run.id)) return 'interrupted';
    const session = run.sessionId == null ? null : sessions.get(run.sessionId);
    // The session declared itself over. Whatever it dispatched is orphaned, whatever the clock says.
    if (session?.status === 'ended') return 'session_ended';
    // Age is deliberately absent from this line. The only input is when this run's session was last
    // heard from, floored by the run's own start and by boot so a fresh row is never judged on an
    // empty heartbeat.
    const beat = Math.max(
      run.startedAt ?? 0,
      session?.lastEventAt ?? 0,
      lastSeen.get(run.sessionId) ?? 0,
      bootedAt,
    );
    return t - beat > silenceMs ? 'interrupted' : null;
  }

  // Exposed so the suite can drive a whole cycle without a real timer. Returns the ids it closed,
  // which is what makes idempotence testable: a second call over the same rows returns nothing,
  // because endRun refuses a run that is no longer open.
  function sweep(t = now()) {
    const closed = [];
    for (const run of runs.listActive()) {
      const reason = deadReason(run, t);
      if (reason === null) continue;
      // One run.close per row, the same shape hooks.js broadcasts for a session that ended: the
      // dashboard keys everything it renders by run id and drops a payload without one.
      if (runs.endRun(run.id, t, reason)) {
        closed.push(run.id);
        hub.broadcast('run.close', runs.get(run.id));
      }
      reported.delete(run.id);
    }
    // A reported ending whose row never appeared at all. Forgotten once it is older than the silence
    // window, so a daemon left running for weeks does not accumulate keys for phantom runs.
    for (const [id, entry] of reported) {
      if (t - entry.at > silenceMs) reported.delete(id);
    }
    return closed;
  }

  return {
    noteActivity,
    sweep,
    start() {
      if (handle !== null) return handle;
      tick();
      handle = setInterval(tick, interval);
      // Never the reason the process stays up: the daemon is held open by its listening server.
      handle.unref?.();
      return handle;
    },
    stop() {
      if (handle === null) return;
      clearInterval(handle);
      handle = null;
    },
  };

  function tick() {
    if (sweeping) return;                       // no overlapping sweeps
    sweeping = true;
    // A throw here would land on a timer callback and, under Node's default settings, take the
    // daemon down with it. Nothing this sweep does is worth that.
    try { sweep(now()); }
    catch (err) { process.emitWarning(`dead-run sweep failed: ${err?.message ?? err}`); }
    finally { sweeping = false; }
  }
}
