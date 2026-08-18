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
`;

export function openDb(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  chmodSync(path, 0o600);
  return db;
}
