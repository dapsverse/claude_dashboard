import { summarizeToolInput, formatToolInput, readStoredInput } from './toolSummary.js';
import { formatElapsed } from './RunRow.jsx';

// A live block carries the raw `input`; one restored from history carries `inputPreview`, the daemon's
// redacted JSON rendering of it. Parsing that back is what keeps a stored call readable — without it
// the summary line is the whole JSON object, which is exactly the thing the summary exists to avoid.
// The parse fails on a preview truncated by the 2000-char cap, and then the raw string is all there is.
function resolveInput(block) {
  if (block?.input !== undefined) return { input: block.input, restored: false, raw: null };
  const raw = typeof block?.inputPreview === 'string' ? block.inputPreview : null;
  return { input: readStoredInput(raw), restored: true, raw };
}

// A tool call inside the transcript: collapsed to one line by default, because a turn with eight of
// them is otherwise unreadable, and expandable to the full input for the times that one line is not
// enough. `<details>` carries the open/closed state, the keyboard interaction and the
// expanded/collapsed announcement without a line of JavaScript.
export function ToolCard({ block }) {
  const { input, restored, raw } = resolveInput(block);
  // Neither shape is silently substituted for the other — the label below says which one is on screen.
  const summary = input === null ? (raw ?? '') : summarizeToolInput(block.name, input);
  const body = input === null ? (raw ?? '') : formatToolInput(input);
  const label = !restored ? 'input'
    : input === null ? 'stored input (redacted, truncated)'
    : 'stored input (redacted)';

  return (
    <details className="tool">
      <summary>
        <span className="tool-name mono">{block.name ?? 'tool'}</span>
        <span className="tool-summary mono">{summary}</span>
      </summary>
      <div className="tool-body">
        <p className="tool-label">{label}</p>
        <pre className="raw" tabIndex={0}>{body}</pre>
        {block.id && <p className="tool-label">id <span className="mono">{block.id}</span></p>}
      </div>
    </details>
  );
}

// A `Task`/`Agent` call is the same dispatch the hook path already put in the live rail. Drawing a
// second tool card for it would show one subagent twice, as two unrelated things; this chip states
// the link instead, and reads its status straight off the rail's row so the two can never disagree.
export function DispatchChip({ block, run, now }) {
  const { input, raw } = resolveInput(block);
  const fields = input ?? {};
  const agentType = run?.agentType ?? fields.subagent_type ?? 'subagent';
  // A dispatch restored from history has no live run row to read from, but its stored preview does
  // carry the description — reaching into the parsed preview keeps the row saying what the subagent
  // was asked to do. The raw string is the last resort, for a preview too long to parse.
  const description = run?.description ?? fields.description ?? (input === null ? (raw ?? '') : '');
  const status = run?.status ?? 'pending';
  const elapsed = run
    ? formatElapsed(run.status === 'running' ? now - run.startedAt : (run.durationMs ?? 0))
    : null;

  return (
    <div className={`dispatch ${status}`}>
      <span className={`dot ${status}`} aria-hidden="true" />
      <span className="dispatch-label">dispatched</span>
      <span className="agent mono">{agentType}</span>
      {description && <span className="desc">{description}</span>}
      {elapsed && <span className="elapsed" aria-hidden="true">{elapsed}</span>}
      <span className="sr-only">
        {run
          ? `subagent ${agentType}, status ${status}, shown in the live agents panel`
          : `subagent ${agentType} dispatched, not yet reported by the live agents panel`}
      </span>
    </div>
  );
}
