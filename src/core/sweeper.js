// src/core/sweeper.js
//
// Periodically stales runs abandoned by a crashed or killed Claude Code process,
// and prunes finished runs past the retention window. The interval is unref()ed
// so it never keeps the daemon process alive on its own.
export function startSweeper({
  runs, hub,
  staleAfterMs = 30 * 60 * 1000,
  retentionMs = 7 * 24 * 60 * 60 * 1000,
  intervalMs = 60 * 1000,
  now = Date.now,
}) {
  const tick = () => {
    const t = now();
    const before = new Set(runs.listActive().map((r) => r.id));
    runs.markStaleBefore(t - staleAfterMs, t);
    runs.pruneBefore(t - retentionMs);
    for (const id of before) {
      const row = runs.get(id);
      if (row && row.status === 'stale') hub.broadcast('run.close', row);
    }
  };

  tick();
  const handle = setInterval(tick, intervalMs);
  handle.unref?.();
  return () => clearInterval(handle);
}
