import { useMemo, useRef, useState } from 'react';
import { applyMention, mentionAt, mentionCandidates } from './mentions.js';
import { droppedPaths, insertPaths } from './dropPaths.js';

// Why the composer knows about `busy` rather than just "disabled": the three controls here are one
// mode switch. While a turn is running the textarea is closed and Interrupt is the live action;
// the moment the turn ends — normally, by interrupt, by reset, or by the session dying — the
// textarea is the live action again. A state where neither is available is a hang report.
export function Composer({ busy, onSend, onInterrupt, onReset, disabledReason, catalog = null }) {
  const [text, setText] = useState('');
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [pending, setPending] = useState(null);
  // Where the caret is, so the mention under it can be found: the token being typed is the one at the
  // caret, not the last one in the draft.
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  // Escape closes the list without touching the draft. Keyed by the offset of the `@` it was closed
  // on, so dismissing one mention does not silence the next one typed further along.
  const [closedAt, setClosedAt] = useState(null);
  // Set when a drop revealed names but no locations, which is what Finder does. Shown next to the
  // composer rather than swallowed, because the draft then holds a bare file name and the user has
  // to know that is all the browser gave up.
  const [dropNotice, setDropNotice] = useState(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);

  const mention = useMemo(() => mentionAt(text, caret), [text, caret]);
  const candidates = useMemo(
    () => (mention === null || mention.start === closedAt ? [] : mentionCandidates(catalog, mention.term)),
    [catalog, mention, closedAt],
  );
  const open = candidates.length > 0;
  const chosen = candidates[Math.min(active, candidates.length - 1)];

  function track(el) {
    if (el) setCaret(el.selectionStart ?? el.value.length);
  }

  function moveCaretTo(position) {
    // The caret has to be moved on the element itself: React controls the value, not the selection,
    // so without this it lands at the end of the draft.
    const el = inputRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(position, position);
    });
  }

  // A drop is read as text, not uploaded: what Claude needs is where the file is, and it already has
  // Read and Glob on the machine the daemon runs on.
  function onDrop(e) {
    setDragging(false);
    if (blocked) return;
    const transfer = e.dataTransfer;
    if (!transfer) return;
    const found = droppedPaths({
      uriList: transfer.getData?.('text/uri-list') ?? '',
      plain: transfer.getData?.('text/plain') ?? '',
      fileNames: [...(transfer.files ?? [])].map((file) => file?.name).filter(Boolean),
    });
    const written = [...found.paths, ...found.unresolved];
    if (written.length === 0) return;
    e.preventDefault();
    const next = insertPaths(text, caret, written);
    setText(next.text);
    setCaret(next.caret);
    moveCaretTo(next.caret);
    setDropNotice(found.unresolved.length === 0 ? null : found.unresolved);
  }

  function accept(candidate) {
    const next = applyMention(text, mention, candidate);
    setText(next.text);
    setCaret(next.caret);
    setActive(0);
    setClosedAt(null);
    moveCaretTo(next.caret);
  }

  const blocked = busy || disabledReason !== null;

  async function send() {
    const body = text.trim();
    if (body === '' || blocked) return;
    setPending('send');
    try {
      await onSend(body);
      setText('');                              // only on success: a failed send must not eat the draft
      setCaret(0);
      setClosedAt(null);
      setDropNotice(null);
    } catch {
      // The failure is already reported in the transcript by whoever owns the session. Swallowing it
      // here keeps the draft the user would otherwise have to retype, and keeps a rejected send from
      // becoming an unhandled rejection in the middle of a keystroke handler.
    } finally {
      // In a `finally` on purpose. An error path that forgets this leaves a composer that never
      // comes back, which looks exactly like a hung daemon.
      setPending(null);
      inputRef.current?.focus();
    }
  }

  async function run(kind, action) {
    setPending(kind);
    try { await action(); }
    finally { setPending(null); }
  }

  return (
    <div className="composer">
      <form
        onSubmit={(e) => { e.preventDefault(); send(); }}
        className={dragging ? 'dragging' : undefined}
        // dragover has to be cancelled or the browser navigates to the dropped file, replacing the
        // dashboard with a file viewer and losing the draft.
        onDragOver={(e) => { e.preventDefault(); if (!blocked) setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <label className="sr-only" htmlFor="composer-input">Message to the orchestrator</label>
        <textarea
          id="composer-input"
          ref={inputRef}
          value={text}
          rows={3}
          disabled={blocked}
          placeholder={blocked ? (disabledReason ?? 'Claude is working…') : 'Message the orchestrator.  @ for agents and skills, Enter to send, Shift+Enter for a new line.'}
          role="combobox"
          aria-expanded={open}
          aria-controls="composer-mentions"
          aria-activedescendant={open ? `mention-${active}` : undefined}
          aria-autocomplete="list"
          onChange={(e) => { setText(e.target.value); setActive(0); track(e.target); }}
          onSelect={(e) => track(e.target)}
          onClick={(e) => track(e.target)}
          onKeyDown={(e) => {
            // While the mention list is open it owns the keys that would otherwise send the message:
            // Enter and Tab take the highlighted entry, the arrows walk it, Escape closes it. An
            // Enter that both inserted a name and sent the draft is the failure to avoid here.
            if (open && !e.nativeEvent.isComposing) {
              if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); accept(chosen); return; }
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % candidates.length); return; }
              if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + candidates.length) % candidates.length); return; }
              if (e.key === 'Escape') { e.preventDefault(); setClosedAt(mention.start); return; }
            }
            // Shift+Enter is a newline; a bare Enter sends. IME composition must be left alone, or
            // every Japanese or Chinese candidate selection would fire the message off half-typed.
            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
            e.preventDefault();
            send();
          }}
        />

        {open && (
          // Above the textarea rather than below it: the composer sits at the bottom of the window,
          // and a list drawn downwards would be off screen.
          <ul className="mentions" id="composer-mentions" role="listbox" aria-label="Agents and skills">
            {candidates.map((candidate, index) => (
              <li
                key={`${candidate.kind}:${candidate.token}`}
                id={`mention-${index}`}
                role="option"
                aria-selected={index === active}
                className={`mention${index === active ? ' active' : ''}`}
                // onMouseDown, not onClick: a click would blur the textarea first, and the mention
                // the caret was in would be gone by the time the handler ran.
                onMouseDown={(e) => { e.preventDefault(); accept(candidate); }}
                onMouseEnter={() => setActive(index)}
              >
                <span className={`chip ${candidate.kind}`}>{candidate.kind}</span>
                <span className="mention-name mono">{candidate.token}</span>
                <span className="mention-desc">{candidate.description}</span>
              </li>
            ))}
          </ul>
        )}
        {dropNotice && (
          <p className="composer-notice" role="status">
            The browser did not reveal where {dropNotice.length === 1 ? dropNotice[0] : `${dropNotice.length} of those files`} live
            {dropNotice.length === 1 ? 's' : ''}, so only the name was written in — Claude will look for it in the project.
            Drop from an editor or a terminal, or paste the full path, to name it exactly.
            <button type="button" className="btn subtle" onClick={() => setDropNotice(null)}>Dismiss</button>
          </p>
        )}

        <div className="composer-actions">
          <span className="composer-hint" aria-live="polite">
            {disabledReason ?? (busy ? 'Claude is working — a tool call needing approval will pause here.' : '')}
          </span>
          {busy
            ? <button type="button" className="btn danger" onClick={() => run('interrupt', onInterrupt)} disabled={pending === 'interrupt'}>
                {pending === 'interrupt' ? 'Interrupting…' : 'Interrupt'}
              </button>
            : <button type="submit" className="btn primary" disabled={blocked || text.trim() === '' || pending === 'send'}>
                {pending === 'send' ? 'Sending…' : 'Send'}
              </button>}
        </div>
      </form>

      <div className="composer-session">
        {confirmingReset
          ? (
            <>
              {/* A reset deletes the transcript as well as the resume id — the daemon clears both
                  together — so it asks first, and says what is lost rather than "are you sure?". */}
              <span className="confirm-text" role="alert">Start over? This discards the conversation and its history.</span>
              <button type="button" className="btn danger" onClick={() => run('reset', async () => { await onReset(); setConfirmingReset(false); })} disabled={pending === 'reset'}>
                {pending === 'reset' ? 'Resetting…' : 'Discard and start over'}
              </button>
              <button type="button" className="btn" onClick={() => setConfirmingReset(false)}>Keep it</button>
            </>
          )
          : <button type="button" className="btn subtle" onClick={() => setConfirmingReset(true)}>New session</button>}
      </div>
    </div>
  );
}
