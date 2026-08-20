// src/cli/index.js
import { execFile, spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { claudeHome, stateDir, userSettingsPath, runtimeFilePath, logFilePath } from '../core/paths.js';
import { readLiveRuntime, clearRuntime, restrictStatePaths } from '../core/runtime-file.js';
import { startDaemon } from '../daemon/index.js';
import { runInit } from './init.js';
import { runUninstall } from './uninstall.js';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const entryPath = () => join(pkgRoot, 'bin', 'agentpanel.js');

// Detached the same way the SessionStart bootstrap does it, and for the same two reasons: the daemon
// has to outlive the process that asked for it, and everything it prints has to land in the log file
// rather than in the caller's output — `/dashboard` runs this from inside a Claude Code session, and
// the startup lines name a URL carrying the token.
function spawnDetachedDaemon() {
  const dir = stateDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  restrictStatePaths(dir);
  const fd = openSync(logFilePath(), 'a', 0o600);
  try {
    spawn(process.execPath, ['--disable-warning=ExperimentalWarning', entryPath(), 'start'], {
      detached: true, stdio: ['ignore', fd, fd],
    }).unref();
  } finally {
    closeSync(fd);                    // the child holds its own dup; keeping ours open pins this process
  }
}

async function waitForRuntime({ timeoutMs = 10_000, pollMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const live = readLiveRuntime();
    if (live) return live;
    await delay(pollMs);
  }
  return null;                        // caller names the log file; a silent nothing is worse
}

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

export async function main(argv = process.argv.slice(2), log = console.log, deps = {}) {
  const [command = 'status', ...rest] = argv;
  const {
    spawnDaemon = spawnDetachedDaemon,
    awaitRuntime = waitForRuntime,
    openUrl = (opener, url) => execFile(opener, [url], () => {}),
    platform = process.platform,
  } = deps;

  switch (command) {
    case 'init':
      runInit({
        settingsPath: userSettingsPath(),
        hooksDir: join(pkgRoot, 'hooks'),
        claudeDir: claudeHome(),
        templatePath: join(pkgRoot, 'commands', 'dashboard.md'),
        nodeBin: process.execPath,
        entry: entryPath(),
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

    // What `/dashboard` runs. `open` assumes a daemon and prints the URL; this one starts the daemon
    // if it has to and prints no token at all, because its output is read back into a Claude Code
    // session and written to that session's transcript on disk.
    case 'dashboard': {
      const already = readLiveRuntime();
      let live = already;
      if (!live) {
        spawnDaemon();
        live = await awaitRuntime();
        if (!live) {
          log('The agentpanel daemon did not come up in time.');
          log(`Check the log: ${logFilePath()}`);
          return 1;
        }
      }
      const opener = OPENERS[platform];
      if (!opener) {
        log(`agentpanel is running on http://127.0.0.1:${live.port} (pid ${live.pid}).`);
        log('No known browser opener on this platform — run `agentpanel open` in a terminal to get');
        log('the sign-in URL, and paste it into a browser yourself.');
        return 0;
      }
      openUrl(opener, `http://127.0.0.1:${live.port}/auth?token=${live.token}`);
      log(`agentpanel is ${already ? 'already running' : 'now running'} on http://127.0.0.1:${live.port} (pid ${live.pid}).`);
      log('Opened in your browser, already signed in. The sign-in URL is deliberately not printed: it');
      log('carries a live token for a server that can approve tool calls.');
      return 0;
    }

    case 'uninstall': {
      const { stopped } = await runUninstall({
        settingsPath: userSettingsPath(), stateDir: stateDir(), claudeDir: claudeHome(), log,
      });
      // A script checking the exit code must be able to tell "removed, and the daemon is gone" from
      // "removed, but a daemon is still holding the port" — returning 0 either way would hide that.
      return stopped ? 0 : 1;
    }

    default:
      log('usage: agentpanel <init|start|stop|status|open|dashboard|uninstall>');
      log(`runtime file: ${runtimeFilePath()}`);
      return 1;
  }
}
