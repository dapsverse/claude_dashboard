import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { App } from '../src/App.jsx';

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

describe('App office call signals', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('raises the boss handset when the user presses Send without waiting for an assistant event', async () => {
    FakeEventSource.instances = [];
    window.localStorage.clear();
    window.history.replaceState(null, '', '/');
    vi.stubGlobal('EventSource', FakeEventSource);
    const fallback = respond();
    const fetchMock = vi.fn(async (path, options) => {
      if (path === '/api/projects') return { ok: true, json: async () => ({ projects: [{ path: '/project', name: 'project' }] }) };
      if (path.startsWith('/api/chat/history')) return { ok: true, json: async () => ({ messages: [], pendingPermissions: [] }) };
      return fallback(path, options);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<App />);
    const input = await screen.findByRole('combobox', { name: 'Message to the orchestrator' });
    await waitFor(() => expect(input.disabled).toBe(false));
    const boss = () => container.querySelector('.sprite[data-run-id="__orchestrator__"]');
    expect(boss().querySelector('.sprite-phone')).toBeNull();
    fireEvent.change(input, { target: { value: 'hello' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })));
    expect(fetchMock).toHaveBeenCalledWith('/api/chat', expect.objectContaining({ method: 'POST' }));
    expect(boss().querySelector('.sprite-phone')).toBeTruthy();
  });

  it('derives calls from both message roles and holds the boss for every open modal', async () => {
    FakeEventSource.instances = [];
    window.localStorage.clear();
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('fetch', respond({ runs: { active: [{ ...RUN, agentId: 'worker-a' }], recent: [] } }));
    const { container } = render(<App />);
    await screen.findByText('programmer');
    const sprite = (id) => container.querySelector(`.sprite[data-run-id="${id}"]`);
    const stream = FakeEventSource.instances[0];
    const request = { id: 'worker-p', agentId: 'worker-a', projectPath: null, kind: 'question', toolName: 'AskUserQuestion' };

    await act(async () => { stream.emit('permission.request', request); });
    expect(sprite(RUN.id).getAttribute('data-state')).toBe('oncall');
    expect(sprite('__orchestrator__').getAttribute('data-state')).toBe('oncall');
    await act(async () => { stream.emit('permission.request', { ...request, id: 'boss-p', agentId: null }); });
    expect(sprite('__orchestrator__').getAttribute('data-state')).toBe('oncall');
    await act(async () => { stream.emit('permission.resolved', { id: 'worker-p' }); });
    expect(sprite(RUN.id).getAttribute('data-state')).not.toBe('oncall');
    expect(sprite('__orchestrator__').getAttribute('data-state')).toBe('oncall');
    await act(async () => { stream.emit('permission.resolved', { id: 'boss-p' }); });
    expect(sprite('__orchestrator__').getAttribute('data-state')).toBe('idle');

    await act(async () => {
      stream.emit('chat.message', { projectPath: null, role: 'user', messageId: 'u', ts: 1000, blocks: [{ type: 'text', text: 'hello' }] });
    });
    expect(sprite('__orchestrator__').getAttribute('data-state')).toBe('oncall');
    await act(async () => {
      stream.emit('chat.message', { projectPath: null, role: 'assistant', messageId: 'a', ts: 2000, blocks: [{ type: 'text', text: 'reply' }] });
    });
    expect(sprite('__orchestrator__').getAttribute('data-state')).toBe('oncall');
  });
});

function respond({ runs = { active: [RUN], recent: [] }, runsStatus = 200 } = {}) {
  return vi.fn(async (path) => {
    if (path === '/api/runs') {
      if (runsStatus !== 200) return { ok: false, status: runsStatus };
      return { ok: true, status: 200, json: async () => runs };
    }
    if (path === '/api/catalog') return { ok: true, status: 200, json: async () => ({ agents: [], skills: [] }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, hooksInstalled: true }) };
  });
}

describe('App connection errors', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('says nothing while the daemon is reachable', async () => {
    vi.stubGlobal('fetch', respond());
    render(<App />);
    await screen.findByText('programmer');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('reports a dropped stream without blanking the rows it already has', async () => {
    vi.stubGlobal('fetch', respond());
    render(<App />);
    await screen.findByText('programmer');

    await act(async () => { FakeEventSource.instances[0].onerror(); });

    const notice = await screen.findByRole('status');
    expect(notice.textContent).toMatch(/lost the connection/i);
    expect(notice.textContent).toMatch(/agentpanel open/);
    // The run the rail was already showing must survive: it is the only state the user has left.
    expect(screen.getByText('programmer')).toBeTruthy();
  });

  it('names the stale-token case when the snapshot comes back 401', async () => {
    vi.stubGlobal('fetch', respond({ runsStatus: 401 }));
    render(<App />);
    const notice = await screen.findByRole('status');
    expect(notice.textContent).toMatch(/session expired/i);
    expect(notice.textContent).toMatch(/agentpanel open/);
  });

  it('reports a failed snapshot fetch rather than swallowing it', async () => {
    vi.stubGlobal('fetch', respond({ runsStatus: 500 }));
    render(<App />);
    const notice = await screen.findByRole('status');
    expect(notice.textContent).toMatch(/request_failed_500/);
  });

  it('clears the notice once the stream delivers again', async () => {
    vi.stubGlobal('fetch', respond());
    render(<App />);
    await screen.findByText('programmer');
    await act(async () => { FakeEventSource.instances[0].onerror(); });
    await screen.findByRole('status');

    await act(async () => {
      FakeEventSource.instances[0].emit('run.close', { ...RUN, status: 'done', endedAt: RUN.startedAt + 1000, durationMs: 1000 });
    });

    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });
});

describe('App event routing', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    window.localStorage.clear();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const REQUEST = {
    id: 'p1', projectPath: '/Users/me/proj', ts: 1000, toolName: 'Write',
    input: { file_path: '/tmp/x' }, toolUseId: 'toolu_1', agentId: null,
    reason: null, title: null, description: null, expiresAt: 301000,
  };

  it('files a chat event with the chat, never as a row in the live rail', async () => {
    vi.stubGlobal('fetch', respond());
    render(<App />);
    await screen.findByText('programmer');

    // A `permission.request` carries an `id` of its own: routed by payload shape rather than by
    // event name, it would be filed in the rail as if it were a subagent.
    await act(async () => {
      FakeEventSource.instances[0].emit('permission.request', REQUEST);
      FakeEventSource.instances[0].emit('chat.message', {
        projectPath: '/Users/me/proj', ts: 1000, messageId: 'm1', blocks: [{ type: 'text', text: 'hi' }],
      });
    });

    const rail = screen.getByLabelText('Live agents');
    expect(rail.textContent).not.toMatch(/Write/);
    expect(rail.textContent).not.toMatch(/p1/);
  });

  it('puts an approval prompt above the page, so it cannot be walked away from', async () => {
    vi.stubGlobal('fetch', respond());
    render(<App />);
    await screen.findByText('programmer');

    await act(async () => { FakeEventSource.instances[0].emit('permission.request', REQUEST); });
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toMatch(/approval needed/);

    // Navigating to another section leaves the prompt on screen: the tool call is still blocked.
    await act(async () => { screen.getByText('Agents').click(); });
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  // AskUserQuestion arrives through the same channel as an approval prompt because the CLI makes the
  // host its question renderer. Drawing the approval modal for it is what left the user clicking
  // Allow and the model reporting that nobody answered.
  it('draws the answer sheet for a question, not the approval prompt', async () => {
    vi.stubGlobal('fetch', respond());
    render(<App />);
    await screen.findByText('programmer');

    await act(async () => {
      FakeEventSource.instances[0].emit('permission.request', {
        ...REQUEST,
        toolName: 'AskUserQuestion',
        kind: 'question',
        questions: [{
          question: 'Which database?',
          header: 'Database',
          multiSelect: false,
          options: [{ label: 'Postgres', description: 'Relational' }, { label: 'SQLite', description: 'Embedded' }],
        }],
      });
    });

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toMatch(/Claude is asking/);
    expect(dialog.textContent).not.toMatch(/approval needed/);
    expect(dialog.textContent).toMatch(/Which database\?/);
    expect(screen.getByRole('radio', { name: /Postgres/ })).toBeTruthy();
    // "Always allow" would let a session rule answer every later question with silence.
    expect(dialog.textContent).not.toMatch(/Always allow/);
  });

  // The event carries `ids`, not `id`. Routed by payload shape it is dropped on the floor, and the
  // tab that did not press the button keeps showing rows the daemon has already put away.
  it('hides rows another tab cleared', async () => {
    vi.stubGlobal('fetch', respond({
      runs: { active: [RUN], recent: [{ ...RUN, id: 's1:t2', agentType: 'qa', status: 'stale', durationMs: 1_800_000, stopReason: 'rate_limit' }] },
    }));
    render(<App />);
    await screen.findByText('qa');

    await act(async () => { FakeEventSource.instances[0].emit('run.dismiss', { ids: ['s1:t2'] }); });

    await waitFor(() => expect(screen.queryByText('qa')).toBeNull());
    // Only the rows it named: the running one was never dismissible in the first place.
    expect(screen.getByText('programmer')).toBeTruthy();
  });

  it('removes the prompt when the daemon reports it settled by anything at all', async () => {
    vi.stubGlobal('fetch', respond());
    render(<App />);
    await screen.findByText('programmer');

    await act(async () => { FakeEventSource.instances[0].emit('permission.request', REQUEST); });
    await screen.findByRole('dialog');
    await act(async () => {
      FakeEventSource.instances[0].emit('permission.resolved', { id: 'p1', projectPath: '/Users/me/proj', decision: 'timeout', ts: 2000 });
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
