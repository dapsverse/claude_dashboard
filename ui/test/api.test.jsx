import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchJson, connectStream } from '../src/api.js';

describe('fetchJson', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves with the parsed JSON body on success', async () => {
    fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ active: [], recent: [] }) });
    const body = await fetchJson('/api/runs');
    expect(body).toEqual({ active: [], recent: [] });
    expect(fetch).toHaveBeenCalledWith('/api/runs', { headers: { accept: 'application/json' } });
  });

  it('throws "unauthorized" on a 401 so the caller can prompt for the token URL', async () => {
    fetch.mockResolvedValue({ ok: false, status: 401 });
    await expect(fetchJson('/api/runs')).rejects.toThrow('unauthorized');
  });

  it('throws a labeled error for any other failed status', async () => {
    fetch.mockResolvedValue({ ok: false, status: 500 });
    await expect(fetchJson('/api/runs')).rejects.toThrow('request_failed_500');
  });
});

class FakeEventSource {
  constructor(url) {
    this.url = url;
    this.listeners = {};
    this.closed = false;
    FakeEventSource.instances.push(this);
  }
  addEventListener(name, handler) {
    (this.listeners[name] ??= []).push(handler);
  }
  emit(name, data) {
    for (const handler of this.listeners[name] ?? []) {
      handler({ data: JSON.stringify(data) });
    }
  }
  close() {
    this.closed = true;
  }
}
FakeEventSource.instances = [];

describe('connectStream', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens an EventSource against /api/stream, authenticated by cookie', () => {
    connectStream({ onEvent: () => {} });
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0].url).toBe('/api/stream');
  });

  it('dispatches every named daemon event to onEvent with its parsed payload', () => {
    const onEvent = vi.fn();
    connectStream({ onEvent });
    const source = FakeEventSource.instances[0];
    const run = { id: 's1:t1', status: 'running' };
    source.emit('run.open', run);
    source.emit('run.close', run);
    source.emit('run.enrich', run);
    source.emit('session.end', { sessionId: 's1' });
    source.emit('catalog.changed', {});

    expect(onEvent).toHaveBeenCalledWith('run.open', run);
    expect(onEvent).toHaveBeenCalledWith('run.close', run);
    expect(onEvent).toHaveBeenCalledWith('run.enrich', run);
    expect(onEvent).toHaveBeenCalledWith('session.end', { sessionId: 's1' });
    expect(onEvent).toHaveBeenCalledWith('catalog.changed', {});
  });

  it('reports a disconnect through onError without throwing', () => {
    const onError = vi.fn();
    connectStream({ onEvent: () => {}, onError });
    const source = FakeEventSource.instances[0];
    source.onerror();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('returns a cleanup function that closes the underlying EventSource', () => {
    const cleanup = connectStream({ onEvent: () => {} });
    const source = FakeEventSource.instances[0];
    expect(source.closed).toBe(false);
    cleanup();
    expect(source.closed).toBe(true);
  });
});
