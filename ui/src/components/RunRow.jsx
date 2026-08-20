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

// One line saying what the subagent is doing right now, built from the session's own progress events
// rather than from the hook path — the hooks only ever report that a run opened and later closed.
// Returns null when nothing has been reported for this run, which is the normal state for a run
// dispatched from a terminal session rather than from this dashboard's chat.
export function activitySummary(activity) {
  if (!activity) return null;
  if (activity.kind === 'task_notification' && activity.status) return `${activity.status}`;
  if (activity.lastToolName) return `running ${activity.lastToolName}`;
  if (activity.summary) return activity.summary;
  if (activity.kind === 'task_started') return 'starting up';
  return null;
}

const tokens = (usage) => {
  if (usage === null || typeof usage !== 'object') return null;
  const total = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  return total > 0 ? total : null;
};

export function RunRow({ run, now, activity, expanded = false, onToggle }) {
  const elapsed = run.status === 'running' ? now - run.startedAt : (run.durationMs ?? 0);
  const working = run.status === 'running';
  const doing = working ? activitySummary(activity) : null;

  return (
    <li className={`run ${run.status}${expanded ? ' expanded' : ''}`}>
      {/* The whole row is the control. A separate disclosure caret would put a 16px target next to
          a full-width row that looks clickable and is not. */}
      <button
        type="button"
        className="run-head"
        aria-expanded={expanded}
        onClick={() => onToggle?.(run.id)}
      >
        <span className={DOT[run.status] ?? 'dot'} aria-hidden="true" />
        {/* Three bars rising and falling only while the run is actually running: the point is that a
            glance at the rail tells you something is still happening, without reading a clock. It is
            decorative, so it is hidden from assistive technology — the status text below is the real
            signal — and it stops moving entirely under prefers-reduced-motion. */}
        {working && (
          <span className="working" aria-hidden="true">
            <i /><i /><i />
          </span>
        )}
        <span className="agent" title={run.agentType ?? 'unknown'}>{run.agentType ?? 'unknown'}</span>
        <span className="desc" title={run.description ?? ''}>{run.description}</span>
        <span className="elapsed" aria-hidden="true">{formatElapsed(elapsed)}</span>
        {BADGE_STATUSES.has(run.status)
          ? <span className={`badge ${run.status}`}>{run.status}</span>
          : <span className="sr-only">{`status ${run.status}`}</span>}
        {doing && <span className="doing" title={doing}>{doing}</span>}
      </button>

      {expanded && (
        <div className="run-detail">
          <dl>
            <dt>status</dt>
            <dd>
              {run.status}
              {run.status === 'stale' && ' — no completion was ever reported for it'}
            </dd>
            <dt>{run.status === 'running' ? 'running for' : 'took'}</dt>
            <dd className="mono">{formatElapsed(elapsed)}</dd>
            {doing && <><dt>right now</dt><dd>{doing}</dd></>}
            {activity?.elapsedSeconds != null && (
              <><dt>tool elapsed</dt><dd className="mono">{`${Math.round(activity.elapsedSeconds)}s`}</dd></>
            )}
            {tokens(activity?.usage) !== null && (
              <><dt>tokens</dt><dd className="mono">{tokens(activity.usage).toLocaleString()}</dd></>
            )}
            {run.sessionId && <><dt>session</dt><dd className="mono">{run.sessionId}</dd></>}
          </dl>

          {run.prompt
            ? (
              <>
                <p className="tool-label">what it was asked to do</p>
                <pre className="raw run-prompt" tabIndex={0}>{run.prompt}</pre>
              </>
            )
            // The prompt comes from the dispatching hook's payload. A run recorded by an older
            // hook, or one dispatched without a prompt field, genuinely has nothing to show — and
            // saying so beats an empty box that reads as an empty prompt.
            : <p className="empty">No prompt was recorded for this run.</p>}

          {run.resultPreview && (
            <>
              <p className="tool-label">result so far</p>
              <pre className="raw run-prompt" tabIndex={0}>{run.resultPreview}</pre>
            </>
          )}

          {run.transcriptPath && (
            <>
              <p className="tool-label">transcript</p>
              <p className="mono run-path">{run.transcriptPath}</p>
            </>
          )}
        </div>
      )}
    </li>
  );
}
