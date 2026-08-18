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
