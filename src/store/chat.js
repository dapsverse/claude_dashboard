// src/store/chat.js
import { preview } from '../core/redact.js';

// Chat text is the one thing a user reads back in full, so it gets a far larger budget than a run
// preview — but still a budget. A pasted stack trace or a base64 blob would otherwise be persisted
// verbatim for every turn, and this database sits in the user's home directory forever.
const MAX_TEXT = 8000;
const MAX_INPUT = 2000;
const MAX_OTHER = 1000;

// Redaction happens here rather than at the call sites: every path that writes a chat message goes
// through append(), so putting it anywhere else means one forgotten caller writes an API key to disk.
export function redactBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  return blocks.map((block) => {
    switch (block?.type) {
      case 'text':
        return { type: 'text', text: preview(block.text, MAX_TEXT) };
      case 'tool_use':
        // The raw input is deliberately dropped. It is broadcast live for the approval decision —
        // you cannot approve a command you cannot see — but what lands on disk is a bounded,
        // redacted rendering of it.
        return {
          type: 'tool_use',
          id: block.id ?? null,
          name: block.name ?? null,
          inputPreview: preview(safeStringify(block.input), MAX_INPUT),
        };
      case 'result':
        return {
          type: 'result',
          text: preview(block.text, MAX_TEXT),
          isError: block.isError === true,
          durationMs: block.durationMs ?? null,
          totalCostUsd: block.totalCostUsd ?? null,
        };
      default:
        // An SDK version that grows a block type this code has never seen still gets persisted,
        // but as an opaque redacted preview rather than a structure nothing downstream can trust.
        return { type: 'other', kind: String(block?.type ?? 'unknown'), preview: preview(safeStringify(block), MAX_OTHER) };
    }
  });
}

function safeStringify(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value) ?? String(value); }
  catch { return String(value); }               // circular or a getter that throws
}

const toSession = (r) => r == null ? null : ({
  projectPath: r.project_path, sessionId: r.session_id,
  createdAt: r.created_at, lastUsedAt: r.last_used_at,
});

const toMessage = (r) => ({
  id: r.id, projectPath: r.project_path, role: r.role, ts: r.ts,
  blocks: parseBlocks(r.blocks),
});

function parseBlocks(raw) {
  try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }                          // a row written by a future version we cannot read
}

export function createChatRepo(db) {
  const touchStmt = db.prepare(`INSERT INTO chat_sessions (project_path, session_id, created_at, last_used_at)
    VALUES (?, NULL, ?, ?)
    ON CONFLICT(project_path) DO UPDATE SET last_used_at = excluded.last_used_at`);
  const setIdStmt = db.prepare(`INSERT INTO chat_sessions (project_path, session_id, created_at, last_used_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(project_path) DO UPDATE SET session_id = excluded.session_id,
                                            last_used_at = excluded.last_used_at`);
  const getSessionStmt = db.prepare('SELECT * FROM chat_sessions WHERE project_path = ?');
  const dropSessionStmt = db.prepare('DELETE FROM chat_sessions WHERE project_path = ?');
  const dropMessagesStmt = db.prepare('DELETE FROM chat_messages WHERE project_path = ?');
  const appendStmt = db.prepare('INSERT INTO chat_messages (project_path, role, blocks, ts) VALUES (?, ?, ?, ?)');
  // Newest-first with a LIMIT, reversed by the caller: the tail is what a reloading tab needs, and
  // ordering ascending with a LIMIT would hand back the oldest messages instead.
  const listStmt = db.prepare('SELECT * FROM chat_messages WHERE project_path = ? ORDER BY ts DESC, id DESC LIMIT ?');

  return {
    touchSession(projectPath, at) { touchStmt.run(projectPath, at, at); },
    setSessionId({ projectPath, sessionId, at }) { setIdStmt.run(projectPath, sessionId, at, at); },
    getSession(projectPath) { return toSession(getSessionStmt.get(projectPath)); },
    // A reset is "start over": the resume id and the transcript the user is looking at go together.
    // Leaving the messages behind would show a history the new session has no memory of.
    clearSession(projectPath) {
      dropSessionStmt.run(projectPath);
      dropMessagesStmt.run(projectPath);
    },
    append({ projectPath, role, blocks, ts }) {
      const stored = redactBlocks(blocks);
      appendStmt.run(projectPath, role, JSON.stringify(stored), ts);
      return { projectPath, role, blocks: stored, ts };
    },
    list(projectPath, limit = 200) {
      return listStmt.all(projectPath, limit).map(toMessage).reverse();
    },
  };
}
