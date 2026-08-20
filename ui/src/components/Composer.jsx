import { useRef, useState } from 'react';

// Why the composer knows about `busy` rather than just "disabled": the three controls here are one
// mode switch. While a turn is running the textarea is closed and Interrupt is the live action;
// the moment the turn ends — normally, by interrupt, by reset, or by the session dying — the
// textarea is the live action again. A state where neither is available is a hang report.
export function Composer({ busy, onSend, onInterrupt, onReset, disabledReason }) {
  const [text, setText] = useState('');
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [pending, setPending] = useState(null);
  const inputRef = useRef(null);

  const blocked = busy || disabledReason !== null;

  async function send() {
    const body = text.trim();
    if (body === '' || blocked) return;
    setPending('send');
    try {
      await onSend(body);
      setText('');                              // only on success: a failed send must not eat the draft
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
      >
        <label className="sr-only" htmlFor="composer-input">Message to the orchestrator</label>
        <textarea
          id="composer-input"
          ref={inputRef}
          value={text}
          rows={3}
          disabled={blocked}
          placeholder={blocked ? (disabledReason ?? 'Claude is working…') : 'Message the orchestrator.  Enter to send, Shift+Enter for a new line.'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Shift+Enter is a newline; a bare Enter sends. IME composition must be left alone, or
            // every Japanese or Chinese candidate selection would fire the message off half-typed.
            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
            e.preventDefault();
            send();
          }}
        />
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
