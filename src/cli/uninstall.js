// src/cli/uninstall.js
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { mergeHooks } from './hook-config.js';

export function runUninstall({ settingsPath, stateDir, log = console.log }) {
  if (existsSync(settingsPath)) {
    const existing = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const { hooks, removed } = mergeHooks(existing.hooks ?? {}, '', { remove: true });
    writeFileSync(settingsPath, `${JSON.stringify({ ...existing, hooks }, null, 2)}\n`);
    for (const event of removed) log(`  - removed ${event} entry`);
  }
  rmSync(stateDir, { recursive: true, force: true });
  log(`  - removed ${stateDir} (database, logs, runtime file)`);

  // `init` writes this backup outside stateDir on purpose, as the user's safety net for a tool
  // that edits their settings.json. Deleting it here silently would remove that safety net at
  // exactly the moment it might be needed, so uninstall only ever reports it — never deletes it.
  const backupPath = `${settingsPath}.agentpanel-backup`;
  if (existsSync(backupPath)) {
    log(`  - left in place: ${backupPath} (your pre-install settings.json; delete it yourself if you don't need it)`);
  }

  log('agentpanel is fully removed. Stop any running daemon with: agentpanel stop');
}
