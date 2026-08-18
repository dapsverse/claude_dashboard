import { RunRow } from './RunRow.jsx';

const rank = (r) => (r.status === 'running' ? 0 : 1);

export function LiveRail({ runs, now }) {
  const ordered = [...runs].sort((a, b) => rank(a) - rank(b) || b.startedAt - a.startedAt);

  return (
    // aria-live: the whole point of this panel is that it changes while the user watches it.
    // Without it, a screen-reader user is told the rail exists once and never hears that anything
    // started, finished, or failed.
    <aside className="rail" aria-label="Live agents" aria-live="polite" aria-relevant="additions removals">
      <h2>Live agents</h2>
      {ordered.length === 0
        ? <p className="empty">No agents running. Dispatch one from any Claude Code session and it appears here.</p>
        : <ul>{ordered.map((run) => <RunRow key={run.id} run={run} now={now} />)}</ul>}
    </aside>
  );
}
