// Pure, framework-free reducer for the chat transcript. Kept out of the React tree for the same
// reason `runList.js` is: every subtle rule below — a delta buffer being replaced by its final
// message, a `chat.tool_use` that must not be drawn a second time, a cost that is cumulative rather
// than additive — is a rule about data, and it is far easier to get right, and to keep right, when
// it can be exercised without rendering anything.
//
// Everything here is scoped to one project. Filtering by `projectPath` happens at the call site,
// before an event reaches this module.

// `Task` on most builds, `Agent` on CLI 2.1.234 — mirrors the daemon's own set. This is only a
// fallback for restored history, which carries no `agentDispatch` flag; live events carry the flag
// and it always wins, so a build that renames the tool degrades to "not a dispatch" rather than to
// a wrong answer.
const AGENT_TOOL_NAMES = new Set(['Agent', 'Task']);

// Everything the SDK reports as `warning` that a user can act on. `activity` kinds are progress
// noise and never become transcript items; an unrecognised kind of either sort is ignored, because
// more of them appear with every SDK release.
export const SURFACED_WARNINGS = new Set([
  'rate_limit_event', 'auth_status', 'permission_denied',
  'model_refusal_fallback', 'model_refusal_no_fallback',
]);

// A turn is in flight for exactly these. The composer is disabled here and nowhere else — an
// `interrupted`, `closed`, `reset` or fatally errored session all accept a new message, and the
// next send simply starts a fresh session.
const BUSY_STATES = new Set(['starting', 'busy']);

export const initialChatState = {
  status: 'unknown',
  sessionId: null,
  model: null,
  permissionMode: null,
  tools: [],
  agents: [],
  items: [],
  streams: {},        // branch ('main' or a parentToolUseId) -> { messageId, text }
  dispatches: {},     // toolUseId -> { name, input, agentDispatch }
  result: null,       // the latest chat.result, whose cost and usage are cumulative
  activity: null,
  completed: [],      // message ids already finalised, so a late delta cannot resurrect them
  seq: 0,
};

export const isBusy = (state) => BUSY_STATES.has(state.status);

const MAX_COMPLETED = 100;

const branchOf = (payload) => payload?.parentToolUseId ?? 'main';

function withoutBranch(streams, branch) {
  if (!(branch in streams)) return streams;
  const next = { ...streams };
  delete next[branch];
  return next;
}

function remember(completed, messageId) {
  if (messageId === null || messageId === undefined) return completed;
  const next = completed.includes(messageId) ? completed : [...completed, messageId];
  return next.length > MAX_COMPLETED ? next.slice(next.length - MAX_COMPLETED) : next;
}

/** The scratch buffers to draw after the last item, newest branch state per branch. */
export function streamingBuffers(state) {
  return Object.entries(state.streams)
    .filter(([, buffer]) => buffer.text !== '')
    .map(([branch, buffer]) => ({ branch, ...buffer }));
}

/** True when this tool call dispatched a subagent, so the UI links it to the live rail row. */
export function isDispatch(state, block) {
  const known = block?.id == null ? undefined : state.dispatches[block.id];
  if (known) return known.agentDispatch === true;
  return AGENT_TOOL_NAMES.has(block?.name);
}

// A failed turn arrives twice: the CLI's own error sentence lands as the last assistant message, and
// then again as the text of the `result`. Appending both prints the same line to the user twice, once
// as an answer and once as an error box — which is how "you've hit your session limit" ended up on
// screen in duplicate. The footer's failed-turn marker carries the signal instead.
function duplicatesLastText(state, text) {
  if (typeof text !== 'string' || text.trim() === '') return false;
  for (let i = state.items.length - 1; i >= 0; i -= 1) {
    const item = state.items[i];
    if (item.kind !== 'message') continue;
    const last = [...item.blocks].reverse().find((b) => b?.type === 'text');
    return typeof last?.text === 'string' && last.text.trim() === text.trim();
  }
  return false;
}

function appendItem(state, item) {
  return { ...state, seq: state.seq + 1, items: [...state.items, { key: `i${state.seq}`, ...item }] };
}

/** The user's own message, echoed locally: the daemon stores it but never broadcasts it back. */
export function appendUserMessage(state, text, ts) {
  return appendItem(state, { kind: 'message', role: 'user', blocks: [{ type: 'text', text }], ts, parentToolUseId: null });
}

function applyMessage(state, payload) {
  const { messageId, parentToolUseId = null } = payload;
  const item = {
    kind: 'message',
    role: payload.role ?? 'assistant',
    messageId: messageId ?? null,
    parentToolUseId,
    subagentType: payload.subagentType ?? null,
    blocks: Array.isArray(payload.blocks) ? payload.blocks : [],
    ts: payload.ts ?? null,
  };

  // The delta buffer for this branch was a preview of exactly this message. Dropping it in the same
  // update that appends the message is what makes the swap atomic: React never renders a frame
  // holding both, so there is no flicker and no doubled paragraph.
  const streams = withoutBranch(state.streams, branchOf(payload));
  const completed = remember(state.completed, messageId);

  // A message id that is already on screen is the same message again (a redelivered frame, a
  // reconnect that replayed it), not a second one.
  const existing = messageId == null ? -1
    : state.items.findIndex((i) => i.kind === 'message' && i.messageId === messageId && i.parentToolUseId === parentToolUseId);
  if (existing >= 0) {
    const items = [...state.items];
    items[existing] = { ...items[existing], ...item };
    return { ...state, items, streams, completed };
  }

  return { ...appendItem({ ...state, streams, completed }, item) };
}

function applyDelta(state, payload) {
  const text = typeof payload.text === 'string' ? payload.text : '';
  if (text === '') return state;
  const messageId = payload.messageId ?? null;
  // The final message already landed for this id; a delta arriving after it is a straggler from the
  // same turn, and appending it would print the tail of the answer twice.
  if (messageId !== null && state.completed.includes(messageId)) return state;

  const branch = branchOf(payload);
  const buffer = state.streams[branch];
  const sameMessage = buffer !== undefined
    && (messageId === null || buffer.messageId === null || buffer.messageId === messageId);

  return {
    ...state,
    streams: {
      ...state.streams,
      [branch]: sameMessage
        ? { messageId: buffer.messageId ?? messageId, text: buffer.text + text, parentToolUseId: payload.parentToolUseId ?? null }
        : { messageId, text, parentToolUseId: payload.parentToolUseId ?? null },
    },
  };
}

function applyStatus(state, payload) {
  const sessionId = payload.sessionId ?? state.sessionId;
  switch (payload.state) {
    case 'starting':
      return { ...state, status: 'starting', sessionId: payload.sessionId ?? null };
    case 'ready':
      return {
        ...state,
        // `ready` describes the session, not the turn, and it arrives *after* `busy` on a cold
        // start. Letting it overwrite `busy` would re-enable the composer in the middle of a turn.
        status: state.status === 'busy' ? 'busy' : 'ready',
        sessionId,
        model: payload.model ?? null,
        tools: Array.isArray(payload.tools) ? payload.tools : [],
        agents: Array.isArray(payload.agents) ? payload.agents : [],
        permissionMode: payload.permissionMode ?? null,
      };
    case 'busy':
      return { ...state, status: 'busy', sessionId };
    case 'idle':
    case 'interrupted':
    case 'closed':
      return { ...state, status: payload.state, sessionId, activity: null, streams: {} };
    case 'reset':
      // A reset discards the conversation on the daemon side — the transcript and the resume id go
      // together, so leaving the messages up would show a history the next session cannot remember.
      return { ...initialChatState, status: 'reset' };
    case 'activity':
      return { ...state, sessionId, activity: { kind: payload.kind ?? null, data: payload.data ?? null, ts: payload.ts ?? null } };
    case 'warning':
      return SURFACED_WARNINGS.has(payload.kind)
        ? appendItem({ ...state, sessionId }, { kind: 'warning', warningKind: payload.kind, data: payload.data ?? null, ts: payload.ts ?? null })
        : { ...state, sessionId };
    default:
      return state;
  }
}

export function applyChatEvent(state, name, payload) {
  switch (name) {
    case 'chat.delta':
      return applyDelta(state, payload);
    case 'chat.message':
      return applyMessage(state, payload);
    case 'chat.tool_use':
      // Deliberately never appends. The identical block is already inside the `chat.message` this
      // event follows, and rendering both is how the same tool call gets drawn twice. All it does
      // is record what only this event knows: whether the call dispatched a subagent.
      return payload.toolUseId == null ? state : {
        ...state,
        dispatches: {
          ...state.dispatches,
          [payload.toolUseId]: {
            name: payload.name ?? null,
            input: payload.input ?? null,
            agentDispatch: payload.agentDispatch === true,
          },
        },
      };
    case 'chat.result': {
      // Cumulative for the session, so the latest wins outright. Adding these up would report a
      // cost several times the real one by the fourth turn.
      const next = { ...state, result: payload };
      if (!payload.isError) return next;
      if (duplicatesLastText(state, payload.text)) return next;
      return appendItem(next, { kind: 'error', message: payload.text ?? `The turn ended with ${payload.subtype ?? 'an error'}.`, detail: null, fatal: false, ts: payload.ts ?? null });
    }
    case 'chat.error':
      return appendItem(
        { ...state, status: payload.fatal ? 'error' : state.status, streams: payload.fatal ? {} : state.streams },
        { kind: 'error', message: payload.message ?? 'Something went wrong.', detail: payload.detail ?? null, fatal: payload.fatal === true, ts: payload.ts ?? null },
      );
    case 'chat.status':
      return applyStatus(state, payload);
    default:
      return state;
  }
}

// Stored blocks are not wire blocks: a persisted tool_use carries `inputPreview` (redacted, bounded)
// instead of `input`, and a finished turn is a `result` block under role `system`. The transcript
// renders one shape, so history is normalised into it here rather than in the components.
export function fromHistory(history) {
  let state = { ...initialChatState, sessionId: history?.sessionId ?? null };
  const messages = Array.isArray(history?.messages) ? history.messages : [];

  for (const message of messages) {
    const blocks = Array.isArray(message.blocks) ? message.blocks : [];
    const resultBlock = blocks.find((b) => b?.type === 'result');
    if (resultBlock) {
      // Seeds the footer from the last stored turn, so a reloaded tab shows the session's real
      // cumulative cost instead of blanks until the next result arrives.
      state = {
        ...state,
        result: {
          ...state.result,
          totalCostUsd: resultBlock.totalCostUsd ?? null,
          durationMs: resultBlock.durationMs ?? null,
          isError: resultBlock.isError === true,
          usage: state.result?.usage ?? null,
          numTurns: state.result?.numTurns ?? null,
        },
      };
      if (resultBlock.isError && !duplicatesLastText(state, resultBlock.text)) {
        state = appendItem(state, { kind: 'error', message: resultBlock.text ?? 'The turn ended with an error.', detail: null, fatal: false, ts: message.ts ?? null });
      }
      continue;                                 // a successful result repeats the last answer verbatim
    }
    const renderable = blocks.filter((b) => b?.type === 'text' || b?.type === 'tool_use' || b?.type === 'thinking');
    if (renderable.length === 0) continue;
    state = appendItem(state, {
      kind: 'message',
      role: message.role ?? 'assistant',
      messageId: null,
      parentToolUseId: null,
      subagentType: null,
      blocks: renderable,
      ts: message.ts ?? null,
      restored: true,
    });
  }

  // `running` says a session is alive, not that a turn is in flight — the composer stays usable, and
  // a message sent into a live session is queued behind whatever it is doing.
  return { ...state, status: history?.running ? 'ready' : 'unknown' };
}
