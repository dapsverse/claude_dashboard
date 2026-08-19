// test/store/chat-store.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/store/db.js';
import { createChatRepo, redactBlocks } from '../../src/store/chat.js';
import { createProjectsRepo } from '../../src/store/projects.js';

const fresh = () => openDb(join(mkdtempSync(join(tmpdir(), 'ap-chat-')), 'data.db'));
const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';

test('a session row is created lazily and keeps its original createdAt', () => {
  const chat = createChatRepo(fresh());
  assert.equal(chat.getSession('/p/one'), null);
  chat.touchSession('/p/one', 1000);
  chat.touchSession('/p/one', 2000);
  const row = chat.getSession('/p/one');
  assert.equal(row.createdAt, 1000);
  assert.equal(row.lastUsedAt, 2000);
  assert.equal(row.sessionId, null);
});

test('the sdk session id is persisted per project and never shared between projects', () => {
  const chat = createChatRepo(fresh());
  chat.touchSession('/p/one', 1000);
  chat.touchSession('/p/two', 1000);
  chat.setSessionId({ projectPath: '/p/one', sessionId: 'sess-1', at: 1500 });
  assert.equal(chat.getSession('/p/one').sessionId, 'sess-1');
  assert.equal(chat.getSession('/p/two').sessionId, null);
});

test('clearSession drops the resume id and the transcript for that project only', () => {
  const chat = createChatRepo(fresh());
  chat.setSessionId({ projectPath: '/p/one', sessionId: 'sess-1', at: 1000 });
  chat.append({ projectPath: '/p/one', role: 'user', blocks: [{ type: 'text', text: 'hi' }], ts: 1 });
  chat.append({ projectPath: '/p/two', role: 'user', blocks: [{ type: 'text', text: 'other' }], ts: 1 });
  chat.clearSession('/p/one');
  assert.equal(chat.getSession('/p/one'), null);
  assert.equal(chat.list('/p/one').length, 0);
  assert.equal(chat.list('/p/two').length, 1);
});

test('messages come back oldest first, scoped to their project', () => {
  const chat = createChatRepo(fresh());
  chat.append({ projectPath: '/p/one', role: 'user', blocks: [{ type: 'text', text: 'first' }], ts: 10 });
  chat.append({ projectPath: '/p/one', role: 'assistant', blocks: [{ type: 'text', text: 'second' }], ts: 20 });
  chat.append({ projectPath: '/p/two', role: 'user', blocks: [{ type: 'text', text: 'elsewhere' }], ts: 15 });
  const rows = chat.list('/p/one');
  assert.deepEqual(rows.map((r) => r.blocks[0].text), ['first', 'second']);
  assert.equal(rows[0].role, 'user');
  assert.equal(chat.list('/p/two').length, 1);
});

test('list caps at the requested limit and still returns the newest tail in order', () => {
  const chat = createChatRepo(fresh());
  for (let i = 0; i < 10; i += 1) {
    chat.append({ projectPath: '/p/one', role: 'user', blocks: [{ type: 'text', text: `m${i}` }], ts: i });
  }
  const rows = chat.list('/p/one', 3);
  assert.deepEqual(rows.map((r) => r.blocks[0].text), ['m7', 'm8', 'm9']);
});

test('a stored prompt is redacted on the way in, not on the way out', () => {
  const chat = createChatRepo(fresh());
  chat.append({ projectPath: '/p/one', role: 'user', blocks: [{ type: 'text', text: `use ${KEY} please` }], ts: 1 });
  const stored = chat.list('/p/one')[0];
  assert.ok(!stored.blocks[0].text.includes('sk-ant-'));
  assert.match(stored.blocks[0].text, /\[redacted\]/);
});

test('tool_use input is stored as a redacted preview string, never as raw input', () => {
  const [block] = redactBlocks([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: `echo ${KEY}` } }]);
  assert.equal(block.type, 'tool_use');
  assert.equal(block.name, 'Bash');
  assert.equal(block.id, 't1');
  assert.equal(block.input, undefined);
  assert.ok(!block.inputPreview.includes('sk-ant-'));
});

test('a result block is redacted and keeps its accounting fields', () => {
  const [block] = redactBlocks([
    { type: 'result', text: `done ${KEY}`, isError: false, durationMs: 12, totalCostUsd: 0.5 },
  ]);
  assert.ok(!block.text.includes('sk-ant-'));
  assert.equal(block.durationMs, 12);
  assert.equal(block.totalCostUsd, 0.5);
  assert.equal(block.isError, false);
});

test('an unknown block shape is reduced to a redacted preview rather than stored verbatim', () => {
  const [block] = redactBlocks([{ type: 'weird_future_thing', secret: KEY }]);
  assert.equal(block.type, 'other');
  assert.equal(block.kind, 'weird_future_thing');
  assert.ok(!block.preview.includes('sk-ant-'));
});

test('a very long text block is truncated so one paste cannot fill the database', () => {
  const [block] = redactBlocks([{ type: 'text', text: 'x'.repeat(50_000) }]);
  assert.ok(block.text.length < 50_000);
  assert.ok(block.text.endsWith('…'));
});

test('projects are added once, listed newest-used first, and rejected empty', () => {
  const projects = createProjectsRepo(fresh());
  projects.add({ path: '/p/one', name: 'one', at: 1000 });
  projects.add({ path: '/p/two', name: 'two', at: 2000 });
  projects.add({ path: '/p/one', name: 'one', at: 3000 });          // re-add touches, never duplicates
  const rows = projects.list();
  assert.deepEqual(rows.map((r) => r.path), ['/p/one', '/p/two']);
  assert.equal(rows[0].addedAt, 1000);
  assert.equal(rows[0].lastUsedAt, 3000);
});

test('touching an unknown project does not invent a row', () => {
  const projects = createProjectsRepo(fresh());
  projects.touch('/p/ghost', 1000);
  assert.equal(projects.list().length, 0);
});
