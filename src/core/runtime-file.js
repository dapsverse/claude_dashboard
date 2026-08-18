import { writeFileSync, readFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { runtimeFilePath } from './paths.js';

export function writeRuntime(info, file = runtimeFilePath()) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(info, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  return info;
}

export function readRuntime(file = runtimeFilePath()) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    // A missing or corrupt file legitimately means "no daemon". Anything else — a permission
    // problem above all — must surface: swallowing it would report "not running" for a daemon
    // that is very much running, and `start` would launch a second one alongside it.
    if (err?.code === 'ENOENT' || err instanceof SyntaxError) return null;
    throw err;
  }
}

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }   // alive but owned by another user
}

export function readLiveRuntime(file = runtimeFilePath()) {
  const info = readRuntime(file);
  return info && isAlive(info.pid) ? info : null;
}

export function clearRuntime(file = runtimeFilePath()) {
  rmSync(file, { force: true });
}

// Two `agentpanel start` invocations racing each other both see no live daemon, both start, and the
// second overwrites the first's runtime file — leaving a live daemon that stop/status/open can never
// see again. An O_EXCL create is the smallest thing that makes the check-then-start sequence atomic.
export function acquireStartLock(file = `${runtimeFilePath()}.lock`) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
      return () => rmSync(file, { force: true });
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      const holder = Number(readFileSync(file, 'utf8').trim());
      if (isAlive(holder)) return null;      // someone else is genuinely starting or running
      rmSync(file, { force: true });         // stale lock from a killed process; take it over
    }
  }
  return null;
}
