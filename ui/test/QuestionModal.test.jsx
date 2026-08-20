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

const draw = (over = {}, onAnswer = vi.fn()) => {
  render(<QuestionModal request={request(over)} queued={1} now={0} onAnswer={onAnswer} selectedProject="/p" />);
  return onAnswer;
};

describe('QuestionModal', () => {
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

  it('escape skips rather than blocking the question', () => {
    const onAnswer = draw();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onAnswer).toHaveBeenCalledWith('q1', 'allow', { answers: {}, notes: {} });
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
