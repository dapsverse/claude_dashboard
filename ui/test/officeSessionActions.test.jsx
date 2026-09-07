import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { useChatSession } from '../src/useChatSession.js';
import { App } from '../src/App.jsx';
import { ACK_BUBBLES } from '../src/components/officeWorld.js';

const projectPath = '/project';
const run = { id: 's:a', agentType: 'programmer', status: 'running', description: 'Repair login', projectPath, startedAt: 1000 };
const response = (payload, status = 200) => ({ ok: status < 400, status, json: async () => payload });

function mockFetch({ status = 200, deferredDecision } = {}) {
  const fetchMock = vi.fn(async (path, options) => {
    if (path === '/api/projects') return response({ projects: [{ path: projectPath, name: 'project' }] });
    if (path.startsWith('/api/chat/history')) return response({ messages: [], pendingPermissions: [] });
    if (path === '/api/runs') return response({ active: [run], recent: [] });
    if (path === '/api/catalog') return response({ agents: [], skills: [] });
    if (path.startsWith('/api/permissions/')) return deferredDecision ? deferredDecision : response({ ok: status === 200, error: 'failed' }, status);
    if (path === '/api/chat' && options?.method === 'POST') return response({ ok: status === 200, error: 'failed' }, status);
    return response({ ok: true, hooksInstalled: true });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('decisionAt from accepted user decisions', () => {
  it('waits for success and advances for two answers received within the same millisecond', async () => {
    let resolve;
    const deferredDecision = new Promise((done) => { resolve = done; });
    mockFetch({ deferredDecision });
    vi.spyOn(Date, 'now').mockReturnValue(135000);
    const { result } = renderHook(useChatSession);
    await waitFor(() => expect(result.current.selected).toBe(projectPath));
    act(() => result.current.handleEvent('permission.request', { id: 'p1', projectPath }));
    expect(result.current.decisionAt).toBeNull();
    let pending;
    act(() => { pending = result.current.decide('p1', 'allow'); });
    expect(result.current.decisionAt).toBeNull();
    await act(async () => { resolve(response({ ok: true })); await pending; });
    expect(result.current.decisionAt).toBe(135000);
    await act(async () => result.current.decide('p2', 'deny'));
    expect(result.current.decisionAt).toBe(135001);
  });

  it.each([404, 500])('does not acknowledge a failed decision (%s)', async (status) => {
    mockFetch({ status });
    const { result } = renderHook(useChatSession);
    await waitFor(() => expect(result.current.selected).toBe(projectPath));
    await act(async () => {
      if (status === 404) await result.current.decide('p1', 'allow');
      else await expect(result.current.decide('p1', 'allow')).rejects.toThrow('failed');
    });
    expect(result.current.decisionAt).toBeNull();
  });

  it('does not acknowledge automatic settlement and does not repeat an answer on its SSE echo', async () => {
    mockFetch();
    const { result } = renderHook(useChatSession);
    await waitFor(() => expect(result.current.selected).toBe(projectPath));
    act(() => result.current.handleEvent('permission.resolved', { id: 'expired', decision: 'timeout' }));
    expect(result.current.decisionAt).toBeNull();
    await act(async () => result.current.decide('p1', 'allow'));
    const accepted = result.current.decisionAt;
    act(() => result.current.handleEvent('permission.resolved', { id: 'p1', decision: 'allow' }));
    expect(result.current.decisionAt).toBe(accepted);
  });

  it.each([200, 500])('returns delivery status without throwing from send (%s)', async (status) => {
    mockFetch({ status });
    const { result } = renderHook(useChatSession);
    await waitFor(() => expect(result.current.selected).toBe(projectPath));
    await act(async () => expect(result.current.send('Take over')).resolves.toBe(status === 200));
    if (status === 500) expect(result.current.chat.items.at(-1).message).toContain('could not be sent');
  });
});

describe('App connects the rail to the chat session', () => {
  it('sends takeover via chat and acknowledges a successful permission answer', async () => {
    let stream;
    class FakeEventSource {
      constructor() { this.listeners = {}; stream = this; }
      addEventListener(name, callback) { this.listeners[name] = callback; }
      emit(name, data) { this.listeners[name]?.({ data: JSON.stringify(data) }); }
      close() {}
    }
    vi.stubGlobal('EventSource', FakeEventSource);
    const fetchMock = mockFetch();
    const { container } = render(<App />);
    await screen.findByText('programmer');
    await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => path.startsWith('/api/chat/history'))).toBe(true));
    const row = within(screen.getByRole('complementary', { name: 'Live agents' })).getByRole('listitem');
    fireEvent.click(within(row).getByRole('button', { expanded: false }));
    await act(async () => fireEvent.click(within(row).getByRole('button', { name: 'Take over' })));
    const [path, options] = fetchMock.mock.calls.find(([url, opts]) => url === '/api/chat' && opts?.method === 'POST');
    expect(path).toBe('/api/chat');
    expect(JSON.parse(options.body)).toMatchObject({ projectPath, text: expect.stringContaining('LEBIH SEMPIT') });
    expect(fetchMock.mock.calls.some(([url]) => url === '/api/chat/interrupt' || url === '/api/runs/dismiss')).toBe(false);
    act(() => stream.emit('permission.request', { id: 'p1', projectPath, toolName: 'Bash', input: { command: 'echo hello' } }));
    const boss = () => container.querySelector('.sprite[data-run-id="__orchestrator__"]');
    expect(boss().getAttribute('data-state')).toBe('oncall');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Allow once' })));
    expect(fetchMock).toHaveBeenCalledWith('/api/permissions/p1', expect.objectContaining({ method: 'POST' }));
    expect(boss().getAttribute('data-state')).toBe('ack');
    expect([...container.querySelectorAll('.office-bubble')].some((bubble) => ACK_BUBBLES.includes(bubble.textContent))).toBe(true);
  });
});
