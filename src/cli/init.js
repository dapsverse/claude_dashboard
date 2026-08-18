// src/cli/init.js
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { mergeHooks } from './hook-config.js';

export function runInit({ settingsPath, hooksDir, assumeYes = false, log = console.log, confirm }) {
  const existing = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
  const { hooks, added, removed } = mergeHooks(existing.hooks ?? {}, hooksDir);

  log(`agentpanel init will modify: ${settingsPath}`);
  for (const event of added) log(`  + ${event} -> agentpanel hook`);
  for (const event of removed) log(`  - replacing stale ${event} entry`);
  log('No other key in that file is touched.');

  if (!assumeYes && confirm && !confirm()) { log('Aborted. Nothing was written.'); return { written: false }; }

  if (existsSync(settingsPath)) copyFileSync(settingsPath, `${settingsPath}.agentpanel-backup`);
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify({ ...existing, hooks }, null, 2)}\n`);

  log('Done. Hooks take effect in sessions started from now on.');
  log('Note: Claude Code withholds hooks in a directory you have not trusted yet — accept the workspace');
  log('trust prompt there, or agentpanel will not see that session.');
  return { written: true };
}
