import { RunRow } from './RunRow.jsx';

const rank = (r) => (r.status === 'running' ? 0 : 1);

export function LiveRail({ runs, now }) {
  const ordered = [...runs].sort((a, b) => rank(a) - rank(b) || b.startedAt - a.startedAt);

  return (
    <aside className="rail" aria-label="Live agents">
      <h2>Live agents</h2>
      {ordered.length === 0
        ? <p className="empty">No agents running. Dispatch one from any Claude Code session and it appears here.</p>
        : <ul>{ordered.map((run) => <RunRow key={run.id} run={run} now={now} />)}</ul>}
    </aside>
  );
}
