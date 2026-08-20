import { describe, it, expect } from 'vitest';
import {
  applyChatEvent, appendUserMessage, fromHistory, initialChatState,
  isBusy, isDispatch, streamingBuffers, SURFACED_WARNINGS,
} from '../src/components/chatState.js';
import { addRequest, removeRequest, restoreRequests, APPROVAL_WINDOW_MS } from '../src/components/permissionQueue.js';
import { summarizeToolInput, formatToolInput, readStoredInput } from '../src/components/toolSummary.js';

const apply = (state, events) => events.reduce((s, [name, payload]) => applyChatEvent(s, name, payload), state);

const texts = (state) => state.items
  .filter((i) => i.kind === 'message')
  .map((i) => i.blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''));

describe('chat delta buffering', () => {
  it('accumulates deltas for a branch and drops the buffer when the message lands', () => {
    const streaming = apply(initialChatState, [
      ['chat.delta', { messageId: 'm1', parentToolUseId: null, text: 'par' }],
      ['chat.delta', { messageId: 'm1', parentToolUseId: null, text: 'tial' }],
    ]);
    expect(streamingBuffers(streaming)).toEqual([
      { branch: 'main', messageId: 'm1', text: 'partial', parentToolUseId: null },
    ]);

    const settled = applyChatEvent(streaming, 'chat.message', {
      messageId: 'm1', parentToolUseId: null, role: 'assistant', blocks: [{ type: 'text', text: 'partial answer' }],
    });
    expect(streamingBuffers(settled)).toEqual([]);
    expect(texts(settled)).toEqual(['partial answer']);
  });

  it('ignores a delta that arrives after its own message was finalised', () => {
    const after = apply(initialChatState, [
      ['chat.message', { messageId: 'm1', role: 'assistant', blocks: [{ type: 'text', text: 'done' }] }],
      ['chat.delta', { messageId: 'm1', text: 'ne' }],
    ]);
    expect(streamingBuffers(after)).toEqual([]);
    expect(texts(after)).toEqual(['done']);
  });

  it('keeps a subagent branch separate from the main one', () => {
    const state = apply(initialChatState, [
      ['chat.delta', { messageId: 'm1', parentToolUseId: null, text: 'main' }],
      ['chat.delta', { messageId: 'm2', parentToolUseId: 'toolu_1', text: 'nested' }],
    ]);
    expect(streamingBuffers(state).map((b) => b.branch).sort()).toEqual(['main', 'toolu_1']);

    const settled = applyChatEvent(state, 'chat.message', {
      messageId: 'm2', parentToolUseId: 'toolu_1', role: 'assistant', blocks: [{ type: 'text', text: 'nested' }],
    });
    expect(streamingBuffers(settled).map((b) => b.branch)).toEqual(['main']);
  });

  it('starts a fresh buffer when a new message id streams into the same branch', () => {
    const state = apply(initialChatState, [
      ['chat.delta', { messageId: 'm1', text: 'first' }],
      ['chat.delta', { messageId: 'm2', text: 'second' }],
    ]);
    expect(streamingBuffers(state)).toEqual([
      { branch: 'main', messageId: 'm2', text: 'second', parentToolUseId: null },
    ]);
  });

  it('treats an empty delta as nothing at all', () => {
    expect(applyChatEvent(initialChatState, 'chat.delta', { messageId: 'm1', text: '' }))
      .toBe(initialChatState);
  });
});

describe('chat messages', () => {
  it('replaces a redelivered message rather than printing it twice', () => {
    const once = applyChatEvent(initialChatState, 'chat.message', {
      messageId: 'm1', role: 'assistant', blocks: [{ type: 'text', text: 'hello' }],
    });
    const twice = applyChatEvent(once, 'chat.message', {
      messageId: 'm1', role: 'assistant', blocks: [{ type: 'text', text: 'hello' }],
    });
    expect(twice.items).toHaveLength(1);
  });

  it('keeps a subagent message with the same id as a distinct item', () => {
    const state = apply(initialChatState, [
      ['chat.message', { messageId: 'm1', parentToolUseId: null, blocks: [{ type: 'text', text: 'a' }] }],
      ['chat.message', { messageId: 'm1', parentToolUseId: 'toolu_1', blocks: [{ type: 'text', text: 'b' }] }],
    ]);
    expect(state.items).toHaveLength(2);
  });

  it('echoes the user message locally, since the daemon never broadcasts it back', () => {
    const state = appendUserMessage(initialChatState, 'run the tests', 1000);
    expect(state.items[0]).toMatchObject({ kind: 'message', role: 'user', ts: 1000 });
    expect(state.items[0].blocks).toEqual([{ type: 'text', text: 'run the tests' }]);
  });

  it('gives every item a unique key', () => {
    const state = apply(appendUserMessage(initialChatState, 'a', 1), [
      ['chat.message', { messageId: 'm1', blocks: [{ type: 'text', text: 'b' }] }],
      ['chat.message', { messageId: 'm2', blocks: [{ type: 'text', text: 'c' }] }],
    ]);
    expect(new Set(state.items.map((i) => i.key)).size).toBe(3);
  });
});

describe('chat.tool_use', () => {
  it('records the dispatch flag without appending a second copy of the block', () => {
    const state = apply(initialChatState, [
      ['chat.message', { messageId: 'm1', blocks: [{ type: 'tool_use', id: 'toolu_1', name: 'Agent', input: {} }] }],
      ['chat.tool_use', { messageId: 'm1', toolUseId: 'toolu_1', name: 'Agent', input: {}, agentDispatch: true }],
    ]);
    expect(state.items).toHaveLength(1);
    expect(state.dispatches.toolu_1).toEqual({ name: 'Agent', input: {}, agentDispatch: true });
  });

  it('lets the live flag beat the name, in both directions', () => {
    const notADispatch = applyChatEvent(initialChatState, 'chat.tool_use', {
      toolUseId: 'toolu_1', name: 'Agent', input: {}, agentDispatch: false,
    });
    expect(isDispatch(notADispatch, { id: 'toolu_1', name: 'Agent' })).toBe(false);

    const renamed = applyChatEvent(initialChatState, 'chat.tool_use', {
      toolUseId: 'toolu_2', name: 'Dispatch', input: {}, agentDispatch: true,
    });
    expect(isDispatch(renamed, { id: 'toolu_2', name: 'Dispatch' })).toBe(true);
  });

  it('falls back to the tool name for a block with no live event, such as restored history', () => {
    expect(isDispatch(initialChatState, { id: 'toolu_9', name: 'Task' })).toBe(true);
    expect(isDispatch(initialChatState, { id: 'toolu_9', name: 'Bash' })).toBe(false);
  });

  it('ignores an event with no tool use id', () => {
    expect(applyChatEvent(initialChatState, 'chat.tool_use', { name: 'Bash' })).toBe(initialChatState);
  });
});

describe('chat.result', () => {
  it('keeps the latest cumulative figures rather than summing them', () => {
    const state = apply(initialChatState, [
      ['chat.result', { totalCostUsd: 0.2, numTurns: 1, usage: { output_tokens: 10 } }],
      ['chat.result', { totalCostUsd: 0.34, numTurns: 2, usage: { output_tokens: 20 } }],
    ]);
    expect(state.result.totalCostUsd).toBe(0.34);
    expect(state.result.numTurns).toBe(2);
  });

  it('does not print an error whose text the last answer already carried', () => {
    const state = apply(initialChatState, [
      ['chat.message', { messageId: 'm1', blocks: [{ type: 'text', text: "You've hit your session limit" }] }],
      ['chat.result', { isError: true, subtype: 'error_during_execution', text: "You've hit your session limit" }],
    ]);
    expect(state.items).toHaveLength(1);
    expect(state.result.isError).toBe(true);
  });

  it('still prints an error whose text is new', () => {
    const state = apply(initialChatState, [
      ['chat.message', { messageId: 'm1', blocks: [{ type: 'text', text: 'working on it' }] }],
      ['chat.result', { isError: true, text: 'the CLI exited' }],
    ]);
    expect(state.items.filter((i) => i.kind === 'error')).toHaveLength(1);
  });

  it('names the subtype when an error result carries no text', () => {
    const state = applyChatEvent(initialChatState, 'chat.result', { isError: true, subtype: 'error_max_turns', text: null });
    expect(state.items[0].message).toContain('error_max_turns');
  });

  it('appends nothing for a successful result', () => {
    const state = applyChatEvent(initialChatState, 'chat.result', { isError: false, text: 'all good' });
    expect(state.items).toEqual([]);
  });
});

describe('chat.error', () => {
  it('a fatal error ends the session and clears the streams', () => {
    const state = apply(initialChatState, [
      ['chat.delta', { messageId: 'm1', text: 'half' }],
      ['chat.error', { message: 'The conversation could not be resumed.', detail: 'Error: ...', fatal: true }],
    ]);
    expect(state.status).toBe('error');
    expect(streamingBuffers(state)).toEqual([]);
    expect(state.items[0]).toMatchObject({ kind: 'error', fatal: true, detail: 'Error: ...' });
    expect(isBusy(state)).toBe(false);            // the composer must come back — the next send restarts
  });

  it('a non-fatal error leaves the session alone', () => {
    const busy = applyChatEvent(initialChatState, 'chat.status', { state: 'busy' });
    const state = applyChatEvent(busy, 'chat.error', { message: 'one message failed', fatal: false });
    expect(state.status).toBe('busy');
    expect(state.items[0].fatal).toBe(false);
  });
});

describe('chat.status', () => {
  it('ready fills in the session facts', () => {
    const state = applyChatEvent(initialChatState, 'chat.status', {
      state: 'ready', sessionId: 's1', model: 'claude-opus-5[1m]',
      tools: ['Bash'], agents: ['reviewer'], permissionMode: 'default',
    });
    expect(state).toMatchObject({
      status: 'ready', sessionId: 's1', model: 'claude-opus-5[1m]', permissionMode: 'default',
    });
    expect(state.tools).toEqual(['Bash']);
    expect(state.agents).toEqual(['reviewer']);
  });

  it('a ready arriving after busy does not re-enable the composer mid-turn', () => {
    const state = apply(initialChatState, [
      ['chat.status', { state: 'busy', sessionId: 's1' }],
      ['chat.status', { state: 'ready', sessionId: 's1', model: 'm' }],
    ]);
    expect(state.status).toBe('busy');
    expect(state.model).toBe('m');
    expect(isBusy(state)).toBe(true);
  });

  it('starting and busy are the only busy states', () => {
    for (const s of ['starting', 'busy']) {
      expect(isBusy(applyChatEvent(initialChatState, 'chat.status', { state: s }))).toBe(true);
    }
    for (const s of ['ready', 'idle', 'interrupted', 'closed', 'reset']) {
      expect(isBusy(applyChatEvent(initialChatState, 'chat.status', { state: s }))).toBe(false);
    }
  });

  it('idle clears the activity line and any half-streamed buffer', () => {
    const state = apply(initialChatState, [
      ['chat.status', { state: 'activity', kind: 'tool_progress', data: { toolName: 'Bash' } }],
      ['chat.delta', { messageId: 'm1', text: 'half' }],
      ['chat.status', { state: 'idle', sessionId: 's1' }],
    ]);
    expect(state.activity).toBeNull();
    expect(streamingBuffers(state)).toEqual([]);
  });

  it('reset discards the transcript with the resume id', () => {
    const state = apply(appendUserMessage(initialChatState, 'hi', 1), [
      ['chat.status', { state: 'ready', sessionId: 's1', model: 'm' }],
      ['chat.status', { state: 'reset', sessionId: null }],
    ]);
    expect(state).toEqual({ ...initialChatState, status: 'reset' });
  });

  it('surfaces a warning the user can act on and swallows unknown ones', () => {
    const surfaced = applyChatEvent(initialChatState, 'chat.status', {
      state: 'warning', kind: 'permission_denied', data: { toolName: 'Write' },
    });
    expect(surfaced.items[0]).toMatchObject({ kind: 'warning', warningKind: 'permission_denied' });
    expect(SURFACED_WARNINGS.has('permission_denied')).toBe(true);

    const ignored = applyChatEvent(initialChatState, 'chat.status', { state: 'warning', kind: 'something_new' });
    expect(ignored.items).toEqual([]);
  });

  it('records activity without adding it to the transcript', () => {
    const state = applyChatEvent(initialChatState, 'chat.status', {
      state: 'activity', kind: 'task_started', data: { subagentType: 'reviewer' }, ts: 5,
    });
    expect(state.items).toEqual([]);
    expect(state.activity).toEqual({ kind: 'task_started', data: { subagentType: 'reviewer' }, ts: 5 });
  });

  it('ignores a state it has never heard of', () => {
    expect(applyChatEvent(initialChatState, 'chat.status', { state: 'teleporting' })).toBe(initialChatState);
  });
});

describe('fromHistory', () => {
  const history = {
    projectPath: '/p', sessionId: 's1', running: true, pendingPermissions: [],
    messages: [
      { id: 1, role: 'user', ts: 10, blocks: [{ type: 'text', text: 'write a file' }] },
      { id: 2, role: 'assistant', ts: 11, blocks: [{ type: 'tool_use', id: 'toolu_1', name: 'Write', inputPreview: '{"file_path":"/tmp/x"}' }] },
      { id: 3, role: 'assistant', ts: 12, blocks: [{ type: 'text', text: 'done' }] },
      { id: 4, role: 'system', ts: 13, blocks: [{ type: 'result', text: 'done', isError: false, durationMs: 900, totalCostUsd: 0.34 }] },
    ],
  };

  it('renders stored messages and seeds the footer from the last result', () => {
    const state = fromHistory(history);
    expect(state.items).toHaveLength(3);
    expect(state.result).toMatchObject({ totalCostUsd: 0.34, durationMs: 900, isError: false });
    expect(state.sessionId).toBe('s1');
    expect(state.status).toBe('ready');           // `running` means a live session, not a live turn
  });

  it('never repeats a successful result as its own item', () => {
    expect(fromHistory(history).items.filter((i) => i.kind === 'error')).toHaveLength(0);
    expect(texts(fromHistory(history))).toEqual(['write a file', '', 'done']);
  });

  it('does not print an error result whose text the last stored answer already carried', () => {
    const limited = fromHistory({
      running: true,
      messages: [
        { role: 'assistant', ts: 1, blocks: [{ type: 'text', text: "You've hit your session limit" }] },
        { role: 'system', ts: 2, blocks: [{ type: 'result', text: "You've hit your session limit", isError: true }] },
      ],
    });
    expect(limited.items).toHaveLength(1);
    expect(limited.result.isError).toBe(true);
  });

  it('prints an error result the transcript does not already say', () => {
    const state = fromHistory({
      running: false,
      messages: [
        { role: 'assistant', ts: 1, blocks: [{ type: 'text', text: 'working' }] },
        { role: 'system', ts: 2, blocks: [{ type: 'result', text: 'the CLI exited', isError: true }] },
      ],
    });
    expect(state.items.filter((i) => i.kind === 'error')).toHaveLength(1);
    expect(state.status).toBe('unknown');
  });

  it('drops a block type the transcript cannot render, and the message if that leaves it empty', () => {
    const state = fromHistory({
      messages: [{ role: 'assistant', ts: 1, blocks: [{ type: 'other', kind: 'image', preview: '…' }] }],
    });
    expect(state.items).toEqual([]);
  });

  it('survives a malformed payload', () => {
    expect(fromHistory(undefined).items).toEqual([]);
    expect(fromHistory({ messages: 'nope' }).items).toEqual([]);
    expect(fromHistory({ messages: [{ role: 'assistant', blocks: null }] }).items).toEqual([]);
  });
});

describe('permission queue', () => {
  const request = (over = {}) => ({
    id: 'p1', projectPath: '/p', toolName: 'Write', input: { file_path: '/tmp/x' },
    toolUseId: 'toolu_1', ts: 1000, expiresAt: 301000, ...over,
  });

  it('queues requests in arrival order and never loses the second one', () => {
    const queue = addRequest(addRequest([], request()), request({ id: 'p2' }));
    expect(queue.map((r) => r.id)).toEqual(['p1', 'p2']);
  });

  it('ignores a payload with no id', () => {
    expect(addRequest([], { toolName: 'Write' })).toEqual([]);
  });

  it('derives a deadline for a restored descriptor that has none', () => {
    const [restored] = restoreRequests([], [{ id: 'p1', toolName: 'Write', ts: 1000 }]);
    expect(restored.expiresAt).toBe(1000 + APPROVAL_WINDOW_MS);
    expect(restored.restored).toBe(true);
    expect(restored.input).toBeNull();
  });

  it('upgrades a restored descriptor in place when the live event arrives', () => {
    const queue = restoreRequests([], [{ id: 'p1', toolName: 'Write', ts: 1000 }]);
    const upgraded = addRequest(addRequest(queue, request({ id: 'p0' })), request());
    expect(upgraded.map((r) => r.id)).toEqual(['p1', 'p0']);   // position kept
    expect(upgraded[0].restored).toBe(false);
    expect(upgraded[0].input).toEqual({ file_path: '/tmp/x' });
  });

  it('removes a prompt by id and leaves the queue alone when it is not there', () => {
    const queue = addRequest([], request());
    expect(removeRequest(queue, 'p1')).toEqual([]);
    expect(removeRequest(queue, 'nope')).toBe(queue);
  });

  it('tolerates a missing descriptor list', () => {
    expect(restoreRequests([], undefined)).toEqual([]);
    expect(restoreRequests([], null)).toEqual([]);
  });
});

describe('tool input summaries', () => {
  it('names the field that says what the call does', () => {
    expect(summarizeToolInput('Bash', { command: 'npm test', description: 'run tests' })).toBe('npm test');
    expect(summarizeToolInput('Write', { file_path: '/tmp/x', content: 'secret' })).toBe('/tmp/x');
    expect(summarizeToolInput('Agent', { description: 'review', subagent_type: 'reviewer' })).toBe('review · reviewer');
  });

  it('guesses the subject of a tool it has never seen', () => {
    expect(summarizeToolInput('mcp__thing__do', { channel: 'general', count: 3 })).toBe('channel: general');
    expect(summarizeToolInput('mcp__thing__do', { count: 3 })).toBe('count');
  });

  it('collapses whitespace and clamps a long summary', () => {
    expect(summarizeToolInput('Bash', { command: 'echo  a\n  b' })).toBe('echo a b');
    expect(summarizeToolInput('Bash', { command: 'x'.repeat(400) })).toHaveLength(160);
  });

  it('handles the shapes that are not objects at all', () => {
    expect(summarizeToolInput('Bash', 'ls -la')).toBe('ls -la');
    expect(summarizeToolInput('Bash', null)).toBe('');
    expect(summarizeToolInput('TodoWrite', {})).toBe('');
  });

  it('pretty-prints the raw input, and never throws on a circular one', () => {
    expect(formatToolInput({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(formatToolInput(null)).toBe('');
    const circular = {}; circular.self = circular;
    expect(() => formatToolInput(circular)).not.toThrow();
  });
});

describe('readStoredInput', () => {
  it('parses the daemon\'s stored preview back into the input it renders', () => {
    expect(readStoredInput('{"file_path":"/tmp/x","content":"ok\\n"}')).toEqual({ file_path: '/tmp/x', content: 'ok\n' });
  });

  it('returns null for a preview the cap truncated mid-object', () => {
    expect(readStoredInput('{"prompt":"a very long prom')).toBeNull();
  });

  it('returns null for anything that is not a JSON object', () => {
    expect(readStoredInput('just a string')).toBeNull();
    expect(readStoredInput('"quoted"')).toBeNull();
    expect(readStoredInput('42')).toBeNull();
    expect(readStoredInput(undefined)).toBeNull();
  });
});

// The live rail's rows come from the hook path, which only ever learns that a run opened and later
// closed. What a subagent is doing *right now* only exists in the session's own progress events, so
// the reducer keeps them keyed by the dispatch's tool_use id — the second half of a run id.
describe('per-subagent activity', () => {
  const activity = (kind, data) => ({ state: 'activity', kind, data, ts: 10 });

  it('records what a dispatched subagent is doing, keyed by its tool_use id', () => {
    let state = applyChatEvent(initialChatState, 'chat.status', activity('task_started', {
      taskId: 'task_1', toolUseId: 'toolu_1', description: 'add auth', subagentType: 'programmer',
    }));
    expect(state.taskActivity.toolu_1.subagentType).toBe('programmer');
    expect(state.taskActivity.toolu_1.description).toBe('add auth');

    state = applyChatEvent(state, 'chat.status', activity('task_progress', {
      taskId: 'task_1', toolUseId: 'toolu_1', lastToolName: 'Grep',
    }));
    expect(state.taskActivity.toolu_1.lastToolName).toBe('Grep');
    // A later event that omits a field must not blank what an earlier one reported.
    expect(state.taskActivity.toolu_1.subagentType).toBe('programmer');
  });

  // A tool_progress carries the *inner* tool's toolUseId, which is not a run id. Only the taskId
  // identifies the row it belongs to.
  it('attributes a tool_progress through its taskId, not through its own tool_use id', () => {
    let state = applyChatEvent(initialChatState, 'chat.status', activity('task_started', {
      taskId: 'task_1', toolUseId: 'toolu_1', subagentType: 'qa',
    }));
    state = applyChatEvent(state, 'chat.status', activity('tool_progress', {
      taskId: 'task_1', toolUseId: 'toolu_inner', toolName: 'Bash', elapsedSeconds: 12,
    }));
    expect(state.taskActivity.toolu_1.lastToolName).toBe('Bash');
    expect(state.taskActivity.toolu_1.elapsedSeconds).toBe(12);
    expect(state.taskActivity.toolu_inner).toBeUndefined();
  });

  it('ignores main-thread progress, which belongs to no row', () => {
    const state = applyChatEvent(initialChatState, 'chat.status', activity('tool_progress', {
      toolUseId: 'toolu_main', toolName: 'Read', elapsedSeconds: 2,
    }));
    expect(state.taskActivity).toEqual({});
    // An identity return is what keeps the rail from re-rendering on every main-thread tick.
    expect(state.taskActivity).toBe(initialChatState.taskActivity);
  });

  it('keeps a finished turn from blanking a detail panel the user has open', () => {
    let state = applyChatEvent(initialChatState, 'chat.status', activity('task_progress', {
      taskId: 'task_1', toolUseId: 'toolu_1', lastToolName: 'Grep',
    }));
    state = applyChatEvent(state, 'chat.status', { state: 'idle' });
    expect(state.activity).toBeNull();
    expect(state.taskActivity.toolu_1.lastToolName).toBe('Grep');
  });

  it('is bounded, so a long session cannot grow it without limit', () => {
    let state = initialChatState;
    for (let i = 0; i < 80; i += 1) {
      state = applyChatEvent(state, 'chat.status', activity('task_started', { taskId: `t${i}`, toolUseId: `toolu_${i}` }));
    }
    expect(Object.keys(state.taskActivity).length).toBe(64);
    expect(state.taskActivity.toolu_79).toBeTruthy();
    expect(state.taskActivity.toolu_0).toBeUndefined();
  });
});
