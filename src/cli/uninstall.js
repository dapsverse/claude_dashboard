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
  log('agentpanel is fully removed. Stop any running daemon with: agentpanel stop');
}
