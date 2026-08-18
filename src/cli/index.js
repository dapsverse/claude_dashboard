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

const OPENERS = { darwin: 'open', win32: 'start', linux: 'xdg-open' };

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
      const daemon = await startDaemon({
        claudeDir: claudeHome(),
        projectRoot: process.cwd(),
        uiDir: join(pkgRoot, 'dist', 'ui'),
      });
      log(`agentpanel listening on http://127.0.0.1:${daemon.port}`);
      log(`Open: ${daemon.url}`);
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
      runUninstall({ settingsPath: userSettingsPath(), stateDir: stateDir(), log });
      return 0;

    default:
      log('usage: agentpanel <init|start|stop|status|open|uninstall>');
      log(`runtime file: ${runtimeFilePath()}`);
      return 1;
  }
}
