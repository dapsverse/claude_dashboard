// src/store/runs.js
const toRun = (r) => r == null ? null : ({
  id: r.id, sessionId: r.session_id, agentType: r.agent_type, description: r.description,
  prompt: r.prompt, status: r.status, startedAt: r.started_at, endedAt: r.ended_at,
  durationMs: r.duration_ms, resultPreview: r.result_preview, transcriptPath: r.transcript_path,
});

export function createRunsRepo(db) {
  const insert = db.prepare(`INSERT OR IGNORE INTO runs
    (id, session_id, agent_type, description, prompt, status, started_at)
    VALUES (?, ?, ?, ?, ?, 'running', ?)`);
  const closeStmt = db.prepare(`UPDATE runs
    SET status = ?, ended_at = ?, duration_ms = ?, result_preview = ?
    WHERE id = ? AND status = 'running'`);
  const getStmt = db.prepare('SELECT * FROM runs WHERE id = ?');
  const activeStmt = db.prepare("SELECT * FROM runs WHERE status = 'running' ORDER BY started_at DESC");
  const recentStmt = db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?');
  const staleStmt = db.prepare("UPDATE runs SET status = 'stale', ended_at = ? WHERE status = 'running' AND started_at < ?");
  const endSessionStmt = db.prepare("UPDATE runs SET status = 'stale', ended_at = ? WHERE status = 'running' AND session_id = ?");
  const oldestMatchStmt = db.prepare(`SELECT id FROM runs
    WHERE status = 'running' AND session_id = ? AND agent_type = ? ORDER BY started_at ASC LIMIT 1`);
  const enrichStmt = db.prepare('UPDATE runs SET transcript_path = ?, result_preview = COALESCE(?, result_preview) WHERE id = ?');
  const pruneStmt = db.prepare("DELETE FROM runs WHERE status != 'running' AND COALESCE(ended_at, started_at) < ?");

  return {
    open({ id, sessionId, agentType, description, prompt, startedAt }) {
      insert.run(id, sessionId, agentType ?? null, description ?? null, prompt ?? null, startedAt);
    },
    close({ id, status, endedAt, durationMs, resultPreview }) {
      const row = getStmt.get(id);
      if (!row) return false;
      // A clock step backwards (NTP correction, VM resume) must not store a negative duration.
      const duration = durationMs ?? Math.max(0, endedAt - row.started_at);
      const result = closeStmt.run(status, endedAt, duration, resultPreview ?? null, id);
      // Report the state transition, not merely the row's existence: the UPDATE is guarded by
      // `status = 'running'`, so a replayed close changes nothing and must not make the caller
      // broadcast a second run.close for a run that already finished.
      return result.changes > 0;
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
    markStaleBefore(cutoffTs, now) { staleStmt.run(now, cutoffTs); },
    endSessionRuns(sessionId, now) { endSessionStmt.run(now, sessionId); },
    pruneBefore(ts) { pruneStmt.run(ts); },
  };
}
