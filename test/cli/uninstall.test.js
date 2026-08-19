// test/cli/uninstall.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../../src/cli/init.js';
import { runUninstall } from '../../src/cli/uninstall.js';

function env() {
  const claudeDir = mkdtempSync(join(tmpdir(), 'ap-uninstall-'));
  return {
    settingsPath: join(claudeDir, 'settings.json'),
    hooksDir: '/opt/agentpanel/hooks',
    stateDir: join(claudeDir, 'agentpanel'),
  };
}

test('uninstall leaves the settings backup on disk and reports its path', () => {
  const { settingsPath, hooksDir, stateDir } = env();
  writeFileSync(settingsPath, JSON.stringify({ someUserKey: true }, null, 2));
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'data.db'), 'not really a db');

  runInit({ settingsPath, hooksDir, assumeYes: true, log: () => {} });
  const backupPath = `${settingsPath}.agentpanel-backup`;
  assert.ok(existsSync(backupPath), 'init writes the backup before overwriting settings.json');

  const lines = [];
  runUninstall({ settingsPath, stateDir, log: (l) => lines.push(l) });

  // The backup is the user's safety net for a tool that edits their settings.json — uninstall
  // must never delete it, only tell the user it is there.
  assert.ok(existsSync(backupPath), 'the backup survives uninstall');
  assert.equal(JSON.parse(readFileSync(backupPath, 'utf8')).someUserKey, true);
  assert.ok(lines.some((l) => l.includes(backupPath)), 'uninstall reports the backup path');
});

test('uninstall does not mention a backup that was never written', () => {
  const { settingsPath, hooksDir, stateDir } = env();
  writeFileSync(settingsPath, JSON.stringify({ hooks: {} }));
  void hooksDir;

  const lines = [];
  runUninstall({ settingsPath, stateDir, log: (l) => lines.push(l) });

  assert.ok(!lines.some((l) => l.includes('.agentpanel-backup')));
});
