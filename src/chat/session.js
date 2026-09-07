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

// A session that dies because the account ran out of quota is not "ended unexpectedly", and saying
// so hides the one fact that matters: it can be continued once the limit resets. The SDK reports the
// limit as its own message type, so the last one seen is what classifies the death.
const RATE_LIMITED = /rate.?limit|usage limit|quota/i;

// The SDK's own type does not say whether `resetsAt` is seconds or milliseconds, and the repo held
// both readings at once: the transcript rendered it as seconds while the resume scheduler compared it
// against Date.now(). Read as milliseconds, a seconds value is always in the past, so the one
// automatic resume would fire on the next tick instead of when the limit lifts — spending it while
// still rate limited. Any real epoch below 1e12 is seconds (1e12 ms is September 2001; 1e12 seconds
// is the year 33658), so this settles it in both directions, once, before anything downstream sees it.
const EPOCH_MS_FLOOR = 1e12;

function toEpochMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value < EPOCH_MS_FLOOR ? Math.round(value * 1000) : value;
}

export function createSessionManager({
  store, hub, now = Date.now,
  permissions,
  sdk = defaultSdk,
  model,
  maxTurns,
  // Called once when a session stops without being torn down on purpose. The runs a dead session
  // dispatched are still open in the database, and nothing else notices: the CLI that would have
  // fired SessionEnd is the process that just died. Without this the rail keeps claiming those
  // subagents are alive until the 30-minute sweeper gets to them.
  onSessionEnd,
  // Called for every activity message a live session emits. The heartbeat half tells the liveness
  // sweeper this session is still working; the task_notification half is the only place a subagent
  // stopped mid-session is ever announced — an interrupted agent fires no SubagentStop, so without
  // this its run sits `running` until the 30-minute sweeper.
  onActivity,
}) {
  const live = new Map();       // projectPath -> session
  const starting = new Map();   // projectPath -> Promise<session>, so racing sends start one session
  // Outlive the session objects on purpose: both are read after the session is gone, to explain why
  // it went and to offer the resume.
  const lastRateLimit = new Map();  // projectPath -> SDKRateLimitInfo
  const lastStop = new Map();       // projectPath -> { reason, at, resetsAt }

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
        message: startFailureMessage(err),
        detail: [describe(err), startFailureHint(err)].filter(Boolean).join('\n\n'),
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
        const stop = classifyStop(session, null);
        emit('chat.status', projectPath, { state: 'closed', sessionId: session.sessionId, ...stop });
        announceEnd(session, stop);
      }
    } catch (err) {
      if (session.stopping) return;             // we tore it down on purpose
      live.delete(projectPath);
      // A resume that never produced an init message means the stored id no longer names a
      // conversation the CLI can find — a pruned transcript, a different machine, a deleted project
      // directory. Drop the id so the user is not stuck retrying into the same failure.
      const failedResume = session.resume !== null && session.startedFrom !== 'init';
      if (failedResume) store.clearSession(projectPath);
      const stop = classifyStop(session, err);
      emit('chat.error', projectPath, {
        message: failedResume
          ? 'The previous conversation could not be resumed and has been cleared. Send your message again to start a fresh one.'
          : stop.stopReason === 'rate_limit'
            ? 'The rate limit ran out and the session stopped. It can be continued once the limit resets.'
            : 'The Claude session ended unexpectedly.',
        detail: [describe(err), ...session.stderr].filter(Boolean).join('\n').slice(0, 2000),
        fatal: true,
        ...stop,
      });
      announceEnd(session, stop);
    } finally {
      permissions?.abortProject(projectPath);
    }
  }

  // Why a session stopped, from the last thing it said rather than from a guess. A `rejected` rate
  // limit is definitive; the stderr and error text are the fallback for a CLI that died before it
  // could report one.
  function classifyStop(session, err) {
    const info = lastRateLimit.get(session.projectPath) ?? null;
    const rejected = info?.status === 'rejected' || info?.overageStatus === 'rejected';
    const mentioned = RATE_LIMITED.test([describe(err), ...session.stderr].join('\n'));
    const stopReason = rejected || (err != null && mentioned) ? 'rate_limit' : 'session_ended';
    const resetsAt = stopReason === 'rate_limit' ? toEpochMs(info?.resetsAt) : null;
    const stop = { stopReason, resetsAt, rateLimitType: info?.rateLimitType ?? null };
    lastStop.set(session.projectPath, { ...stop, at: now() });
    return stop;
  }

  // Never lets a listener's throw reach the pump: this runs on the way out of a session that has
  // already failed once, and a second failure here would land on an unawaited promise.
  function announceEnd(session, stop) {
    try {
      onSessionEnd?.({
        projectPath: session.projectPath,
        sessionId: session.sessionId ?? null,
        reason: stop.stopReason,
        resetsAt: stop.resetsAt,
      });
    } catch (err) {
      emit('chat.error', session.projectPath, { message: 'Could not tidy up after the session ended.', detail: describe(err), fatal: false });
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
      case 'rate_limit_event': {
        const raw = message.rate_limit_info ?? null;
        // Normalised here and nowhere else, so the stored copy, the broadcast copy and the resume
        // scheduler can never disagree about what the number means.
        const info = raw === null ? null : { ...raw, resetsAt: toEpochMs(raw.resetsAt) };
        // Kept per project rather than per session: the session object is dropped the moment the
        // pump ends, and this is exactly what the pump needs to read on its way out.
        if (info) lastRateLimit.set(session.projectPath, info);
        return warning(session, 'rate_limit_event', info);
      }
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
        // A session that reached init is running again, so the previous death has been answered and
        // its rate-limit episode is over. Leaving either in place would keep offering a resume for a
        // conversation that is already resumed.
        lastStop.delete(session.projectPath);
        lastRateLimit.delete(session.projectPath);
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

  const activity = (session, kind, data) => {
    // Before the broadcast and never able to stop it: a listener that throws must not cost the
    // browser the activity event, and this runs on the SDK's own message loop.
    try { onActivity?.({ sessionId: session.sessionId ?? null, projectPath: session.projectPath, kind, data }); }
    catch { /* the sweeper's bookkeeping is not worth a dropped message */ }
    return emit('chat.status', session.projectPath, { state: 'activity', kind, data, sessionId: session.sessionId ?? null });
  };
  const warning = (session, kind, data) =>
    emit('chat.status', session.projectPath, { state: 'warning', kind, data, sessionId: session.sessionId ?? null });

  return {
    get(projectPath) {
      const session = live.get(projectPath);
      const stored = store.getSession(projectPath);
      const stop = lastStop.get(projectPath) ?? null;
      return {
        projectPath,
        running: session !== undefined,
        sessionId: session?.sessionId ?? stored?.sessionId ?? null,
        startedAt: session?.startedAt ?? null,
        pendingPermissions: permissions?.list(projectPath) ?? [],
        // Survives a browser reload: the page has to be able to offer the resume again without
        // having witnessed the death itself.
        stopReason: stop?.stopReason ?? null,
        resetsAt: stop?.resetsAt ?? null,
        rateLimit: lastRateLimit.get(projectPath) ?? null,
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

// The SDK ships its CLI as one optional dependency per platform, so npm installs only the build
// matching the architecture it ran under. Install with an x64 Node under Rosetta on an Apple Silicon
// machine and the arm64 build — the one the SDK then goes looking for — was never fetched. The SDK's
// own message names the missing target and stops there, which reads as a broken dashboard rather
// than as one install away from working, and it is the same wording whether the user just reset the
// session or never had a working one.
const MISSING_BINARY = /native cli binary/i;

const startFailureMessage = (err) =>
  (MISSING_BINARY.test(describe(err))
    ? 'Could not start a Claude session: the Claude CLI for this machine is not installed.'
    : 'Could not start a Claude session.');

const startFailureHint = (err) =>
  (MISSING_BINARY.test(describe(err))
    ? [
      'The Claude Agent SDK installs its CLI per architecture. This usually means the dashboard was',
      'installed by a Node built for a different one — an x64 Node under Rosetta on an Apple Silicon',
      'Mac is the common case, and `node -p process.arch` next to `uname -m` will say so.',
      'Reinstall with a Node matching the machine (and without --omit=optional), then restart the daemon.',
    ].join(' ')
    : null);

const describe = (err) => String(err?.stack ?? err?.message ?? err ?? 'unknown error');
