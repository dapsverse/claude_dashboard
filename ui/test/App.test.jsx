import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
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
