import { describe, it, expect } from 'vitest';
import { officeCalls } from '../src/components/officeCalls.js';
import { latestMessageAt, latestAssistantMessageAt, initialChatState, appendUserMessage, applyChatEvent, fromHistory } from '../src/components/chatState.js';
import { applyCalls, startBossCall, createWorld, syncActors, tick, DESK_SEATS, CALL_MS } from '../src/components/officeWorld.js';

const rng = () => 0.5;
const runs = [
  { id: 's:a', agentId: 'agent-a', status: 'running' },
  { id: 's:b', agentId: 'agent-b', status: 'running' },
];
const actor = (world, id = 's:a') => world.actors.find((a) => a.id === id);
const boss = (world) => world.actors.find((a) => a.role === 'orchestrator');
const calls = (world, ids = [], bossCalling = false, instant = false) => applyCalls(world, {
  callingIds: new Set(ids), bossCalling, rng, instant,
});

describe('officeCalls', () => {
  it('matches agentId rather than the tool or permission id, and deduplicates requests', () => {
    expect(officeCalls([
      { id: 'p1', agentId: 'agent-b', kind: 'question' },
      { id: 'p2', agentId: 'agent-b', kind: 'tool' },
    ], runs)).toEqual({ callingRunIds: new Set(['s:b']), bossCalling: true });
  });

  it.each([null, undefined, 'orchestrator', 'missing'])('holds the boss for an open modal with unmatched agent %s', (agentId) => {
    expect(officeCalls([{ agentId }], runs)).toEqual({ callingRunIds: new Set(), bossCalling: true });
  });

  it('does not match null ids, completed runs, or a different project', () => {
    for (const run of [
      { id: 'a', agentId: null, status: 'running' },
      { ...runs[0], status: 'done' },
      { ...runs[0], projectPath: '/other' },
    ]) {
      expect(officeCalls([{ agentId: run.agentId, projectPath: '/here' }], [run]).bossCalling).toBe(true);
    }
  });

  it('supports simultaneous worker and boss calls, then clears with the queue', () => {
    expect(officeCalls([{ agentId: 'agent-a' }, { agentId: null }], runs))
      .toEqual({ callingRunIds: new Set(['s:a']), bossCalling: true });
    expect(officeCalls([], runs)).toEqual({ callingRunIds: new Set(), bossCalling: false });
  });
});

describe('latestMessageAt', () => {
  it('returns null without a finite user or assistant message timestamp', () => {
    expect(latestMessageAt(initialChatState)).toBeNull();
    expect(latestMessageAt({ items: [
      { kind: 'message', role: 'user', ts: null },
      { kind: 'message', role: 'assistant', ts: Infinity },
      { kind: 'message', role: 'user', ts: NaN },
      { kind: 'message', role: 'assistant' },
      { kind: 'message', role: 'system', ts: 7000 },
      { kind: 'warning', role: 'assistant', ts: 8000 },
    ] })).toBeNull();
  });

  it('advances on a local user send and then an assistant receive, ignoring deltas and older events', () => {
    let chat = fromHistory({ messages: [{ role: 'assistant', ts: 1000, blocks: [{ type: 'text', text: 'old' }] }] });
    chat = appendUserMessage(chat, 'hello', 2000);
    expect(latestMessageAt(chat)).toBe(2000);
    expect(latestAssistantMessageAt(chat)).toBe(1000);
    chat = applyChatEvent(chat, 'chat.delta', { messageId: 'a', ts: 2500, text: 'reply' });
    expect(latestMessageAt(chat)).toBe(2000);
    chat = applyChatEvent(chat, 'chat.message', { messageId: 'a', role: 'assistant', ts: 3000, blocks: [] });
    expect(latestMessageAt(chat)).toBe(3000);
    chat = appendUserMessage(chat, 'late echo', 1500);
    expect(latestMessageAt(chat)).toBe(3000);
  });
});

describe('latestAssistantMessageAt', () => {
  it('returns null without an assistant timestamp', () => {
    expect(latestAssistantMessageAt(initialChatState)).toBeNull();
    expect(latestAssistantMessageAt({ items: [{ kind: 'message', role: 'assistant', ts: null }] })).toBeNull();
  });

  it('finds the newest finite assistant timestamp even when events arrive out of order', () => {
    expect(latestAssistantMessageAt({ items: [
      { kind: 'message', role: 'assistant', ts: 2000 },
      { kind: 'message', role: 'user', ts: 5000 },
      { kind: 'warning', role: 'assistant', ts: 6000 },
      { kind: 'message', role: 'assistant', ts: Infinity },
      { kind: 'message', role: 'assistant', ts: 1000 },
    ] })).toBe(2000);
  });

  it('uses final messages and history, while deltas and unrelated events do not change it', () => {
    let state = fromHistory({ messages: [{ role: 'assistant', ts: 1000, blocks: [{ type: 'text', text: 'old' }] }] });
    expect(latestAssistantMessageAt(state)).toBe(1000);
    state = applyChatEvent(state, 'chat.delta', { messageId: 'm', ts: 2000, text: 'new' });
    expect(latestAssistantMessageAt(state)).toBe(1000);
    state = applyChatEvent(state, 'chat.message', { messageId: 'm', ts: 3000, role: 'assistant', blocks: [] });
    expect(latestAssistantMessageAt(state)).toBe(3000);
  });
});

describe('office call simulation', () => {
  it('stops the matching walking actor in place without mutating the original world', () => {
    const world = syncActors(createWorld(), runs, { rng });
    const snapshot = structuredClone(world);
    const next = calls(world, ['s:b']);
    expect(actor(next, 's:b')).toMatchObject({ state: 'oncall', callHeld: true, path: [], x: actor(world, 's:b').x, y: actor(world, 's:b').y });
    expect(actor(next)).toEqual(actor(world));
    expect(world).toEqual(snapshot);
  });

  it('holds calls across ticks and repeated reconciliation until the flag clears', () => {
    let world = calls(syncActors(createWorld(), runs, { rng }), ['s:a']);
    const { x, y } = actor(world);
    world = calls(tick(world, 60000, rng), ['s:a']);
    expect(actor(world)).toMatchObject({ state: 'oncall', callHeld: true, x, y, path: [] });
    world = calls(world);
    expect(actor(world)).toMatchObject({ state: 'walking', next: 'working', callHeld: false });
    world = tick(world, 20000, rng);
    expect(actor(world)).toMatchObject({ state: 'working', x: DESK_SEATS[0][0], y: DESK_SEATS[0][1] });
  });

  it('releases a seated worker at its desk under reduced motion', () => {
    const world = calls(syncActors(createWorld(), runs, { rng, instant: true }), ['s:a']);
    expect(actor(calls(world, [], false, true))).toMatchObject({ state: 'working', path: [] });
  });

  it('ends the short boss call after 2500ms and allows a newer message to renew it', () => {
    let world = startBossCall(tick(createWorld(), 1600, rng));
    const { x, y } = boss(world);
    world = tick(world, CALL_MS - 100, rng);
    expect(boss(world)).toMatchObject({ state: 'oncall', x, y, path: [] });
    world = startBossCall(world);
    world = tick(world, CALL_MS - 100, rng);
    expect(boss(world).state).toBe('oncall');
    expect(boss(tick(world, 100, rng))).toMatchObject({ state: 'idle', bubble: null });
  });

  it('holds a boss decision past a message timeout, and releases when answered', () => {
    const world = tick(startBossCall(calls(createWorld(), [], true)), CALL_MS, rng);
    expect(boss(world)).toMatchObject({ state: 'oncall', callHeld: true });
    expect(boss(calls(world)).state).toBe('idle');
  });

  it('preserves the remaining message call if the decision is answered first', () => {
    let world = calls(startBossCall(createWorld()), [], true);
    world = calls(tick(world, 1000, rng));
    expect(boss(world)).toMatchObject({ state: 'oncall', callHeld: false, timer: 1500 });
    expect(boss(tick(world, 1500, rng)).state).toBe('idle');
  });

  it('does not hold the boss for overflow requests or stop departing actors', () => {
    let world = syncActors(createWorld(), runs, { rng });
    world = syncActors(world, [], { rng });
    world = calls(world, ['s:a', 'overflow']);
    expect(actor(world).state).toBe('leaving');
    expect(boss(world)).toMatchObject({ state: 'idle', bubble: null });
  });

  it('releases a stale permission when its modal leaves the queue despite a leftover worker call id', () => {
    const request = { id: 'stale', agentId: 'missing', kind: 'tool' };
    const open = officeCalls([request], runs);
    let world = calls(createWorld(), ['overflow'], open.bossCalling);
    world = calls(tick(world, 60000, rng), ['overflow'], open.bossCalling);
    expect(boss(world)).toMatchObject({ state: 'oncall', callHeld: true });
    const closed = officeCalls([], runs);
    expect(closed.bossCalling).toBe(false);
    world = calls(world, ['overflow'], closed.bossCalling);
    expect(boss(world)).toMatchObject({ state: 'idle', callHeld: false, bubble: null });
    world = calls(tick(world, 60000, rng), ['overflow'], closed.bossCalling);
    expect(boss(world).state).not.toBe('oncall');
  });
});
