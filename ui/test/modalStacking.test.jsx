import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { App } from '../src/App.jsx';

// Regression coverage for the invisible click trap: `.shell.office-expanded main` fades to
// `opacity: 0`, and a `position: fixed` modal backdrop rendered as a CHILD of `main` inherits that
// opacity (fixed escapes `overflow: hidden` but not an ancestor's opacity) while still catching every
// click meant for it. Layout now renders `modal` as a sibling of `main`, never a child — these tests
// pin that structure from the DOM side, and prove a click still lands on the right button.
class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.listeners = {};
    FakeEventSource.instances.push(this);
  }
  addEventListener(name, handler) { (this.listeners[name] ??= []).push(handler); }
  emit(name, data) {
    for (const handler of this.listeners[name] ?? []) handler({ data: JSON.stringify(data) });
  }
  close() {}
}
FakeEventSource.instances = [];

const RUN = {
  id: 's1:t1', sessionId: 's1', agentType: 'programmer', description: 'add auth',
  status: 'running', startedAt: Date.now(), endedAt: null, durationMs: null,
};

const PERMISSION_REQUEST = {
  id: 'perm-1', projectPath: null, ts: 1000, toolName: 'Write',
  input: { file_path: '/tmp/x' }, toolUseId: 'toolu_1', agentId: null,
  reason: null, title: null, description: null, expiresAt: 301000,
};

const QUESTION_REQUEST = {
  id: 'q-1', projectPath: null, ts: 1000, toolName: 'AskUserQuestion', kind: 'question',
  agentId: null, reason: null, title: null, description: null, expiresAt: null,
  questions: [{
    question: 'Which database?',
    header: 'Database',
    multiSelect: false,
    options: [{ label: 'Postgres', description: 'Relational' }, { label: 'SQLite', description: 'Embedded' }],
  }],
};

// Records every fetch so a click can be proven to have reached `onDecide` (session.decide, which
// posts to `/api/permissions/:id`) rather than just proving the button exists on screen.
function respond(calls) {
  return vi.fn(async (path, options) => {
    calls.push({ path, body: options?.body ? JSON.parse(options.body) : undefined });
    if (path === '/api/runs') return { ok: true, status: 200, json: async () => ({ active: [RUN], recent: [] }) };
    if (path === '/api/catalog') return { ok: true, status: 200, json: async () => ({ agents: [], skills: [] }) };
    if (path.startsWith('/api/permissions/')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, hooksInstalled: true }) };
  });
}

async function expandOffice() {
  const toggle = await screen.findByRole('button', { name: 'Expand office' });
  await act(async () => { fireEvent.click(toggle); });
}

describe('modal placement under the expanded office', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    window.localStorage.clear();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('renders the permission modal outside <main> once the office is expanded', async () => {
    vi.stubGlobal('fetch', respond([]));
    const { container } = render(<App />);
    await screen.findByText('programmer');
    await expandOffice();
    expect(container.querySelector('.shell.office-expanded')).toBeTruthy();

    await act(async () => { FakeEventSource.instances[0].emit('permission.request', PERMISSION_REQUEST); });
    const dialog = await screen.findByRole('dialog');
    const main = container.querySelector('main');
    expect(main).toBeTruthy();
    // The bug: main's opacity: 0 hid the modal while `position: fixed` kept it catching clicks.
    // Being outside main is what makes that impossible regardless of what main's styling does.
    expect(main.contains(dialog)).toBe(false);
  });

  it('lets Deny be clicked and reach the daemon while the office is expanded', async () => {
    const calls = [];
    vi.stubGlobal('fetch', respond(calls));
    render(<App />);
    await screen.findByText('programmer');
    await expandOffice();

    await act(async () => { FakeEventSource.instances[0].emit('permission.request', PERMISSION_REQUEST); });
    await screen.findByRole('dialog');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Deny' })); });

    const decideCall = calls.find((c) => c.path === `/api/permissions/${PERMISSION_REQUEST.id}`);
    expect(decideCall?.body).toEqual({ decision: 'deny' });
  });

  it('still shows and answers the permission modal when the office is NOT expanded (regression)', async () => {
    const calls = [];
    vi.stubGlobal('fetch', respond(calls));
    const { container } = render(<App />);
    await screen.findByText('programmer');
    expect(container.querySelector('.shell.office-expanded')).toBeNull();

    await act(async () => { FakeEventSource.instances[0].emit('permission.request', PERMISSION_REQUEST); });
    const dialog = await screen.findByRole('dialog');
    const main = container.querySelector('main');
    expect(main.contains(dialog)).toBe(false);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Allow once' })); });
    const decideCall = calls.find((c) => c.path === `/api/permissions/${PERMISSION_REQUEST.id}`);
    expect(decideCall?.body).toEqual({ decision: 'allow' });
  });

  it('renders the question modal outside <main> once the office is expanded', async () => {
    vi.stubGlobal('fetch', respond([]));
    const { container } = render(<App />);
    await screen.findByText('programmer');
    await expandOffice();

    await act(async () => { FakeEventSource.instances[0].emit('permission.request', QUESTION_REQUEST); });
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toMatch(/Claude is asking/);
    const main = container.querySelector('main');
    expect(main.contains(dialog)).toBe(false);
  });

  it('lets Skip be clicked and reach the daemon for a question while the office is expanded', async () => {
    const calls = [];
    vi.stubGlobal('fetch', respond(calls));
    render(<App />);
    await screen.findByText('programmer');
    await expandOffice();

    await act(async () => { FakeEventSource.instances[0].emit('permission.request', QUESTION_REQUEST); });
    await screen.findByRole('dialog');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Skip' })); });

    const decideCall = calls.find((c) => c.path === `/api/permissions/${QUESTION_REQUEST.id}`);
    expect(decideCall?.body).toEqual({ decision: 'allow', answers: {}, notes: {} });
  });

  it('still shows and answers the question modal when the office is NOT expanded (regression)', async () => {
    const calls = [];
    vi.stubGlobal('fetch', respond(calls));
    render(<App />);
    await screen.findByText('programmer');

    await act(async () => { FakeEventSource.instances[0].emit('permission.request', QUESTION_REQUEST); });
    await screen.findByRole('dialog');

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Skip' })); });
    const decideCall = calls.find((c) => c.path === `/api/permissions/${QUESTION_REQUEST.id}`);
    expect(decideCall?.body).toEqual({ decision: 'allow', answers: {}, notes: {} });
  });
});
