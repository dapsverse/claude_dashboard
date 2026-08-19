// src/chat/session.js
//
// One Claude Agent SDK session per project. The input side is an async queue feeding the
// `AsyncIterable<SDKUserMessage>` the SDK expects for an interactive session; the output side
// consumes the `Query` generator and turns each SDK message into an SSE event.
//
// Everything is keyed by project path — the session, its input queue, its stored resume id, its
// pending permission requests. A message for one project must never reach another's session.
import { isAgentDispatch } from '../core/correlator.js';

// The SDK defaults to isolation: with no settingSources it loads none of the user's CLAUDE.md,
// agents, skills, or plugins. This dashboard exists to drive *their* orchestrator, so all three
// sources are mandatory, not configurable.
export const SETTING_SOURCES = ['user', 'project', 'local'];

const MAX_STDERR_LINES = 20;

// Imported lazily so the unit suite — which always injects a fake — never loads the SDK, and so a
// broken install surfaces as one chat.error rather than a daemon that cannot boot.
const defaultSdk = {
  async query(params) {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    return query(params);
  },
};

// A promise-based queue: `push` never blocks, and the iterator parks until there is something to
// yield. The SDK holds this iterator open for the life of the session, so it must survive being
// exhausted between turns rather than returning done.
export function createInputQueue() {
  const queued = [];
  const waiters = [];
  let closed = false;

  return {
    push(message) {
      if (closed) return false;
      const waiter = waiters.shift();
      if (waiter) waiter({ value: message, done: false });
      else queued.push(message);
      return true;
    },
    close() {
      closed = true;
      for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
    },
    get closed() { return closed; },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queued.length) { yield queued.shift(); continue; }
        if (closed) return;
        const next = await new Promise((resolve) => waiters.push(resolve));
        if (next.done) return;
        yield next.value;
      }
    },
  };
}

export function createSessionManager({
  store, hub, now = Date.now,
  permissions,
  sdk = defaultSdk,
  model,
  maxTurns,
}) {
  const live = new Map();       // projectPath -> session
  const starting = new Map();   // projectPath -> Promise<session>, so racing sends start one session

  const emit = (event, projectPath, data) => hub.broadcast(event, { projectPath, ts: now(), ...data });

  function stop(projectPath, { quiet = true } = {}) {
    const session = live.get(projectPath);
    if (!session) return false;
    session.stopping = quiet;                   // suppresses the pump's terminal broadcasts
    live.delete(projectPath);
    permissions?.abortProject(projectPath);
    try { session.queue.close(); } catch { /* already closed */ }
    try { session.query?.close(); } catch { /* already closed */ }
    try { session.abortController.abort(); } catch { /* already aborted */ }
    return true;
  }

  async function start(projectPath) {
    const stored = store.getSession(projectPath);
    const resume = stored?.sessionId ?? null;
    const startedAt = now();
    const session = {
      projectPath, resume, startedAt,
      sessionId: resume,
      queue: createInputQueue(),
      abortController: new AbortController(),
      // One id per streaming message, tracked per branch: a subagent's deltas arrive interleaved
      // with the main thread's, and a single field would stamp them with each other's message id.
      streamIds: new Map(),
      stderr: [],
      stopping: false,
      query: null,
    };

    live.set(projectPath, session);
    store.touchSession(projectPath, startedAt);
    emit('chat.status', projectPath, { state: 'starting', sessionId: resume });

    const options = {
      cwd: projectPath,
      settingSources: SETTING_SOURCES,
      // Hardcoded. No route, body field or environment variable can widen this — `bypassPermissions`
      // would let a browser tab run any command with no prompt at all.
      permissionMode: 'default',
      includePartialMessages: true,
      canUseTool: permissions.forProject(projectPath),
      abortController: session.abortController,
      stderr: (data) => {
        session.stderr.push(String(data));
        if (session.stderr.length > MAX_STDERR_LINES) session.stderr.shift();
      },
      ...(model === undefined ? {} : { model }),
      ...(maxTurns === undefined ? {} : { maxTurns }),
      // forkSession stays false deliberately: a fork answers under a new session id, which would
      // orphan the id we stored and lose the conversation on the next resume.
      ...(resume === null ? {} : { resume, forkSession: false }),
    };

    try {
      session.query = await sdk.query({ prompt: session.queue, options });
    } catch (err) {
      live.delete(projectPath);
      emit('chat.error', projectPath, {
        message: 'Could not start a Claude session.',
        detail: describe(err),
        fatal: true,
      });
      throw err;
    }

    session.pump = pump(session);
    return session;
  }

  function ensure(projectPath) {
    const existing = live.get(projectPath);
    if (existing) return Promise.resolve(existing);
    const inflight = starting.get(projectPath);
    if (inflight) return inflight;
    const promise = start(projectPath).finally(() => starting.delete(projectPath));
    starting.set(projectPath, promise);
    return promise;
  }

  // Never rejects: a throw here would land on an unawaited promise and, under Node's default
  // --unhandled-rejections=throw, take the whole daemon down with it.
  async function pump(session) {
    const { projectPath } = session;
    try {
      for await (const message of session.query) {
        try { handle(session, message); }
        catch (err) {
          // One malformed message must not end the session; report it and keep reading.
          emit('chat.error', projectPath, { message: 'A message from Claude could not be handled.', detail: describe(err), fatal: false });
        }
      }
      if (!session.stopping) {
        live.delete(projectPath);
        emit('chat.status', projectPath, { state: 'closed', sessionId: session.sessionId });
      }
    } catch (err) {
      if (session.stopping) return;             // we tore it down on purpose
      live.delete(projectPath);
      // A resume that never produced an init message means the stored id no longer names a
      // conversation the CLI can find — a pruned transcript, a different machine, a deleted project
      // directory. Drop the id so the user is not stuck retrying into the same failure.
      const failedResume = session.resume !== null && session.startedFrom !== 'init';
      if (failedResume) store.clearSession(projectPath);
      emit('chat.error', projectPath, {
        message: failedResume
          ? 'The previous conversation could not be resumed and has been cleared. Send your message again to start a fresh one.'
          : 'The Claude session ended unexpectedly.',
        detail: [describe(err), ...session.stderr].filter(Boolean).join('\n').slice(0, 2000),
        fatal: true,
      });
    } finally {
      permissions?.abortProject(projectPath);
    }
  }

  function handle(session, message) {
    switch (message?.type) {
      case 'system':        return handleSystem(session, message);
      case 'assistant':     return handleAssistant(session, message);
      case 'stream_event':  return handleStream(session, message);
      case 'result':        return handleResult(session, message);
      case 'tool_progress':
        return activity(session, 'tool_progress', {
          toolUseId: message.tool_use_id ?? null, toolName: message.tool_name ?? null,
          elapsedSeconds: message.elapsed_time_seconds ?? null, taskId: message.task_id ?? null,
          subagentType: message.subagent_type ?? null,
        });
      case 'rate_limit_event':
        return warning(session, 'rate_limit_event', message.rate_limit_info ?? null);
      case 'auth_status':
        return warning(session, 'auth_status', {
          isAuthenticating: message.isAuthenticating === true, error: message.error ?? null,
        });
      default:
        // user replays, thinking-token accounting, hook lifecycle, whatever the next SDK release
        // adds: not every variant is chat, and an unknown one is never a reason to crash.
        return undefined;
    }
  }

  function handleSystem(session, message) {
    switch (message.subtype) {
      case 'init': {
        session.startedFrom = 'init';
        if (typeof message.session_id === 'string') {
          session.sessionId = message.session_id;
          store.setSessionId({ projectPath: session.projectPath, sessionId: message.session_id, at: now() });
        }
        return emit('chat.status', session.projectPath, {
          state: 'ready',
          sessionId: session.sessionId ?? null,
          model: message.model ?? null,
          tools: message.tools ?? [],
          agents: message.agents ?? [],
          permissionMode: message.permissionMode ?? null,
        });
      }
      case 'status':
        return activity(session, 'status', { status: message.status ?? null, permissionMode: message.permissionMode ?? null });
      case 'task_started':
        return activity(session, 'task_started', {
          taskId: message.task_id ?? null, toolUseId: message.tool_use_id ?? null,
          description: message.description ?? null, subagentType: message.subagent_type ?? null,
        });
      case 'task_progress':
        return activity(session, 'task_progress', {
          taskId: message.task_id ?? null, toolUseId: message.tool_use_id ?? null,
          description: message.description ?? null, subagentType: message.subagent_type ?? null,
          usage: message.usage ?? null, lastToolName: message.last_tool_name ?? null,
          summary: message.summary ?? null,
        });
      case 'task_notification':
        return activity(session, 'task_notification', {
          taskId: message.task_id ?? null, toolUseId: message.tool_use_id ?? null,
          status: message.status ?? null, summary: message.summary ?? null, usage: message.usage ?? null,
        });
      case 'permission_denied':
        // A denial that never reached our gate: a deny rule, dontAsk mode, or the auto classifier.
        // The user still has to be told why a tool did not run.
        return warning(session, 'permission_denied', {
          toolName: message.tool_name ?? null, toolUseId: message.tool_use_id ?? null,
          agentId: message.agent_id ?? null,
        });
      case 'model_refusal_fallback':
        return warning(session, 'model_refusal_fallback', {
          originalModel: message.original_model ?? null, fallbackModel: message.fallback_model ?? null,
          direction: message.direction ?? null,
        });
      case 'model_refusal_no_fallback':
        return warning(session, 'model_refusal_no_fallback', {
          originalModel: message.original_model ?? null, content: message.content ?? null,
        });
      default:
        return undefined;
    }
  }

  function handleAssistant(session, message) {
    const content = Array.isArray(message.message?.content) ? message.message.content : [];
    const blocks = content.map(toWireBlock).filter(Boolean);
    if (blocks.length === 0) return;

    const messageId = message.message?.id ?? message.uuid ?? null;
    const parentToolUseId = message.parent_tool_use_id ?? null;

    emit('chat.message', session.projectPath, {
      messageId, parentToolUseId, role: 'assistant',
      subagentType: message.subagent_type ?? null,
      blocks,
    });

    for (const block of blocks) {
      if (block.type !== 'tool_use') continue;
      emit('chat.tool_use', session.projectPath, {
        messageId, parentToolUseId,
        toolUseId: block.id, name: block.name, input: block.input,
        // Flags Task/Agent so the UI can tie this message to the row the hook path already puts in
        // the live rail, rather than rendering the dispatch twice as unrelated things.
        agentDispatch: isAgentDispatch(block.name),
      });
    }

    // Subagent chatter belongs to the rail, not the transcript: persisting it would replay another
    // agent's internal monologue into the conversation on the next reload.
    if (parentToolUseId === null) {
      store.append({ projectPath: session.projectPath, role: 'assistant', blocks, ts: now() });
    }
  }

  function handleStream(session, message) {
    const event = message.event;
    const branch = message.parent_tool_use_id ?? 'main';
    if (event?.type === 'message_start') {
      session.streamIds.set(branch, event.message?.id ?? null);
      return;
    }
    // Only text. A thinking_delta is not part of the answer, and splicing it into the same buffer
    // would render reasoning as if Claude had said it.
    if (event?.type !== 'content_block_delta' || event.delta?.type !== 'text_delta') return;
    emit('chat.delta', session.projectPath, {
      messageId: session.streamIds.get(branch) ?? null,
      parentToolUseId: message.parent_tool_use_id ?? null,
      text: event.delta.text ?? '',
    });
  }

  function handleResult(session, message) {
    const text = typeof message.result === 'string' ? message.result : null;
    const isError = message.is_error === true;
    emit('chat.result', session.projectPath, {
      sessionId: message.session_id ?? session.sessionId ?? null,
      subtype: message.subtype ?? null,
      isError,
      durationMs: message.duration_ms ?? null,
      durationApiMs: message.duration_api_ms ?? null,
      numTurns: message.num_turns ?? null,
      totalCostUsd: message.total_cost_usd ?? null,
      usage: message.usage ?? null,
      text,
    });
    store.append({
      projectPath: session.projectPath,
      role: 'system',
      blocks: [{
        type: 'result', text, isError,
        durationMs: message.duration_ms ?? null,
        totalCostUsd: message.total_cost_usd ?? null,
      }],
      ts: now(),
    });
    emit('chat.status', session.projectPath, { state: 'idle', sessionId: session.sessionId ?? null });
  }

  const activity = (session, kind, data) =>
    emit('chat.status', session.projectPath, { state: 'activity', kind, data, sessionId: session.sessionId ?? null });
  const warning = (session, kind, data) =>
    emit('chat.status', session.projectPath, { state: 'warning', kind, data, sessionId: session.sessionId ?? null });

  return {
    get(projectPath) {
      const session = live.get(projectPath);
      const stored = store.getSession(projectPath);
      return {
        projectPath,
        running: session !== undefined,
        sessionId: session?.sessionId ?? stored?.sessionId ?? null,
        startedAt: session?.startedAt ?? null,
        pendingPermissions: permissions?.list(projectPath) ?? [],
      };
    },

    async send(projectPath, text) {
      const body = typeof text === 'string' ? text.trim() : '';
      if (body === '') throw Object.assign(new Error('empty_message'), { code: 'EMPTY' });

      const ts = now();
      store.append({ projectPath, role: 'user', blocks: [{ type: 'text', text: body }], ts });
      const session = await ensure(projectPath);
      store.touchSession(projectPath, ts);

      session.queue.push({
        type: 'user',
        message: { role: 'user', content: body },
        parent_tool_use_id: null,
        // Keyboard input from the user's own browser. The SDK treats an unstamped message as
        // unattributed and fails closed at its strict human-trust gates.
        origin: { kind: 'human' },
      });
      emit('chat.status', projectPath, { state: 'busy', sessionId: session.sessionId ?? null });
      return { queued: true, sessionId: session.sessionId ?? null };
    },

    async interrupt(projectPath) {
      const session = live.get(projectPath);
      if (!session) return { interrupted: false };
      permissions?.abortProject(projectPath);
      try {
        await session.query?.interrupt();
      } catch (err) {
        emit('chat.error', projectPath, { message: 'The session could not be interrupted.', detail: describe(err), fatal: false });
        return { interrupted: false };
      }
      emit('chat.status', projectPath, { state: 'interrupted', sessionId: session.sessionId ?? null });
      return { interrupted: true };
    },

    async reset(projectPath) {
      stop(projectPath);
      store.clearSession(projectPath);
      emit('chat.status', projectPath, { state: 'reset', sessionId: null });
      return { reset: true };
    },

    async close() {
      for (const projectPath of [...live.keys()]) stop(projectPath);
      // Let each pump observe the closed generator before the caller tears the process down.
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

function toWireBlock(block) {
  switch (block?.type) {
    case 'text':
      return typeof block.text === 'string' ? { type: 'text', text: block.text } : null;
    case 'tool_use':
      // The raw input, unredacted: the browser has to render what the tool will actually do, and
      // the redacted copy is what gets written to the database.
      return { type: 'tool_use', id: block.id ?? null, name: block.name ?? null, input: block.input ?? {} };
    case 'thinking':
      return typeof block.thinking === 'string' ? { type: 'thinking', text: block.thinking } : null;
    default:
      return null;
  }
}

const describe = (err) => String(err?.stack ?? err?.message ?? err ?? 'unknown error');
