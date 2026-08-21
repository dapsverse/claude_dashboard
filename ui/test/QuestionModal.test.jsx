import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QuestionModal } from '../src/components/QuestionModal.jsx';
import { addRequest } from '../src/components/permissionQueue.js';

const request = (over = {}) => ({
  id: 'q1',
  projectPath: '/p',
  toolName: 'AskUserQuestion',
  kind: 'question',
  expiresAt: 300_000,
  ts: 0,
  questions: [{
    question: 'Which database?',
    header: 'Database',
    multiSelect: false,
    options: [
      { label: 'Postgres', description: 'Relational', preview: 'CREATE TABLE users' },
      { label: 'SQLite', description: 'Embedded', preview: null },
    ],
  }],
  ...over,
});

const draw = (over = {}, onAnswer = vi.fn(), context = null) => {
  render(<QuestionModal request={request(over)} queued={1} now={0} onAnswer={onAnswer} selectedProject="/p" context={context} />);
  return onAnswer;
};

describe('QuestionModal', () => {
  // The second half of the same bug: the modal covers the transcript it opened over, so a question
  // with no lead-up is a question the user cannot read.
  it('shows what Claude said before asking', () => {
    draw({}, vi.fn(), 'Two ways to store this, and they differ on **durability**.');
    expect(screen.getByText('before asking')).toBeTruthy();
    expect(screen.getByText(/Two ways to store this/)).toBeTruthy();
    expect(screen.getByText('durability')).toBeTruthy();
  });

  it('says the lead-up is missing rather than showing an empty box', () => {
    draw();
    expect(screen.queryByText('before asking')).toBe(null);
    expect(screen.getByText(/lead-up to this question is not in this transcript/)).toBeTruthy();
  });

  it('points at the other project when the question belongs to one', () => {
    render(<QuestionModal request={request({ projectPath: '/other' })} queued={1} now={0} onAnswer={vi.fn()} selectedProject="/p" context={null} />);
    expect(screen.getByText(/switch to it to read the lead-up/)).toBeTruthy();
  });

  it('renders the question, its options, descriptions and previews', () => {
    draw();
    expect(screen.getByText('Which database?')).toBeTruthy();
    expect(screen.getByText('Database')).toBeTruthy();
    expect(screen.getByText('Postgres')).toBeTruthy();
    expect(screen.getByText('Relational')).toBeTruthy();
    expect(screen.getByText('CREATE TABLE users')).toBeTruthy();
  });

  // The whole bug: an Allow button that answers nothing is indistinguishable from silence to the
  // model waiting on the tool result.
  it('cannot be submitted until every question is answered', () => {
    draw();
    const submit = screen.getByRole('button', { name: /send answer/i });
    expect(submit.disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: /Postgres/ }));
    expect(screen.getByRole('button', { name: /send answer/i }).disabled).toBe(false);
  });

  it('sends the picked label as an allow, keyed by the question text', () => {
    const onAnswer = draw();
    fireEvent.click(screen.getByRole('radio', { name: /SQLite/ }));
    fireEvent.click(screen.getByRole('button', { name: /send answer/i }));
    expect(onAnswer).toHaveBeenCalledWith('q1', 'allow', {
      answers: { 'Which database?': 'SQLite' },
      notes: {},
    });
  });

  it('sends the user own words when they choose to answer freely', () => {
    const onAnswer = draw();
    fireEvent.click(screen.getByRole('radio', { name: /Something else/ }));
    fireEvent.change(screen.getByPlaceholderText('your answer'), { target: { value: '  DuckDB  ' } });
    fireEvent.click(screen.getByRole('button', { name: /send answer/i }));
    expect(onAnswer).toHaveBeenCalledWith('q1', 'allow', {
      answers: { 'Which database?': 'DuckDB' },
      notes: {},
    });
  });

  it('carries an optional note alongside the answer', () => {
    const onAnswer = draw();
    fireEvent.click(screen.getByRole('radio', { name: /Postgres/ }));
    fireEvent.change(screen.getByPlaceholderText(/add a note/i), { target: { value: 'we already run it' } });
    fireEvent.click(screen.getByRole('button', { name: /send answer/i }));
    expect(onAnswer).toHaveBeenCalledWith('q1', 'allow', {
      answers: { 'Which database?': 'Postgres' },
      notes: { 'Which database?': 'we already run it' },
    });
  });

  it('sends every checked label for a multi-select question', () => {
    const onAnswer = draw({
      questions: [{
        question: 'Which features?',
        header: 'Features',
        multiSelect: true,
        options: [
          { label: 'auth', description: 'a' },
          { label: 'billing', description: 'b' },
          { label: 'search', description: 'c' },
        ],
      }],
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /auth/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /search/ }));
    fireEvent.click(screen.getByRole('button', { name: /send answer/i }));
    expect(onAnswer).toHaveBeenCalledWith('q1', 'allow', {
      answers: { 'Which features?': ['auth', 'search'] },
      notes: {},
    });
  });

  // Skip is an `allow` with no answers on purpose: that is the tool's own no-answer path, and the
  // model is told plainly that the questions went unanswered.
  it('skips as an allow with no answers, not as a denial', () => {
    const onAnswer = draw();
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(onAnswer).toHaveBeenCalledWith('q1', 'allow', { answers: {}, notes: {} });
  });

  // Escape used to skip, which is how the one key that clears a modal out of the way came to tell
  // Claude that nobody replied.
  it('escape minimizes and answers nothing', () => {
    const onAnswer = draw();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onAnswer).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBe(null);
    expect(screen.getByRole('button', { name: /back to the question/i })).toBeTruthy();
  });

  it('minimizes to a dock that uncovers the transcript, and reopens', () => {
    const onAnswer = draw();
    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }));
    expect(onAnswer).not.toHaveBeenCalled();
    expect(document.querySelector('.modal-backdrop')).toBe(null);
    fireEvent.click(screen.getByRole('button', { name: /back to the question/i }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Which database?')).toBeTruthy();
  });

  // The whole point of minimizing is to go and read the lead-up, then come back and answer. Losing
  // the choice on the way would make it a worse Skip.
  it('keeps the answers already picked across a minimize', () => {
    const onAnswer = draw();
    fireEvent.click(screen.getByRole('radio', { name: /SQLite/ }));
    fireEvent.change(screen.getByPlaceholderText(/add a note/i), { target: { value: 'small dataset' } });
    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }));
    expect(screen.getByRole('button', { name: /1\/1 answered/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /back to the question/i }));
    expect(screen.getByRole('radio', { name: /SQLite/ }).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /send answer/i }));
    expect(onAnswer).toHaveBeenCalledWith('q1', 'allow', {
      answers: { 'Which database?': 'SQLite' },
      notes: { 'Which database?': 'small dataset' },
    });
  });

  it('keeps the deadline visible while minimized', () => {
    render(<QuestionModal request={request({ expiresAt: 90_000 })} queued={2} now={0} onAnswer={vi.fn()} selectedProject="/p" context={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Minimize' }));
    expect(screen.getByText('expires in 1:30')).toBeTruthy();
    expect(screen.getByText('2 waiting')).toBeTruthy();
  });

  it('dismiss denies, so a question can still be blocked outright', () => {
    const onAnswer = draw();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onAnswer).toHaveBeenCalledWith('q1', 'deny', {});
  });

  it('reports a question the daemon had already settled instead of closing silently', async () => {
    const onAnswer = vi.fn().mockRejectedValue(Object.assign(new Error('unknown_request'), { status: 404 }));
    draw({}, onAnswer);
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('counts progress across several questions', () => {
    draw({
      questions: [
        { question: 'A?', header: 'A', multiSelect: false, options: [{ label: 'a1', description: '' }, { label: 'a2', description: '' }] },
        { question: 'B?', header: 'B', multiSelect: false, options: [{ label: 'b1', description: '' }, { label: 'b2', description: '' }] },
      ],
    });
    expect(screen.getByRole('button', { name: 'Send 0/2 answers' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: /a1/ }));
    expect(screen.getByRole('button', { name: 'Send 1/2 answers' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: /b2/ }));
    expect(screen.getByRole('button', { name: 'Send 2/2 answers' }).disabled).toBe(false);
  });
});

describe('permissionQueue question handling', () => {
  it('keeps the kind and the questions off the event', () => {
    const [entry] = addRequest([], { id: 'q1', kind: 'question', questions: [{ question: 'x?' }], toolName: 'AskUserQuestion' });
    expect(entry.kind).toBe('question');
    expect(entry.questions).toEqual([{ question: 'x?' }]);
  });

  it('treats anything else as an ordinary approval prompt', () => {
    const [entry] = addRequest([], { id: 'p1', toolName: 'Bash', input: { command: 'ls' } });
    expect(entry.kind).toBe('tool');
    expect(entry.questions).toBeNull();
  });

  // The live event and the restored descriptor arrive in either order and only one is guaranteed to
  // carry the questions; a later payload without them must not blank the modal.
  it('does not let a later payload erase questions already on screen', () => {
    const queue = addRequest([], { id: 'q1', kind: 'question', questions: [{ question: 'x?' }] });
    const [entry] = addRequest(queue, { id: 'q1', kind: 'question', ts: 5 });
    expect(entry.questions).toEqual([{ question: 'x?' }]);
  });
});
