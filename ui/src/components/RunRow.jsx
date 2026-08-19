export function formatElapsed(ms) {
  // A run with a missing startedAt yields NaN here, and `NaN` formats as the literal string
  // "NaNhNaNm" on screen. A dashboard that displays that has failed at its one job.
  const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

const DOT = { running: 'dot running', done: 'dot done', error: 'dot error', stale: 'dot stale' };

// `done` and `error` must not be distinguished by dot colour alone — a colour-blind user, or a
// greyscale screenshot, needs a second signal. The dot shape carries it (filled circle running,
// hollow circle done, square error); `stale` and `error` additionally get a visible text badge
// instead of the screen-reader-only status label the other two statuses rely on.
const BADGE_STATUSES = new Set(['stale', 'error']);

export function RunRow({ run, now }) {
  const elapsed = run.status === 'running' ? now - run.startedAt : (run.durationMs ?? 0);
  return (
    <li className={`run ${run.status}`}>
      <span className={DOT[run.status] ?? 'dot'} aria-hidden="true" />
      <span className="agent" title={run.agentType ?? 'unknown'}>{run.agentType ?? 'unknown'}</span>
      <span className="desc" title={run.description ?? ''}>{run.description}</span>
      <span className="elapsed" aria-hidden="true">{formatElapsed(elapsed)}</span>
      {BADGE_STATUSES.has(run.status)
        ? <span className={`badge ${run.status}`}>{run.status}</span>
        : <span className="sr-only">{`status ${run.status}`}</span>}
    </li>
  );
}
