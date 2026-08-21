// src/store/db.js
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  project_path  TEXT,
  source        TEXT NOT NULL DEFAULT 'terminal',
  status        TEXT NOT NULL DEFAULT 'active',
  started_at    INTEGER NOT NULL,
  last_event_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  agent_type      TEXT,
  description     TEXT,
  prompt          TEXT,
  status          TEXT NOT NULL,
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER,
  duration_ms     INTEGER,
  result_preview  TEXT,
  transcript_path TEXT
);
CREATE INDEX IF NOT EXISTS runs_status_idx  ON runs(status, started_at DESC);
CREATE INDEX IF NOT EXISTS runs_session_idx ON runs(session_id);
CREATE TABLE IF NOT EXISTS projects (
  path         TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  added_at     INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_sessions (
  project_path TEXT PRIMARY KEY,
  session_id   TEXT,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_path TEXT NOT NULL,
  role         TEXT NOT NULL,
  blocks       TEXT NOT NULL,
  ts           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_messages_project_idx ON chat_messages(project_path, ts, id);
`;

export function openDb(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  chmodSync(path, 0o600);
  restrictSidecars(path);
  return db;
}

// Columns added after the first release. `CREATE TABLE IF NOT EXISTS` does nothing to a table that
// already exists, so a new column has to be added explicitly — and a database that already has it
// must be left alone, which is why this reads the table rather than swallowing an ALTER error.
const ADDED_COLUMNS = [
  // The subagent's own id, reported both when a background dispatch is launched and when any
  // subagent stops. It is the only exact join between the two.
  { table: 'runs', column: 'agent_id', type: 'TEXT' },
];

function migrate(db) {
  for (const { table, column, type } of ADDED_COLUMNS) {
    const present = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!present) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

// WAL leaves `-wal` and `-shm` beside the database, and SQLite creates them under the process umask
// rather than copying the database's mode. They hold the same prompts and tool output as the database
// itself until a checkpoint. The 0700 state directory is the real control — no other user can traverse
// into it — but matching the modes costs nothing and removes the discrepancy.
export function restrictSidecars(path) {
  for (const suffix of ['-wal', '-shm']) {
    try { chmodSync(`${path}${suffix}`, 0o600); } catch { /* not created yet, or already gone */ }
  }
}
