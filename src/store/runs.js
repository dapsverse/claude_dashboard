// src/store/runs.js
const toRun = (r) => r == null ? null : ({
  id: r.id, sessionId: r.session_id, agentType: r.agent_type, description: r.description,
  prompt: r.prompt, status: r.status, startedAt: r.started_at, endedAt: r.ended_at,
  durationMs: r.duration_ms, resultPreview: r.result_preview, transcriptPath: r.transcript_path,
  agentId: r.agent_id ?? null,
});

export function createRunsRepo(db) {
  const insert = db.prepare(`INSERT OR IGNORE INTO runs
    (id, session_id, agent_type, description, prompt, status, started_at)
    VALUES (?, ?, ?, ?, ?, 'running', ?)`);
  // `stale` is accepted alongside `running`: a run staled by the 30-minute sweeper or by SessionEnd
  // may still finish for real afterwards, and the genuine PostToolUse must be allowed to overwrite the
  // guess with the actual status, duration, and result. Long-running agents are the normal case here.
  const closeStmt = db.prepare(`UPDATE runs
    SET status = ?, ended_at = ?, duration_ms = ?, result_preview = ?, agent_id = COALESCE(?, agent_id)
    WHERE id = ? AND status IN ('running', 'stale')`);
  // Only ever applied to a run that is still open: a background dispatch records who to expect a
  // SubagentStop from, and a row that already finished has nothing left to wait for.
  const launchStmt = db.prepare("UPDATE runs SET agent_id = ? WHERE id = ? AND status = 'running'");
  const byAgentStmt = db.prepare("SELECT * FROM runs WHERE agent_id = ? AND status = 'running' ORDER BY started_at ASC LIMIT 1");
  const getStmt = db.prepare('SELECT * FROM runs WHERE id = ?');
  const activeStmt = db.prepare("SELECT * FROM runs WHERE status = 'running' ORDER BY started_at DESC");
  const recentStmt = db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?');
  // duration_ms is set alongside ended_at: the UI reads durationMs for a finished row, so a staled run
  // that only had ended_at rendered as `0s` — indistinguishable from a run that never started.
  const staleStmt = db.prepare(`UPDATE runs SET status = 'stale', ended_at = ?, duration_ms = MAX(0, ? - started_at)
    WHERE status = 'running' AND started_at < ?`);
  const endSessionStmt = db.prepare(`UPDATE runs SET status = 'stale', ended_at = ?, duration_ms = MAX(0, ? - started_at)
    WHERE status = 'running' AND session_id = ?`);
  const sessionOpenIdsStmt = db.prepare("SELECT id FROM runs WHERE status = 'running' AND session_id = ?");
  // `agent_id IS NULL` is what keeps the heuristic away from a background run: that one was launched
  // with an exact id and can only be matched by it, so guessing here would attach one agent's
  // transcript to another agent that is still working.
  const oldestMatchStmt = db.prepare(`SELECT id FROM runs
    WHERE status = 'running' AND session_id = ? AND agent_type = ? AND agent_id IS NULL
    ORDER BY started_at ASC LIMIT 1`);
  const enrichStmt = db.prepare('UPDATE runs SET transcript_path = ?, result_preview = COALESCE(?, result_preview) WHERE id = ?');
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
    launch({ id, agentId }) {
      return launchStmt.run(agentId ?? null, id).changes > 0;
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
    listActive() { return activeStmt.all().map(toRun); },
    listRecent(limit = 100) { return recentStmt.all(limit).map(toRun); },
    markStaleBefore(cutoffTs, now) { staleStmt.run(now, now, cutoffTs); },
    // Returns the ids it staled. The caller has to broadcast one run.close per row: a bare
    // `{sessionId}` event carries no run id, and the dashboard has no way to match it to the rows it
    // is rendering — the rail would keep ticking for a run that ended until the page is reloaded.
    endSessionRuns(sessionId, now) {
      const ids = sessionOpenIdsStmt.all(sessionId).map((r) => r.id);
      endSessionStmt.run(now, now, sessionId);
      return ids;
    },
    pruneBefore(ts) { pruneStmt.run(ts); },
  };
}
