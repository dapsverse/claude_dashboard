// src/store/runs.js
const toRun = (r) => r == null ? null : ({
  id: r.id, sessionId: r.session_id, agentType: r.agent_type, description: r.description,
  prompt: r.prompt, status: r.status, startedAt: r.started_at, endedAt: r.ended_at,
  durationMs: r.duration_ms, resultPreview: r.result_preview, transcriptPath: r.transcript_path,
  agentId: r.agent_id ?? null,
  stopReason: r.stop_reason ?? null, dismissedAt: r.dismissed_at ?? null,
  // Joined from the session that dispatched the run, not stored on the row: the cwd belongs to the
  // session, and denormalising it would give the same fact two places to disagree.
  projectPath: r.project_path ?? null,
});

export function createRunsRepo(db) {
  // An upsert rather than `INSERT OR IGNORE`, because this hook does not reliably arrive first. A
  // background dispatch's PostToolUse can beat its PreToolUse to the daemon — they are two separate
  // hook processes and for an async launch they fire a millisecond apart — and `launch` now creates
  // the row when it does. Ignoring the insert would leave that row without a type, a description or
  // a prompt for the rest of its life.
  //
  // Every detail COALESCEs the existing value first, so this stays as idempotent as the plain IGNORE
  // was: a replayed hook overwrites nothing, and only the blanks a raced launch left get filled.
  // started_at takes the earlier of the two — PreToolUse is when the run really began, and the
  // clock cannot be allowed to jump forward on the row.
  const insert = db.prepare(`INSERT INTO runs
    (id, session_id, agent_type, description, prompt, status, started_at)
    VALUES (?, ?, ?, ?, ?, 'running', ?)
    ON CONFLICT(id) DO UPDATE SET
      agent_type  = COALESCE(runs.agent_type, excluded.agent_type),
      description = COALESCE(runs.description, excluded.description),
      prompt      = COALESCE(runs.prompt, excluded.prompt),
      started_at  = MIN(runs.started_at, excluded.started_at)`);
  // `stale` is accepted alongside `running`: a run staled by the 30-minute sweeper or by SessionEnd
  // may still finish for real afterwards, and the genuine PostToolUse must be allowed to overwrite the
  // guess with the actual status, duration, and result. Long-running agents are the normal case here.
  // That recovery is also why stop_reason is cleared here: it only ever held a guess about why nobody
  // reported for this run, and leaving a 'swept' on a row that has now finished for real would be a
  // lie the rail renders beside a completed result.
  const closeStmt = db.prepare(`UPDATE runs
    SET status = ?, ended_at = ?, duration_ms = ?, result_preview = ?, agent_id = COALESCE(?, agent_id),
        stop_reason = NULL
    WHERE id = ? AND status IN ('running', 'stale')`);
  // Only ever applied to a run that is still open: a background dispatch records who to expect a
  // SubagentStop from, and a row that already finished has nothing left to wait for.
  const launchStmt = db.prepare("UPDATE runs SET agent_id = ? WHERE id = ? AND status = 'running'");
  // The same write, but able to create the row it is meant to be updating. This one exists because a
  // bare UPDATE silently dropped the agent id whenever PostToolUse beat PreToolUse to the daemon —
  // two racing hook processes, a millisecond apart for an async dispatch — and that id is the only
  // exact join between a launch and the SubagentStop that ends it. Losing it left the run `running`
  // until the 30-minute sweeper and sent its result to whichever row the fallback heuristic picked.
  // The DO UPDATE keeps its `status = 'running'` guard, so a finished run is still refused.
  const launchUpsertStmt = db.prepare(`INSERT INTO runs (id, session_id, status, started_at, agent_id)
    VALUES (?, ?, 'running', ?, ?)
    ON CONFLICT(id) DO UPDATE SET agent_id = excluded.agent_id
    WHERE runs.status = 'running'`);
  const byAgentStmt = db.prepare("SELECT * FROM runs WHERE agent_id = ? AND status = 'running' ORDER BY started_at ASC LIMIT 1");
  // Every read of a whole run goes through this projection, so `projectPath` is present on every row
  // the daemon hands out — the live rail scopes itself by it, and a row that arrived by broadcast
  // must carry the same field as one that came from the snapshot.
  const SELECT_RUN = `SELECT r.*, s.project_path FROM runs r LEFT JOIN sessions s ON s.id = r.session_id`;
  const getStmt = db.prepare(`${SELECT_RUN} WHERE r.id = ?`);
  const activeStmt = db.prepare(`${SELECT_RUN} WHERE r.status = 'running' ORDER BY r.started_at DESC`);
  // A dismissed row is gone for good from the snapshot the dashboard loads with. This is the half
  // of "Clear finished" that used to be missing: the rail dropped the rows locally and the very next
  // reload served them straight back.
  const recentStmt = db.prepare(`${SELECT_RUN} WHERE r.dismissed_at IS NULL ORDER BY r.started_at DESC LIMIT ?`);
  // duration_ms is set alongside ended_at: the UI reads durationMs for a finished row, so a staled run
  // that only had ended_at rendered as `0s` — indistinguishable from a run that never started.
  // The reason is COALESCEd rather than assigned: something may already know exactly why this run
  // stopped — the session that dispatched it died with its rate limit exhausted — and the sweeper
  // arriving half an hour later knows strictly less, so the first reason recorded stands.
  const staleStmt = db.prepare(`UPDATE runs
    SET status = 'stale', ended_at = ?, duration_ms = MAX(0, ? - started_at),
        stop_reason = COALESCE(stop_reason, 'swept')
    WHERE status = 'running' AND started_at < ?`);
  const endSessionStmt = db.prepare(`UPDATE runs
    SET status = 'stale', ended_at = ?, duration_ms = MAX(0, ? - started_at),
        stop_reason = COALESCE(stop_reason, ?)
    WHERE status = 'running' AND session_id = ?`);
  // A known interruption ends just this run, even if the sweeper already guessed it was stale.
  // Replace the guessed timing and clear its stop reason; the caller's reason becomes the result.
  // COALESCE preserves an existing preview if the reason is explicitly null; the status guard makes
  // retries leave the first ending intact and report no change for the caller to broadcast.
  const endRunStmt = db.prepare(`UPDATE runs
    SET status = 'done', ended_at = ?, duration_ms = MAX(0, ? - started_at),
        result_preview = COALESCE(?, result_preview), stop_reason = NULL
    WHERE id = ? AND status IN ('running', 'stale')`);
  const sessionOpenIdsStmt = db.prepare("SELECT id FROM runs WHERE status = 'running' AND session_id = ?");
  // `agent_id IS NULL` is what keeps the heuristic away from a background run: that one was launched
  // with an exact id and can only be matched by it, so guessing here would attach one agent's
  // transcript to another agent that is still working.
  const oldestMatchStmt = db.prepare(`SELECT id FROM runs
    WHERE status = 'running' AND session_id = ? AND agent_type = ? AND agent_id IS NULL
    ORDER BY started_at ASC LIMIT 1`);
  const enrichStmt = db.prepare('UPDATE runs SET transcript_path = ?, result_preview = COALESCE(?, result_preview) WHERE id = ?');
  // `status != 'running'` is load-bearing and not merely tidy: it must be impossible to hide an
  // agent that is genuinely still working, however the request is shaped. A rail that can be made to
  // drop a live run is worse than one that shows a row too many. `dismissed_at IS NULL` makes a
  // repeated request report nothing the second time, so the broadcast fires once.
  const dismissStmt = db.prepare(`UPDATE runs SET dismissed_at = ?
    WHERE id = ? AND status != 'running' AND dismissed_at IS NULL`);
  const pruneStmt = db.prepare("DELETE FROM runs WHERE status != 'running' AND COALESCE(ended_at, started_at) < ?");

  return {
    open({ id, sessionId, agentType, description, prompt, startedAt }) {
      insert.run(id, sessionId, agentType ?? null, description ?? null, prompt ?? null, startedAt);
    },
    close({ id, status, endedAt, durationMs, resultPreview, agentId }) {
      const row = getStmt.get(id);
      if (!row) return false;
      // A clock step backwards (NTP correction, VM resume) must not store a negative duration.
      const duration = durationMs ?? Math.max(0, endedAt - row.started_at);
      const result = closeStmt.run(status, endedAt, duration, resultPreview ?? null, agentId ?? null, id);
      // Report the state transition, not merely the row's existence: the UPDATE ignores an already
      // finished row, so a replayed close changes nothing and must not make the caller broadcast a
      // second run.close for a run that already finished.
      return result.changes > 0;
    },
    // A background dispatch: the tool returned, the agent did not. Recording its id is all this
    // does — the run stays running, because it is, and SubagentStop closes it later.
    //
    // Creates the row when it is not there yet, which is the fix for the hook ordering race. Falls
    // back to the plain UPDATE when there is nothing worth creating a row for: without an agent id
    // there is no join to preserve, and without a session and a start time a row cannot be made at
    // all — session_id is NOT NULL, and a guessed start time would show a wrong elapsed clock.
    launch({ id, agentId, sessionId = null, startedAt = null }) {
      if (agentId == null || sessionId == null || startedAt == null) {
        return launchStmt.run(agentId ?? null, id).changes > 0;
      }
      return launchUpsertStmt.run(id, sessionId, startedAt, agentId).changes > 0;
    },

    /**
     * One subagent stopped. Closes the background run whose `agent_id` matches — the exact key it
     * was launched with — and otherwise falls back to enriching the oldest foreground run of the
     * same type, which its own PostToolUse is about to close with better data.
     *
     * Returns `{ id, closed }`, or null when nothing could be matched without guessing.
     */
    finish({ agentId, sessionId, agentType }, { endedAt, transcriptPath, resultPreview }) {
      const launched = agentId == null ? null : byAgentStmt.get(agentId);
      if (launched) {
        closeStmt.run('done', endedAt, Math.max(0, endedAt - launched.started_at), resultPreview ?? null, agentId, launched.id);
        if (transcriptPath != null) enrichStmt.run(transcriptPath, null, launched.id);
        return { id: launched.id, closed: true };
      }
      const id = agentType == null ? null : this.enrich({ sessionId, agentType }, { transcriptPath, resultPreview });
      return id === null ? null : { id, closed: false };
    },

    enrich({ sessionId, agentType }, { transcriptPath, resultPreview }) {
      const hit = oldestMatchStmt.get(sessionId, agentType);
      if (!hit) return null;                      // ambiguous or absent: skip rather than guess
      enrichStmt.run(transcriptPath ?? null, resultPreview ?? null, hit.id);
      return hit.id;
    },
    get(id) { return toRun(getStmt.get(id)); },
    // No dismissal filter here, and none is needed: dismissing refuses a running row, so a row this
    // returns has never been dismissed.
    listActive() { return activeStmt.all().map(toRun); },
    listRecent(limit = 100) { return recentStmt.all(limit).map(toRun); },
    markStaleBefore(cutoffTs, now) { staleStmt.run(now, now, cutoffTs); },
    // Returns the ids it staled. The caller has to broadcast one run.close per row: a bare
    // `{sessionId}` event carries no run id, and the dashboard has no way to match it to the rows it
    // is rendering — the rail would keep ticking for a run that ended until the page is reloaded.
    // `reason` is what the caller knows about the ending that the row itself never will: a session
    // that ended cleanly leaves 'session_ended', one killed by an exhausted rate limit leaves
    // 'rate_limit', and the rail can finally say which rather than showing a half-hour-old STALE.
    endSessionRuns(sessionId, now, reason = 'session_ended') {
      const ids = sessionOpenIdsStmt.all(sessionId).map((r) => r.id);
      endSessionStmt.run(now, now, reason ?? null, sessionId);
      return ids;
    },
    // The caller broadcasts run.close only when this single run actually transitions to done.
    endRun(runId, now, reason = 'stopped') {
      return endRunStmt.run(now, now, reason ?? null, runId).changes > 0;
    },
    /**
     * Clears finished rows out of the live rail for good. Returns only the ids it actually
     * dismissed, so the caller broadcasts the rows that really changed and stays silent otherwise.
     */
    dismiss(ids, at) {
      if (!Array.isArray(ids)) return [];
      const done = [];
      for (const id of ids) {
        // node:sqlite throws on a value it cannot bind, and one stray entry must not cost the user
        // every other row they asked to clear.
        if (typeof id !== 'string') continue;
        if (dismissStmt.run(at, id).changes > 0) done.push(id);
      }
      return done;
    },
    pruneBefore(ts) { pruneStmt.run(ts); },
  };
}
