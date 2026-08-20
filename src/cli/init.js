// src/cli/init.js
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { mergeHooks } from './hook-config.js';
import { installCommandFile, commandFilePath, COMMAND_NAME } from './command-file.js';

// `npx agentpanel init` runs from ~/.npm/_npx/<hash>/node_modules/agentpanel, and the hook commands
// written into settings.json are absolute paths into that directory. `npm cache clean` deletes it and
// a new version hashes to a different one, so those hooks silently stop firing — the daemon simply
// never starts again. Detect it and say so; a global install is the only durable location.
export function isDisposableInstall(hooksDir) {
  return /[/\\]_npx[/\\]/.test(String(hooksDir ?? ''));
}

export function runInit({
  settingsPath, hooksDir, claudeDir, templatePath, nodeBin, entry,
  assumeYes = false, log = console.log, confirm,
}) {
  const existing = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
  const { hooks, added, removed } = mergeHooks(existing.hooks ?? {}, hooksDir);
  // The slash command is optional so that a caller which does not know about it — an older test, an
  // embedder — still installs the hooks rather than crashing on a missing template.
  const wantsCommand = Boolean(claudeDir && templatePath && nodeBin && entry);

  log(`agentpanel init will modify: ${settingsPath}`);
  for (const event of added) log(`  + ${event} -> agentpanel hook`);
  for (const event of removed) log(`  - replacing stale ${event} entry`);
  if (wantsCommand) log(`  + ${commandFilePath(claudeDir)} -> /${COMMAND_NAME}`);
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

  let command = null;
  if (wantsCommand) {
    command = installCommandFile({ claudeDir, templatePath, nodeBin, entry });
    if (command.status === 'foreign') {
      // Somebody else's `/dashboard`. Replacing it would be a silent theft of a command the user
      // wrote, so the hooks go in and this one does not — said out loud, with the way out.
      log('');
      log(`Left alone: ${command.path} already exists and was not written by agentpanel.`);
      log(`Your own /${COMMAND_NAME} is untouched, and agentpanel's was not installed. Move or delete`);
      log('that file and re-run init if you want ours instead.');
    } else if (command.status !== 'current') {
      log(`  - ${command.status} ${command.path}`);
    }
  }

  log('Done. Hooks take effect in sessions started from now on.');
  if (command && command.status !== 'foreign') {
    log(`The /${COMMAND_NAME} command is available in sessions started from now on too.`);
  }
  log('Note: Claude Code withholds hooks in a directory you have not trusted yet — accept the workspace');
  log('trust prompt there, or agentpanel will not see that session.');
  return { written: true, command };
}
