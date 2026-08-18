export function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

const DOT = { running: 'dot running', done: 'dot done', error: 'dot error', stale: 'dot stale' };

export function RunRow({ run, now }) {
  const elapsed = run.status === 'running' ? now - run.startedAt : (run.durationMs ?? 0);
  return (
    <li className={`run ${run.status}`}>
      <span className={DOT[run.status] ?? 'dot'} aria-hidden="true" />
      <span className="agent">{run.agentType ?? 'unknown'}</span>
      <span className="desc" title={run.description ?? ''}>{run.description}</span>
      <span className="elapsed">{formatElapsed(elapsed)}</span>
      {run.status === 'stale'
        ? <span className="badge">stale</span>
        : <span className="sr-only">{`status ${run.status}`}</span>}
    </li>
  );
}
