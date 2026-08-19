// src/cli/init.js
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { mergeHooks } from './hook-config.js';

// `npx agentpanel init` runs from ~/.npm/_npx/<hash>/node_modules/agentpanel, and the hook commands
// written into settings.json are absolute paths into that directory. `npm cache clean` deletes it and
// a new version hashes to a different one, so those hooks silently stop firing — the daemon simply
// never starts again. Detect it and say so; a global install is the only durable location.
export function isDisposableInstall(hooksDir) {
  return /[/\\]_npx[/\\]/.test(String(hooksDir ?? ''));
}

export function runInit({ settingsPath, hooksDir, assumeYes = false, log = console.log, confirm }) {
  const existing = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
  const { hooks, added, removed } = mergeHooks(existing.hooks ?? {}, hooksDir);

  log(`agentpanel init will modify: ${settingsPath}`);
  for (const event of added) log(`  + ${event} -> agentpanel hook`);
  for (const event of removed) log(`  - replacing stale ${event} entry`);
  log('No other key in that file is touched.');
  if (isDisposableInstall(hooksDir)) {
    log('');
    log(`Warning: these hooks point into an npx cache directory (${hooksDir}).`);
    log('That directory is deleted by `npm cache clean` and replaced on the next version, and the');
    log('hooks break silently when it goes. Install it properly instead: npm install -g agentpanel');
  }

  // Default-deny. `confirm && !confirm()` would skip the gate entirely when no confirm callback is
  // supplied, which means a caller that simply forgets it writes to the user's settings.json with no
  // consent at all. The safe default for a file the user's whole setup depends on is to do nothing.
  if (!assumeYes && (!confirm || !confirm())) {
    log('');
    log('Nothing was written. Re-run with --yes to apply these changes.');
    return { written: false };
  }

  // Only ever written once. A second `init` would otherwise overwrite the pre-install backup with a
  // settings.json that already contains agentpanel's own hooks, destroying the very state the backup
  // exists to restore.
  const backupPath = `${settingsPath}.agentpanel-backup`;
  if (existsSync(settingsPath) && !existsSync(backupPath)) copyFileSync(settingsPath, backupPath);
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify({ ...existing, hooks }, null, 2)}\n`);

  log('Done. Hooks take effect in sessions started from now on.');
  log('Note: Claude Code withholds hooks in a directory you have not trusted yet — accept the workspace');
  log('trust prompt there, or agentpanel will not see that session.');
  return { written: true };
}
