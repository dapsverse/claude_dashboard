// src/cli/uninstall.js
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { mergeHooks } from './hook-config.js';
import { readRuntime, isAlive } from '../core/runtime-file.js';

// Removing the state directory destroys daemon.json, which is the only handle `stop` has on the
// running daemon: uninstall must therefore stop it first, or it orphans a live server holding the
// port — and the user is left with no supported way to shut it down.
async function stopRunningDaemon({ runtimeFile, log, timeoutMs, pollMs }) {
  let info;
  try {
    info = readRuntime(runtimeFile);
  } catch (err) {
    // Unreadable rather than absent: we cannot know whether a daemon is up, so say so and keep going.
    log(`  ! could not read ${runtimeFile} (${err.message}); a running daemon may survive this uninstall`);
    return { stopped: false, pid: null };
  }
  if (!info || !isAlive(info.pid)) return { stopped: true, pid: null };

  try {
    process.kill(info.pid, 'SIGTERM');
  } catch (err) {
    if (err?.code === 'ESRCH') return { stopped: true, pid: null };   // exited between check and signal
    log(`  ! could not signal the running daemon (pid ${info.pid}): ${err.message}`);
    return { stopped: false, pid: info.pid };
  }

  // SIGTERM only asks. Wait for the process to actually be gone before deleting the file that names
  // it, so "fully removed" is never printed over a daemon still serving on the port.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(info.pid)) {
      log(`  - stopped the running daemon (pid ${info.pid})`);
      return { stopped: true, pid: info.pid };
    }
    await delay(pollMs);
  }
  return { stopped: false, pid: info.pid };
}

export async function runUninstall({ settingsPath, stateDir, log = console.log, timeoutMs = 5000, pollMs = 50 }) {
  const { stopped, pid } = await stopRunningDaemon({
    runtimeFile: join(stateDir, 'daemon.json'), log, timeoutMs, pollMs,
  });

  if (existsSync(settingsPath)) {
    const existing = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const { hooks, removed } = mergeHooks(existing.hooks ?? {}, '', { remove: true });
    writeFileSync(settingsPath, `${JSON.stringify({ ...existing, hooks }, null, 2)}\n`);
    for (const event of removed) log(`  - removed ${event} entry`);
  }
  rmSync(stateDir, { recursive: true, force: true });
  log(`  - removed ${stateDir} (database, logs, runtime file)`);

  // `init` writes this backup outside stateDir on purpose, as the user's safety net for a tool that
  // edits their settings.json. Deleting it here silently would remove that safety net at exactly the
  // moment it might be needed, so uninstall only ever reports it — never deletes it.
  const backupPath = `${settingsPath}.agentpanel-backup`;
  if (existsSync(backupPath)) {
    log(`  - left in place: ${backupPath} (your pre-install settings.json; delete it yourself if you don't need it)`);
  }

  if (stopped) {
    log('agentpanel is fully removed. No daemon is left running.');
  } else {
    // `agentpanel stop` cannot help any more — the runtime file it reads is gone — so name the pid.
    log(`agentpanel's hooks and state are removed, but the daemon${pid ? ` (pid ${pid})` : ''} did not exit.`);
    log(`Kill it by hand: kill ${pid ?? '<pid>'}`);
  }
  return { stopped, pid };
}
