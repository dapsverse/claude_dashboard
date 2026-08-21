import { useEffect, useMemo, useRef, useState } from 'react';
import { Markdown } from './Markdown.jsx';

const FOCUSABLE = 'button, [href], textarea, input, select, [tabindex]:not([tabindex="-1"])';

const OTHER = '__other__';

// AskUserQuestion reaches the dashboard through the same gate as every other tool, because the CLI
// makes the host its question renderer: its own permission check always answers "ask", and the tool
// result reads "The user did not answer the questions." unless the allow carries the answers back.
// So this is not an approval prompt with extra text — it is the answer sheet, and an Allow button
// with nothing to fill in is indistinguishable from silence to the model waiting on it.
// No countdown anywhere in here on purpose: the daemon gives a question no deadline, so there is
// nothing to count down to. A clock on a question only rushes the answer it was supposed to help.
export function QuestionModal({ request, queued, onAnswer, selectedProject, context = null }) {
  const questions = useMemo(
    () => (Array.isArray(request.questions) ? request.questions : []),
    [request.questions],
  );

  // Keyed by question text — the same key the tool's own `answers` map uses, so nothing has to be
  // matched up by index on the way out.
  const [picked, setPicked] = useState({});     // question -> label | OTHER | label[]
  const [custom, setCustom] = useState({});     // question -> free text for the OTHER choice
  const [notes, setNotes] = useState({});       // question -> optional note
  const [pending, setPending] = useState(null);
  const [failure, setFailure] = useState(null);
  // Minimized is a view of the same open request, not a decision about it: the tool is still
  // blocked and the answers already typed are still here. It exists because the lead-up to a
  // question lives in the transcript this modal covers, and a preamble excerpt is not the same as
  // being able to scroll back and read the thing.
  const [minimized, setMinimized] = useState(false);
  const dialogRef = useRef(null);
  const firstRef = useRef(null);
  const dockRef = useRef(null);

  useEffect(() => {
    setPicked({});
    setCustom({});
    setNotes({});
    setPending(null);
    setFailure(null);
    setMinimized(false);
  }, [request.id]);

  // Focus follows the state, both ways: into the answer sheet when it opens or reopens, onto the
  // dock's own button when it collapses — a minimize that left focus on a removed node would drop
  // the keyboard user back to the top of the document.
  useEffect(() => {
    if (minimized) dockRef.current?.focus();
    else firstRef.current?.focus();
  }, [minimized, request.id]);

  // What actually goes on the wire: the label for a single choice, an array for a multi-select (the
  // daemon joins it), or the user's own words when they chose "Something else".
  const answers = useMemo(() => {
    const out = {};
    for (const q of questions) {
      const choice = picked[q.question];
      if (q.multiSelect) {
        const labels = Array.isArray(choice) ? choice : [];
        const own = (custom[q.question] ?? '').trim();
        const all = own === '' ? labels : [...labels, own];
        if (all.length > 0) out[q.question] = all;
        continue;
      }
      if (choice === OTHER) {
        const own = (custom[q.question] ?? '').trim();
        if (own !== '') out[q.question] = own;
        continue;
      }
      if (typeof choice === 'string') out[q.question] = choice;
    }
    return out;
  }, [questions, picked, custom]);

  const trimmedNotes = useMemo(() => {
    const out = {};
    for (const [key, value] of Object.entries(notes)) {
      const text = (value ?? '').trim();
      if (text !== '') out[key] = text;
    }
    return out;
  }, [notes]);

  const answered = questions.filter((q) => answers[q.question] !== undefined).length;
  const complete = questions.length > 0 && answered === questions.length;

  async function send(decision, body) {
    setPending(decision);
    setFailure(null);
    try {
      await onAnswer(request.id, decision, body);
    } catch (err) {
      setFailure(err?.status === 404
        ? 'This question was already settled — the session was interrupted, reset, or shut down. Your answer was not delivered.'
        : `Could not send the answer (${err?.message ?? 'unknown error'}). The question is still waiting.`);
      setPending(null);
    }
  }

  // Skip is an `allow` with no answers on purpose. That is the tool's own no-answer path: the model
  // is told plainly that the questions went unanswered, which is what the user just chose. Denying
  // instead would report a blocked tool call and say nothing about the user's intent.
  const skip = () => send('allow', { answers: {}, notes: {} });
  const submit = () => send('allow', { answers, notes: trimmedNotes });
  const dismiss = () => send('deny', {});

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      // Escape minimizes; it does not answer. It used to skip, which meant the one key a user
      // presses to get a modal out of the way told Claude nobody replied — and the reason they
      // wanted it out of the way was to read the transcript before replying.
      e.preventDefault();
      setMinimized(true);
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

  function toggleMulti(question, label) {
    setPicked((prev) => {
      const current = Array.isArray(prev[question]) ? prev[question] : [];
      const next = current.includes(label) ? current.filter((l) => l !== label) : [...current, label];
      return { ...prev, [question]: next };
    });
  }

  const foreign = request.projectPath && selectedProject && request.projectPath !== selectedProject;

  // Collapsed: no backdrop, so the transcript underneath scrolls and can be read. Deliberately not
  // a dismissal — the dock stays on screen for as long as the question is open. Since the question
  // never expires, this bar is the only thing that says Claude is still waiting.
  if (minimized) {
    return (
      <div className="question-dock" role="status">
        <span className="badge asking">Claude is asking</span>
        {queued > 1 && <span className="modal-queue">{queued} waiting</span>}
        <button
          type="button"
          className="btn primary"
          ref={dockRef}
          onClick={() => setMinimized(false)}
        >
          {answered > 0 ? `Back to the question (${answered}/${questions.length} answered)` : 'Back to the question'}
        </button>
      </div>
    );
  }

  return (
    <div className="modal-backdrop">
      <div className="modal question" role="dialog" aria-modal="true" aria-labelledby="question-title" ref={dialogRef} onKeyDown={onKeyDown}>
        <header className="modal-head">
          <span className="badge asking">Claude is asking</span>
          {queued > 1 && <span className="modal-queue">{queued} waiting</span>}
          <button type="button" className="btn subtle modal-minimize" onClick={() => setMinimized(true)}>
            Minimize
          </button>
        </header>

        <h2 id="question-title">
          {questions.length === 0 ? 'Claude asked something this dashboard cannot render'
            : questions.length === 1 ? 'One question before continuing'
            : `${questions.length} questions before continuing`}
        </h2>
        {foreign && <p className="modal-description mono">{request.projectPath}</p>}

        {/* The run-up to the question, from the transcript this modal is covering. A question is
            written to be read after the paragraph that sets it up, and the modal opens over any
            page — so leaving this out is how "which of these two?" arrives with no "these two".
            Absent rather than empty when the transcript cannot show it: an empty box would read as
            "Claude said nothing", which is a different claim. */}
        {context === null
          ? (
            <p className="qcontext-missing">
              {foreign
                ? 'What Claude said before asking is in that project\u2019s chat — switch to it to read the lead-up.'
                : 'The lead-up to this question is not in this transcript. Minimize to look for it in the chat, answer from the question itself, or dismiss it and ask Claude to explain.'}
            </p>
          )
          : (
            <div className="qcontext">
              <span className="qcontext-label mono">before asking</span>
              <div className="qcontext-body" tabIndex={0}><Markdown source={context} /></div>
            </div>
          )}

        {questions.length === 0 && (
          // Only reachable against a daemon that broadcast `kind: 'question'` without the questions
          // themselves. There is nothing to answer, and pretending otherwise would send an empty
          // answer set that reads to the model as a deliberate skip.
          <p className="modal-blind" role="alert">
            The questions did not arrive with this request, so there is nothing to answer here. Skip
            to let Claude carry on, or dismiss to block it.
          </p>
        )}

        <div className="qlist">
          {questions.map((q, qi) => {
            const choice = picked[q.question];
            const showCustom = q.multiSelect || choice === OTHER;
            return (
              <fieldset className="qblock" key={q.question}>
                <legend>
                  {q.header && <span className="chip">{q.header}</span>}
                  <span className="qtext">{q.question}</span>
                </legend>

                {q.options.map((option, oi) => {
                  const checked = q.multiSelect
                    ? Array.isArray(choice) && choice.includes(option.label)
                    : choice === option.label;
                  return (
                    <label className={`qopt${checked ? ' picked' : ''}`} key={option.label}>
                      <input
                        ref={qi === 0 && oi === 0 ? firstRef : undefined}
                        type={q.multiSelect ? 'checkbox' : 'radio'}
                        name={`q${qi}`}
                        checked={checked}
                        disabled={pending !== null}
                        onChange={() => (q.multiSelect
                          ? toggleMulti(q.question, option.label)
                          : setPicked((prev) => ({ ...prev, [q.question]: option.label })))}
                      />
                      <span className="qopt-body">
                        <span className="qopt-label">{option.label}</span>
                        {option.description && <span className="qopt-desc">{option.description}</span>}
                        {/* The preview is the whole point of the option for some questions — a
                            mockup or a snippet the choice is *about* — so it is shown in full and
                            scrolled rather than elided. */}
                        {option.preview && <pre className="raw qopt-preview" tabIndex={0}>{option.preview}</pre>}
                      </span>
                    </label>
                  );
                })}

                {!q.multiSelect && (
                  <label className={`qopt${choice === OTHER ? ' picked' : ''}`}>
                    <input
                      type="radio"
                      name={`q${qi}`}
                      checked={choice === OTHER}
                      disabled={pending !== null}
                      onChange={() => setPicked((prev) => ({ ...prev, [q.question]: OTHER }))}
                    />
                    <span className="qopt-body">
                      <span className="qopt-label">Something else</span>
                      <span className="qopt-desc">Answer in your own words instead of picking one of the above.</span>
                    </span>
                  </label>
                )}

                {showCustom && (
                  <input
                    type="text"
                    className="qinput"
                    placeholder={q.multiSelect ? 'and/or your own answer (optional)' : 'your answer'}
                    value={custom[q.question] ?? ''}
                    disabled={pending !== null}
                    onChange={(e) => setCustom((prev) => ({ ...prev, [q.question]: e.target.value }))}
                  />
                )}

                <input
                  type="text"
                  className="qinput note"
                  placeholder="add a note for Claude (optional)"
                  value={notes[q.question] ?? ''}
                  disabled={pending !== null}
                  onChange={(e) => setNotes((prev) => ({ ...prev, [q.question]: e.target.value }))}
                />
              </fieldset>
            );
          })}
        </div>

        {failure && <p className="modal-failure" role="alert">{failure}</p>}

        <div className="modal-actions">
          <button type="button" className="btn primary" disabled={pending !== null || !complete} onClick={submit}>
            {pending === 'allow' && complete ? 'Sending…' : questions.length === 1 ? 'Send answer' : `Send ${answered}/${questions.length} answers`}
          </button>
          <button type="button" className="btn" disabled={pending !== null} onClick={skip}>
            {pending === 'allow' && !complete ? 'Skipping…' : 'Skip'}
          </button>
          <button type="button" className="btn subtle" disabled={pending !== null} onClick={dismiss}>
            {pending === 'deny' ? 'Dismissing…' : 'Dismiss'}
          </button>
        </div>
        <p className="modal-foot">
          Minimize keeps the question open and uncovers the chat behind it — nothing is sent and
          your answers so far are kept. Skip tells Claude the questions went unanswered and lets it
          carry on. Dismiss blocks the question instead. Escape minimizes.
        </p>
      </div>
    </div>
  );
}
