import { useEffect, useRef, useState } from 'react';
import { formatToolInput, summarizeToolInput } from './toolSummary.js';

const FOCUSABLE = 'button, [href], textarea, input, select, [tabindex]:not([tabindex="-1"])';

function countdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// The one screen in this dashboard that can cause something to happen on the user's machine, so it
// is built to be read rather than dismissed: the raw input in full, a visible deadline, and no
// default action bound to a stray Enter on the allow side.
export function PermissionModal({ request, queued, now, onDecide, selectedProject }) {
  const [pending, setPending] = useState(null);
  const [failure, setFailure] = useState(null);
  const dialogRef = useRef(null);
  const denyRef = useRef(null);

  // Focus starts on Deny, not on Allow. Whatever a hurried Enter or Space does when this appears
  // over the window the user was typing in, it must not be "approve".
  useEffect(() => {
    denyRef.current?.focus();
    setPending(null);
    setFailure(null);
  }, [request.id]);

  async function decide(decision) {
    setPending(decision);
    setFailure(null);
    try {
      await onDecide(request.id, decision);
    } catch (err) {
      // A prompt the daemon already settled (timeout, interrupt, shutdown) answers 404. Say so
      // plainly; the `permission.resolved` broadcast removes the prompt a moment later either way.
      setFailure(err?.status === 404
        ? 'This request was already settled — it timed out, or the session was interrupted. The tool did not run.'
        : `Could not send the decision (${err?.message ?? 'unknown error'}). The request is still waiting.`);
      setPending(null);
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      // Escape denies rather than closing. There is no "close" for this dialog: the tool call is
      // blocked until it is answered, and dismissing it without an answer would just hide a running
      // clock that ends in an auto-deny anyway.
      e.preventDefault();
      if (pending === null) decide('deny');
      return;
    }
    if (e.key !== 'Tab') return;
    const nodes = [...(dialogRef.current?.querySelectorAll(FOCUSABLE) ?? [])].filter((n) => !n.disabled);
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  const remaining = request.expiresAt == null ? null : request.expiresAt - now;
  const expired = remaining !== null && remaining <= 0;
  const heading = request.title
    ?? (request.restored
      ? `${request.toolName ?? 'A tool'} — input not recoverable after a reload`
      : `${request.toolName ?? 'A tool'} — ${summarizeToolInput(request.toolName, request.input) || 'no input'}`);
  const foreign = request.projectPath && selectedProject && request.projectPath !== selectedProject;

  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="permission-title" ref={dialogRef} onKeyDown={onKeyDown}>
        <header className="modal-head">
          <span className="badge stale">approval needed</span>
          {queued > 1 && <span className="modal-queue">{queued} waiting</span>}
          <span className={`modal-clock mono${expired ? ' expired' : ''}`}>
            {remaining === null ? 'no deadline reported'
              : expired ? 'deadline passed — denying'
              : `auto-denies in ${countdown(remaining)}`}
          </span>
        </header>

        <h2 id="permission-title">{heading}</h2>
        <dl className="modal-meta">
          <dt>tool</dt><dd className="mono">{request.toolName ?? 'unknown'}</dd>
          {request.agentId && <><dt>from subagent</dt><dd className="mono">{request.agentId}</dd></>}
          {request.reason && <><dt>reason</dt><dd>{request.reason}</dd></>}
          {foreign && <><dt>project</dt><dd className="mono">{request.projectPath}</dd></>}
        </dl>
        {request.description && <p className="modal-description">{request.description}</p>}

        {request.restored
          ? (
            // The history endpoint returns a descriptor without the input — it is only ever on the
            // live event. Saying so is the only honest option: approving a call whose arguments are
            // not on screen is not approval, and a blank box would look like an empty command.
            <p className="modal-blind" role="alert">
              The full input for this request is not available after a page reload — only the live
              event carried it. Deny unless you know what asked for it.
            </p>
          )
          : (
            <>
              <p className="tool-label" id="permission-input-label">full input, exactly as the tool received it</p>
              {/* Scrollable, never truncated, and selectable: a decision made on an elided command
                  is a decision made on something other than what will run. */}
              <pre className="raw modal-input" tabIndex={0} aria-labelledby="permission-input-label">
                {formatToolInput(request.input) || '(no input)'}
              </pre>
            </>
          )}

        {failure && <p className="modal-failure" role="alert">{failure}</p>}

        <div className="modal-actions">
          <button type="button" ref={denyRef} className="btn danger" disabled={pending !== null} onClick={() => decide('deny')}>
            {pending === 'deny' ? 'Denying…' : 'Deny'}
          </button>
          <button type="button" className="btn" disabled={pending !== null} onClick={() => decide('allow')}>
            {pending === 'allow' ? 'Allowing…' : 'Allow once'}
          </button>
          <button type="button" className="btn" disabled={pending !== null} onClick={() => decide('always')}>
            {pending === 'always' ? 'Allowing…' : `Always allow ${request.toolName ?? 'this tool'}`}
          </button>
        </div>
        <p className="modal-foot">
          “Always” lasts for this conversation only — it is never written to your settings files.
          Escape denies.
        </p>
      </div>
    </div>
  );
}
