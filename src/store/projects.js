// src/store/projects.js
const toProject = (r) => r == null ? null : ({
  path: r.path, name: r.name, addedAt: r.added_at, lastUsedAt: r.last_used_at,
});

export function createProjectsRepo(db) {
  const addStmt = db.prepare(`INSERT INTO projects (path, name, added_at, last_used_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET last_used_at = excluded.last_used_at,
                                    name         = excluded.name`);
  // No upsert: touching is a side effect of chatting, and a project the user never added should not
  // appear in the switcher because a request named it.
  const touchStmt = db.prepare('UPDATE projects SET last_used_at = ? WHERE path = ?');
  const getStmt = db.prepare('SELECT * FROM projects WHERE path = ?');
  const listStmt = db.prepare('SELECT * FROM projects ORDER BY last_used_at DESC, path ASC');
  const removeStmt = db.prepare('DELETE FROM projects WHERE path = ?');

  return {
    add({ path, name, at }) { addStmt.run(path, name, at, at); return toProject(getStmt.get(path)); },
    touch(path, at) { touchStmt.run(at, path); },
    get(path) { return toProject(getStmt.get(path)); },
    list() { return listStmt.all().map(toProject); },
    remove(path) { removeStmt.run(path); },
  };
}
