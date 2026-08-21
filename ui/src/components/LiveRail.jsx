import { useState } from 'react';
import { RunRow } from './RunRow.jsx';
import { finishedIds, runToolUseId, visibleRuns } from './runList.js';

const rank = (r) => (r.status === 'running' ? 0 : 1);

export function LiveRail({ runs, now, taskActivity = {}, projectPath = null }) {
  // One row open at a time, and kept here rather than in App: which row a user has expanded is a
  // property of this panel, and lifting it would re-render the whole shell on every click.
  const [openId, setOpenId] = useState(null);
  // Cleared rows are hidden here and nowhere else: the run is still in the database and still in the
  // Activity page, because "I have read this" is a property of this panel and not of the run.
  const [dismissed, setDismissed] = useState(() => new Set());

  const scoped = visibleRuns(runs, { projectPath, dismissed });
  const ordered = [...scoped].sort((a, b) => rank(a) - rank(b) || b.startedAt - a.startedAt);
  const finished = finishedIds(ordered);

  return (
    // aria-live: the whole point of this panel is that it changes while the user watches it.
    // Left at the spec default relevance ("additions text") rather than narrowed to "additions
    // removals" — a run finishing or erroring updates its row's badge/status text in place (an
    // addition of a differently-typed node, or a text mutation) rather than adding or removing a
    // list item, and the default set is what actually catches those. The per-second elapsed clock
    // that ticks inside every row is marked aria-hidden in RunRow so it never gets announced.
    <aside className="rail" aria-label="Live agents" aria-live="polite">
      <div className="rail-head">
        <h2>Live agents</h2>
        {finished.length > 0 && (
          <button
            type="button"
            className="btn subtle rail-clear"
            onClick={() => setDismissed((prev) => new Set([...prev, ...finished]))}
          >
            Clear finished
          </button>
        )}
      </div>
      {ordered.length === 0
        ? (
          <p className="empty">
            {projectPath === null
              ? 'No agents running. Dispatch one from any Claude Code session and it appears here.'
              : 'No agents running in this project. Dispatch one here, or from a Claude Code session in this directory, and it appears here.'}
          </p>
        )
        : (
          <ul>
            {ordered.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                now={now}
                // Progress events only exist for the project whose session is open in the chat, so a
                // row dispatched from a terminal elsewhere gets undefined here and falls back to
                // what the hooks recorded. That is a gap in the data, not in the row.
                activity={taskActivity[runToolUseId(run)]}
                expanded={openId === run.id}
                onToggle={(id) => setOpenId((current) => (current === id ? null : id))}
              />
            ))}
          </ul>
        )}
    </aside>
  );
}
