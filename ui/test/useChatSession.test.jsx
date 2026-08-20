import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { useChatSession } from '../src/useChatSession.js';

const PROJECT = '/Users/me/proj';
const OTHER = '/Users/me/other';

const projects = [
  { path: PROJECT, name: 'proj', addedAt: 1, lastUsedAt: 3 },
  { path: OTHER, name: 'other', addedAt: 2, lastUsedAt: 2 },
];

const emptyHistory = (path) => ({
  projectPath: path, sessionId: null, running: false, pendingPermissions: [], messages: [],
});

// The hook is the whole of the chat page's behaviour, so it is exercised through a probe that keeps
// the latest value it returned rather than through the page: what matters here is the state machine,
// not the markup, and the markup has its own tests.
function harness({ history, projectList = projects, deferHistory = false, posts = {} } = {}) {
  const captured = { current: null };
  let releaseHistory = () => {};
  const historyGate = new Promise((resolve) => { releaseHistory = resolve; });

  const fetchMock = vi.fn(async (path, options) => {
    const method = options?.method ?? 'GET';
    if (method === 'POST') {
      const body = JSON.parse(options.body);
      const responder = posts[path] ?? posts[path.replace(/\/[^/]+$/, '/:id')];
      const result = responder ? await responder(body) : { ok: true, status: 200, payload: { ok: true } };
      return { ok: result.ok, status: result.status, json: async () => result.payload };
    }
    if (path === '/api/projects') {
      return { ok: true, status: 200, json: async () => ({ projects: projectList }) };
    }
    if (path.startsWith('/api/chat/history')) {
      if (deferHistory) await historyGate;
      const requested = decodeURIComponent(new URL(path, 'http://x').searchParams.get('projectPath'));
      return { ok: true, status: 200, json: async () => (history ?? emptyHistory(requested)) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
  vi.stubGlobal('fetch', fetchMock);

  function Probe() {
    captured.current = useChatSession();
    return <span data-testid="status">{captured.current.chat.status}</span>;
  }

  return { captured, fetchMock, releaseHistory, Probe };
}

const session = (captured) => captured.current;

describe('useChatSession — project selection', () => {
  beforeEach(() => { window.localStorage.clear(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('restores the stored project', async () => {
    window.localStorage.setItem('agentpanel.project', OTHER);
    const { captured, Probe } = harness();
    render(<Probe />);
    await waitFor(() => expect(session(captured).selected).toBe(OTHER));
  });

  it('falls back to the most recently used project when nothing is stored', async () => {
    const { captured, Probe } = harness();
    render(<Probe />);
    await waitFor(() => expect(session(captured).selected).toBe(PROJECT));
  });

  it('ignores a stored project that is no longer in the list', async () => {
    window.localStorage.setItem('agentpanel.project', '/gone');
    const { captured, Probe } = harness();
    render(<Probe />);
    await waitFor(() => expect(session(captured).selected).toBe(PROJECT));
  });

  it('selects nothing, and says why, when the project list cannot be read', async () => {
    const { captured, Probe } = harness();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    render(<Probe />);
    await waitFor(() => expect(session(captured).projectsError).toBe('request_failed_500'));
    expect(session(captured).selected).toBeNull();
  });

  it('remembers a switch for the next page load', async () => {
    const { captured, Probe } = harness();
    render(<Probe />);
    await waitFor(() => expect(session(captured).selected).toBe(PROJECT));
    await act(async () => { session(captured).select(OTHER); });
    expect(window.localStorage.getItem('agentpanel.project')).toBe(OTHER);
    await waitFor(() => expect(session(captured).selected).toBe(OTHER));
  });

  it('adds a project and switches to it', async () => {
    const { captured, fetchMock, Probe } = harness({
      posts: { '/api/projects': async (body) => ({ ok: true, status: 201, payload: { project: { path: body.path, name: 'new' } } }) },
    });
    render(<Probe />);
    await waitFor(() => expect(session(captured).selected).toBe(PROJECT));
    await act(async () => { await session(captured).addProject('/Users/me/new'); });
    await waitFor(() => expect(session(captured).selected).toBe('/Users/me/new'));

    // `create` is never inferred: an add that was not asked to make a folder must not ask for one.
    const body = JSON.parse(fetchMock.mock.calls.findLast(([p, o]) => p === '/api/projects' && o?.method === 'POST')[1].body);
    expect(body).toEqual({ path: '/Users/me/new', create: false });
  });

  it('passes the create flag through only when the caller asked for it', async () => {
    const { captured, fetchMock, Probe } = harness({
      posts: { '/api/projects': async (body) => ({ ok: true, status: 201, payload: { project: { path: body.path, name: 'new' }, created: true } }) },
    });
    render(<Probe />);
    await waitFor(() => expect(session(captured).selected).toBe(PROJECT));
    await act(async () => { await session(captured).addProject('/Users/me/new', { create: true }); });

    const body = JSON.parse(fetchMock.mock.calls.findLast(([p, o]) => p === '/api/projects' && o?.method === 'POST')[1].body);
    expect(body).toEqual({ path: '/Users/me/new', create: true });
  });

  it('surfaces the daemon\'s reason so the switcher can offer the next step', async () => {
    const { captured, Probe } = harness({
      posts: { '/api/projects': async () => ({ ok: false, status: 400, payload: { error: 'missing', path: '/Users/me/new' } }) },
    });
    render(<Probe />);
    await waitFor(() => expect(session(captured).selected).toBe(PROJECT));
    await act(async () => {
      await expect(session(captured).addProject('/Users/me/new')).rejects.toMatchObject({
        message: 'missing', status: 400, body: { path: '/Users/me/new' },
      });
    });
  });
});

describe('useChatSession — history and events', () => {
  beforeEach(() => { window.localStorage.clear(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('restores the transcript for the selected project', async () => {
    const { captured, Probe } = harness({
      history: {
        projectPath: PROJECT, sessionId: 's1', running: true, pendingPermissions: [],
        messages: [{ id: 1, role: 'user', ts: 10, blocks: [{ type: 'text', text: 'hello' }] }],
      },
    });
    render(<Probe />);
    await waitFor(() => expect(session(captured).chat.items).toHaveLength(1));
    expect(session(captured).chat.sessionId).toBe('s1');
  });

  it('reports a failed history load instead of presenting an empty transcript as the truth', async () => {
    const { captured, Probe } = harness();
    render(<Probe />);
    await waitFor(() => expect(session(captured).selected).toBe(PROJECT));
    vi.stubGlobal('fetch', vi.fn(async (path) => (path === '/api/projects'
      ? { ok: true, status: 200, json: async () => ({ projects }) }
      : { ok: false, status: 500, json: async () => ({}) })));
    await act(async () => { session(captured).select(OTHER); });
    await waitFor(() => expect(session(captured).historyError).toBe('request_failed_500'));
  });

  it('drops a chat event belonging to another project', async () => {
    const { captured, Probe } = harness();
    render(<Probe />);
    await waitFor(() => expect(session(captured).selected).toBe(PROJECT));
    await act(async () => {
      session(captured).handleEvent('chat.message', { projectPath: OTHER, messageId: 'm1', blocks: [{ type: 'text', text: 'not mine' }] });
    });
    expect(session(captured).chat.items).toEqual([]);
  });

  it('replays an event that beat the history request instead of losing it', async () => {
    const { captured, Probe, releaseHistory } = harness({ deferHistory: true });
    render(<Probe />);
    await waitFor(() => expect(session(captured).selected).toBe(PROJECT));

    await act(async () => {
      session(captured).handleEvent('chat.message', {
        projectPath: PROJECT, messageId: 'm1', blocks: [{ type: 'text', text: 'arrived first' }],
      });
    });
    // Buffered, not applied: applying it now means the restored transcript overwrites it a moment later.
    expect(session(captured).chat.items).toEqual([]);

    await act(async () => { releaseHistory(); });
    await waitFor(() => expect(session(captured).chat.items).toHaveLength(1));
    expect(session(captured).chat.items[0].blocks[0].text).toBe('arrived first');
  });

  it('keeps a prompt for another project, because a blocked tool call is blocked either way', async () => {
    const { captured, Probe } = harness();
    render(<Probe />);
    await waitFor(() => expect(session(captured).selected).toBe(PROJECT));
    await act(async () => {
      session(captured).handleEvent('permission.request', { id: 'p1', projectPath: OTHER, toolName: 'Write', input: {}, ts: 1 });
    });
    expect(session(captured).permissions).toHaveLength(1);

    await act(async () => {
      session(captured).handleEvent('permission.resolved', { id: 'p1', projectPath: OTHER, decision: 'timeout' });
    });
    expect(session(captured).permissions).toEqual([]);
  });

  it('re-queues a prompt the reloading tab missed', async () => {
    const { captured, Probe } = harness({
      history: {
        projectPath: PROJECT, sessionId: 's1', running: true, messages: [],
        pendingPermissions: [{ id: 'p9', projectPath: PROJECT, toolName: 'Bash', toolUseId: 'toolu_1', ts: 5 }],
      },
    });
    render(<Probe />);
    await waitFor(() => expect(session(captured).permissions).toHaveLength(1));
    expect(session(captured).permissions[0].restored).toBe(true);
  });
});

describe('useChatSession — sending', () => {
  beforeEach(() => { window.localStorage.clear(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('shows the user their own message, which the daemon never broadcasts back', async () => {
    const { captured, fetchMock, Probe } = harness();
    render(<Probe />);
    await waitFor(() => expect(session(captured).selected).toBe(PROJECT));
    await act(async () => { await session(captured).send('run the tests'); });

    expect(session(captured).chat.items[0]).toMatchObject({ role: 'user' });
    expect(fetchMock).toHaveBeenCalledWith('/api/chat', expect.objectContaining({ method: 'POST' }));
    const body = JSON.parse(fetchMock.mock.calls.find(([p]) => p === '/api/chat')[1].body);
    expect(body).toEqual({ projectPath: PROJECT, text: 'run the tests' });
  });

  it('reports a refused send in the transcript rather than throwing at the composer', async () => {
    const { captured, Probe } = harness({
      posts: { '/api/chat': async () => ({ ok: false, status: 400, payload: { error: 'empty_message' } }) },
    });
    render(<Probe />);
    await waitFor(() => expect(session(captured).selected).toBe(PROJECT));
    await act(async () => { await session(captured).send('   ') });

    const error = session(captured).chat.items.find((i) => i.kind === 'error');
    expect(error.message).toMatch(/could not be sent/);
    expect(error.detail).toBe('empty_message');
    expect(error.fatal).toBe(false);              // the composer must stay usable
  });

  it('reports a failed interrupt without pretending the turn stopped', async () => {
    const { captured, Probe } = harness({
      posts: { '/api/chat/interrupt': async () => ({ ok: false, status: 400, payload: { error: 'bad_project' } }) },
    });
    render(<Probe />);
    await waitFor(() => expect(session(captured).selected).toBe(PROJECT));
    await act(async () => { await session(captured).interrupt(); });
    expect(session(captured).chat.items.at(-1).message).toMatch(/could not be interrupted/);
  });

  it('clears the transcript on reset even when the stream is down', async () => {
    const { captured, Probe } = harness({
      history: {
        projectPath: PROJECT, sessionId: 's1', running: true, pendingPermissions: [],
        messages: [{ id: 1, role: 'user', ts: 10, blocks: [{ type: 'text', text: 'hello' }] }],
      },
    });
    render(<Probe />);
    await waitFor(() => expect(session(captured).chat.items).toHaveLength(1));
    await act(async () => { await session(captured).reset(); });
    expect(session(captured).chat.items).toEqual([]);
    expect(session(captured).chat.status).toBe('reset');
    expect(session(captured).chat.sessionId).toBeNull();
  });

  it('is busy while a turn is running and free again when it ends', async () => {
    const { captured, Probe } = harness();
    render(<Probe />);
    await waitFor(() => expect(session(captured).selected).toBe(PROJECT));
    await act(async () => { session(captured).handleEvent('chat.status', { projectPath: PROJECT, state: 'busy' }); });
    expect(session(captured).busy).toBe(true);
    await act(async () => { session(captured).handleEvent('chat.status', { projectPath: PROJECT, state: 'idle' }); });
    expect(session(captured).busy).toBe(false);
  });
});

describe('useChatSession — deciding a prompt', () => {
  beforeEach(() => { window.localStorage.clear(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  const queue = async (captured) => {
    await act(async () => {
      session(captured).handleEvent('permission.request', {
        id: 'p1', projectPath: PROJECT, toolName: 'Write', input: { file_path: '/tmp/x' }, ts: 1, expiresAt: 300_001,
      });
    });
  };

  it('sends the decision and drops the prompt', async () => {
    const { captured, fetchMock, Probe } = harness({
      posts: { '/api/permissions/:id': async () => ({ ok: true, status: 200, payload: { ok: true, decision: 'allow' } }) },
    });
    render(<Probe />);
    await waitFor(() => expect(session(captured).selected).toBe(PROJECT));
    await queue(captured);
    await act(async () => { await session(captured).decide('p1', 'allow'); });

    expect(fetchMock).toHaveBeenCalledWith('/api/permissions/p1', expect.objectContaining({ method: 'POST' }));
    expect(session(captured).permissions).toEqual([]);
  });

  it('drops a prompt the daemon has already settled, and says the tool did not run', async () => {
    const { captured, Probe } = harness({
      posts: { '/api/permissions/:id': async () => ({ ok: false, status: 404, payload: { error: 'unknown_request' } }) },
    });
    render(<Probe />);
    await waitFor(() => expect(session(captured).selected).toBe(PROJECT));
    await queue(captured);
    await act(async () => { await session(captured).decide('p1', 'allow'); });

    expect(session(captured).permissions).toEqual([]);
    expect(session(captured).permissionNotice).toMatch(/timed out, or the session was interrupted/);
  });

  it('keeps the prompt queued when the decision could not be delivered', async () => {
    const { captured, Probe } = harness({
      posts: { '/api/permissions/:id': async () => ({ ok: false, status: 500, payload: { error: 'boom' } }) },
    });
    render(<Probe />);
    await waitFor(() => expect(session(captured).selected).toBe(PROJECT));
    await queue(captured);
    await act(async () => {
      await expect(session(captured).decide('p1', 'allow')).rejects.toThrow('boom');
    });
    expect(session(captured).permissions).toHaveLength(1);
  });

  it('dismisses the settled-prompt notice', async () => {
    const { captured, Probe } = harness({
      posts: { '/api/permissions/:id': async () => ({ ok: false, status: 404, payload: { error: 'unknown_request' } }) },
    });
    render(<Probe />);
    await waitFor(() => expect(session(captured).selected).toBe(PROJECT));
    await queue(captured);
    await act(async () => { await session(captured).decide('p1', 'deny'); });
    await act(async () => { session(captured).dismissPermissionNotice(); });
    expect(session(captured).permissionNotice).toBeNull();
  });
});
