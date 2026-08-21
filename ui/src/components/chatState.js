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

// Activity kinds that describe one dispatched subagent rather than the turn as a whole. These are
// what makes the live rail's detail view honest: the rail's rows come from the hook path, which only
// ever learns that a run opened and later closed, while these arrive from the session itself and say
// what the subagent is doing right now.
//
// `task_started`, `task_progress` and `task_notification` carry the dispatch's own `toolUseId`, which
// is the second half of the run id the rail renders. `tool_progress` carries the *inner* tool's
// `toolUseId` instead, so it is matched through `taskId` — hence the second map.
const TASK_ACTIVITY_KINDS = new Set(['task_started', 'task_progress', 'task_notification']);

// Bounded so a long session cannot grow this without limit. Oldest-first-seen is dropped, which for
// subagent dispatches is also the least likely to still be running.
const MAX_TASK_ACTIVITY = 64;

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
  taskActivity: {},   // dispatch toolUseId -> what that subagent is doing right now
  taskKeys: {},       // taskId -> dispatch toolUseId, so tool_progress can be attributed
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

// One API message reaches the browser as several `chat.message` frames that all carry the same
// `message.id`: the CLI splits it by content block, so a turn that explains itself and then asks a
// question arrives as [thinking], [text], [tool_use]. Replacing the item on a repeated id therefore
// dropped the explanation the moment the tool call landed — the question showed up alone, with the
// paragraph that set it up gone from the transcript. Frames are merged instead.
//
// A frame is also genuinely redelivered on a reconnect, so a block already on screen must not be
// printed twice: a tool_use is identified by its id, and text by its own content. A block that
// matches one already there replaces it in place, because the later frame is the more complete one
// (a tool_use whose input finished streaming, a text block that grew).
function sameBlock(a, b) {
  if (a?.type !== b?.type) return false;
  if (a.type === 'tool_use') return a.id != null && a.id === b.id;
  if (a.type !== 'text' && a.type !== 'thinking') return false;
  if (typeof a.text !== 'string' || typeof b.text !== 'string') return false;
  // Equal, or one is the other still growing. Two *distinct* paragraphs in one message where one is
  // a prefix of the other does not happen; the same paragraph re-sent longer does.
  return a.text === b.text || a.text.startsWith(b.text) || b.text.startsWith(a.text);
}

function mergeBlocks(prev, next) {
  const merged = [...prev];
  for (const block of next) {
    const at = merged.findIndex((b) => sameBlock(b, block));
    if (at >= 0) merged[at] = block;
    else merged.push(block);
  }
  return merged;
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

  // A message id that is already on screen is the same message again — another block of it, or a
  // frame replayed after a reconnect — never a second message.
  const existing = messageId == null ? -1
    : state.items.findIndex((i) => i.kind === 'message' && i.messageId === messageId && i.parentToolUseId === parentToolUseId);
  if (existing >= 0) {
    const items = [...state.items];
    const prev = items[existing];
    items[existing] = {
      ...prev,
      ...item,
      blocks: mergeBlocks(prev.blocks ?? [], item.blocks),
      // The first frame's timestamp is where this message sits in the conversation; a later block
      // of it arriving seconds afterwards must not restamp it.
      ts: prev.ts ?? item.ts,
    };
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

// Folds one activity event into the per-subagent view, returning the same objects untouched when the
// event says nothing about a dispatch — an identity return is what keeps React from re-rendering the
// rail on every progress tick that belongs to the main thread.
function withTaskActivity(state, activity) {
  const data = activity.data;
  if (data === null || typeof data !== 'object') return state;

  const taskId = typeof data.taskId === 'string' && data.taskId !== '' ? data.taskId : null;
  let key = null;
  if (TASK_ACTIVITY_KINDS.has(activity.kind)) {
    key = typeof data.toolUseId === 'string' && data.toolUseId !== '' ? data.toolUseId : null;
  } else if (activity.kind === 'tool_progress' && taskId !== null) {
    // The inner tool's own toolUseId is not a run id. Only the task it belongs to identifies the row.
    key = state.taskKeys[taskId] ?? null;
  }
  if (key === null) return state;

  const prev = state.taskActivity[key];
  const keep = (next, old) => (next === undefined || next === null ? old ?? null : next);
  const entry = {
    kind: activity.kind,
    ts: activity.ts ?? prev?.ts ?? null,
    subagentType: keep(data.subagentType, prev?.subagentType),
    description: keep(data.description, prev?.description),
    // `toolName` on a tool_progress, `lastToolName` on a task_progress: the same fact under two
    // names, and the rail only ever wants "what is it running right now".
    lastToolName: keep(data.lastToolName ?? data.toolName, prev?.lastToolName),
    summary: keep(data.summary, prev?.summary),
    status: keep(data.status, prev?.status),
    usage: keep(data.usage, prev?.usage),
    elapsedSeconds: typeof data.elapsedSeconds === 'number' ? data.elapsedSeconds : prev?.elapsedSeconds ?? null,
  };

  let taskActivity = { ...state.taskActivity, [key]: entry };
  const keys = Object.keys(taskActivity);
  if (keys.length > MAX_TASK_ACTIVITY) {
    taskActivity = Object.fromEntries(keys.slice(keys.length - MAX_TASK_ACTIVITY).map((k) => [k, taskActivity[k]]));
  }

  const taskKeys = taskId === null || state.taskKeys[taskId] === key
    ? state.taskKeys
    : { ...state.taskKeys, [taskId]: key };

  return { ...state, taskActivity, taskKeys };
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
    case 'activity': {
      const activity = { kind: payload.kind ?? null, data: payload.data ?? null, ts: payload.ts ?? null };
      return withTaskActivity({ ...state, sessionId, activity }, activity);
    }
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
