// src/cli/index.js
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { claudeHome, stateDir, userSettingsPath, runtimeFilePath } from '../core/paths.js';
import { readLiveRuntime, clearRuntime } from '../core/runtime-file.js';
import { startDaemon } from '../daemon/index.js';
import { runInit } from './init.js';
import { runUninstall } from './uninstall.js';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// No win32 entry: `start` is a cmd builtin, not an executable, so execFile could never launch it —
// and both hook scripts are bash. package.json's `os` field declares the supported platforms.
const OPENERS = { darwin: 'open', linux: 'xdg-open' };

// The token-bearing URL is printed only to a terminal a human is watching. Under the SessionStart
// bootstrap this process is detached with stdout redirected into daemon.log, and a log file is the
// last place the token should end up — `agentpanel open` reads it back from the 0600 runtime file.
export function startupLines({ port, url, isTty }) {
  return [
    `agentpanel listening on http://127.0.0.1:${port}`,
    isTty ? `Open: ${url}` : 'Open the dashboard with: agentpanel open',
  ];
}

export async function main(argv = process.argv.slice(2), log = console.log) {
  const [command = 'status', ...rest] = argv;

  switch (command) {
    case 'init':
      runInit({
        settingsPath: userSettingsPath(),
        hooksDir: join(pkgRoot, 'hooks'),
        assumeYes: rest.includes('--yes'),
        log,
      });
      return 0;

    case 'start': {
      const live = readLiveRuntime();
      if (live) { log(`Already running on port ${live.port} (pid ${live.pid}).`); return 0; }
      let daemon;
      try {
        daemon = await startDaemon({
          claudeDir: claudeHome(),
          projectRoot: process.cwd(),
          uiDir: join(pkgRoot, 'dist', 'ui'),
        });
      } catch (err) {
        // startDaemon refuses a non-loopback bind and a racing second start on its own — surface
        // that as a normal CLI error message rather than an unhandled rejection.
        log(String(err?.message ?? err));
        return 1;
      }
      for (const line of startupLines({ port: daemon.port, url: daemon.url, isTty: process.stdout.isTTY === true })) log(line);
      for (const signal of ['SIGINT', 'SIGTERM']) {
        process.on(signal, () => { daemon.stop().then(() => process.exit(0)); });
      }
      return null;   // keep the process alive
    }

    case 'stop': {
      const live = readLiveRuntime();
      if (!live) { log('Not running.'); clearRuntime(); return 0; }
      process.kill(live.pid, 'SIGTERM');
      log(`Stopped pid ${live.pid}.`);
      return 0;
    }

    case 'status': {
      const live = readLiveRuntime();
      log(live ? `running  pid=${live.pid}  port=${live.port}  since=${new Date(live.startedAt).toISOString()}`
               : 'stopped');
      return live ? 0 : 1;
    }

    case 'open': {
      const live = readLiveRuntime();
      if (!live) { log('Not running. Start it with: agentpanel start'); return 1; }
      const url = `http://127.0.0.1:${live.port}/auth?token=${live.token}`;
      const opener = OPENERS[process.platform];
      if (opener) execFile(opener, [url], () => {});
      log(url);
      return 0;
    }

    case 'uninstall':
      await runUninstall({ settingsPath: userSettingsPath(), stateDir: stateDir(), log });
      return 0;

    default:
      log('usage: agentpanel <init|start|stop|status|open|uninstall>');
      log(`runtime file: ${runtimeFilePath()}`);
      return 1;
  }
}
