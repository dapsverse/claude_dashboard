// src/store/sessions.js
const toSession = (r) => r == null ? null : ({
  id: r.id, projectPath: r.project_path, source: r.source,
  status: r.status, startedAt: r.started_at, lastEventAt: r.last_event_at,
});

export function createSessionsRepo(db) {
  const upsert = db.prepare(`INSERT INTO sessions (id, project_path, source, status, started_at, last_event_at)
    VALUES (?, ?, ?, 'active', ?, ?)
    ON CONFLICT(id) DO UPDATE SET last_event_at = excluded.last_event_at,
                                  project_path  = COALESCE(excluded.project_path, sessions.project_path)`);
  const endStmt = db.prepare("UPDATE sessions SET status = 'ended', last_event_at = ? WHERE id = ?");
  const getStmt = db.prepare('SELECT * FROM sessions WHERE id = ?');
  const listStmt = db.prepare('SELECT * FROM sessions ORDER BY last_event_at DESC');

  return {
    touch({ id, projectPath, source = 'terminal', at }) {
      upsert.run(id, projectPath ?? null, source, at, at);
    },
    end(id, at) { endStmt.run(at, id); },
    get(id) { return toSession(getStmt.get(id)); },
    list() { return listStmt.all().map(toSession); },
  };
}
