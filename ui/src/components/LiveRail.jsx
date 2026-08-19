import { RunRow } from './RunRow.jsx';

const rank = (r) => (r.status === 'running' ? 0 : 1);

export function LiveRail({ runs, now }) {
  const ordered = [...runs].sort((a, b) => rank(a) - rank(b) || b.startedAt - a.startedAt);

  return (
    // aria-live: the whole point of this panel is that it changes while the user watches it.
    // Left at the spec default relevance ("additions text") rather than narrowed to "additions
    // removals" — a run finishing or erroring updates its row's badge/status text in place (an
    // addition of a differently-typed node, or a text mutation) rather than adding or removing a
    // list item, and the default set is what actually catches those. The per-second elapsed clock
    // that ticks inside every row is marked aria-hidden in RunRow so it never gets announced.
    <aside className="rail" aria-label="Live agents" aria-live="polite">
      <h2>Live agents</h2>
      {ordered.length === 0
        ? <p className="empty">No agents running. Dispatch one from any Claude Code session and it appears here.</p>
        : <ul>{ordered.map((run) => <RunRow key={run.id} run={run} now={now} />)}</ul>}
    </aside>
  );
}
