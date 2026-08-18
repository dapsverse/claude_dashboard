import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, preview, truncate, REDACTED } from '../../src/core/redact.js';

test('redacts anthropic-style keys', () => {
  assert.equal(redact('use sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv now'), `use ${REDACTED} now`);
});

test('redacts github tokens', () => {
  assert.equal(redact('ghp_0123456789abcdefghijklmnopqrstuvwxyz'), REDACTED);
});

test('redacts aws access key ids', () => {
  assert.equal(redact('AKIAIOSFODNN7EXAMPLE'), REDACTED);
});

test('redacts private key blocks', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----';
  assert.equal(redact(pem), REDACTED);
});

test('redacts long hex runs such as seeds', () => {
  assert.equal(redact(`seed ${'a1b2c3d4'.repeat(8)}`), `seed ${REDACTED}`);
});

test('leaves ordinary prose and short hex alone', () => {
  const s = 'commit deadbeef fixes the parser';
  assert.equal(redact(s), s);
});

test('is null-safe', () => {
  assert.equal(redact(undefined), '');
  assert.equal(redact(null), '');
});

test('truncate appends an ellipsis only when it cuts', () => {
  assert.equal(truncate('abcdef', 3), 'abc…');
  assert.equal(truncate('ab', 3), 'ab');
});

test('preview redacts before truncating so a cut key cannot survive', () => {
  const out = preview(`x${' '.repeat(40)}ghp_0123456789abcdefghijklmnopqrstuvwxyz`, 20);
  assert.ok(!out.includes('ghp_'));
});

test('redacts a private key whose capture was cut off before the END marker', () => {
  const body = `MIIEowIBAAKCAQEA${'a1b2/c3d4e5f6'.repeat(6)}zzXyQ9`;
  const truncated = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n`;
  const out = redact(truncated);
  assert.ok(!out.includes('a1b2'), 'key body must not survive a missing END marker');
});

test('redacts a long opaque blob that no word boundary can isolate', () => {
  const blob = `MIIEowIBAAKCAQEA${'a1b2c3d4e5f6'.repeat(6)}zzXyQ9`;
  assert.equal(redact(blob), REDACTED);
});

test('keeps ordinary filesystem paths, which are long but not secret', () => {
  const path = '/Users/someone/Documents/agentpanel/src/store/runs.js';
  assert.equal(redact(path), path);
});
