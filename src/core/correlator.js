// src/core/correlator.js
//
// Pure hook event correlator: one Claude Code hook event in, a list of actions out.
// No I/O, no clock reads, no database access — that keeps this the easiest module
// to test exhaustively, and the one the whole daemon turns on.
import { preview } from './redact.js';

// The subagent-dispatch tool is `Agent` on CLI 2.1.234 and `Task` on other builds; `toolAliases`
// can also rename it. Recognise the whole set rather than one build's spelling.
export const AGENT_TOOL_NAMES = new Set(['Agent', 'Task']);

export function isAgentDispatch(toolName) { return AGENT_TOOL_NAMES.has(toolName); }

export function runId(sessionId, toolUseId) { return `${sessionId}:${toolUseId}`; }

export function extractText(toolResponse) {
  if (toolResponse == null) return '';
  if (typeof toolResponse === 'string') return toolResponse;
  const { content } = toolResponse;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
  }
  return JSON.stringify(toolResponse);
}

export function isErrorResponse(toolResponse) {
  if (toolResponse == null) return false;
  if (typeof toolResponse === 'object' && toolResponse.is_error === true) return true;
  return /^Error\b/.test(extractText(toolResponse));
}

// A dispatch that ran in the background returns the instant the agent is launched: the response
// says `async_launched` and carries only the agent's id, and the PostToolUse hook fires ~10ms after
// PreToolUse. Treating that as completion is what closed a still-working subagent as "done" in 0s
// and dropped it out of `listActive()`. The agent's real end arrives later, as SubagentStop.
export function isAsyncLaunch(toolResponse) {
  if (toolResponse === null || typeof toolResponse !== 'object') return false;
  return toolResponse.isAsync === true || toolResponse.status === 'async_launched';
}

// Both response shapes report it, and SubagentStop reports the same value as `agent_id`: this is the
// only exact join between a launch and the stop that ends it.
const agentIdOf = (toolResponse) => (typeof toolResponse?.agentId === 'string' && toolResponse.agentId !== ''
  ? toolResponse.agentId
  : null);

export function planActions(event, { now }) {
  if (!event || typeof event.session_id !== 'string') return [];

  const actions = [{
    type: 'session.touch',
    session: { id: event.session_id, projectPath: event.cwd ?? null, source: 'terminal', at: now },
  }];

  const input = event.tool_input ?? {};

  switch (event.hook_event_name) {
    case 'PreToolUse':
      if (isAgentDispatch(event.tool_name) && event.tool_use_id) {
        actions.push({
          type: 'run.open',
          run: {
            id: runId(event.session_id, event.tool_use_id),
            sessionId: event.session_id,
            agentType: input.subagent_type ?? null,
            description: input.description ?? null,
            prompt: preview(input.prompt, 2000),
            startedAt: now,
          },
        });
      }
      break;

    case 'PostToolUse':
      if (isAgentDispatch(event.tool_name) && event.tool_use_id) {
        // A background launch only records who to expect a SubagentStop from. The run stays running,
        // because it is.
        if (isAsyncLaunch(event.tool_response)) {
          actions.push({
            type: 'run.launch',
            id: runId(event.session_id, event.tool_use_id),
            agentId: agentIdOf(event.tool_response),
          });
          break;
        }
        actions.push({
          type: 'run.close',
          close: {
            id: runId(event.session_id, event.tool_use_id),
            status: isErrorResponse(event.tool_response) ? 'error' : 'done',
            endedAt: now,
            durationMs: event.duration_ms ?? null,
            resultPreview: preview(extractText(event.tool_response)),
            agentId: agentIdOf(event.tool_response),
          },
        });
      }
      break;

    // The end of one subagent. `agent_id` is an exact match against the id a background launch
    // recorded, so a run started in the background is closed here with a real duration. `agent_type`
    // stays as the fallback for a build that reports no id, and for a foreground run — already
    // closed by its own PostToolUse — where this only fills in the transcript path. Skipped
    // entirely when neither is present, because a guess would close some other agent's run.
    case 'SubagentStop':
      if (event.agent_id || event.agent_type) {
        actions.push({
          type: 'run.finish',
          match: {
            agentId: event.agent_id ?? null,
            sessionId: event.session_id,
            agentType: event.agent_type ?? null,
          },
          patch: {
            endedAt: now,
            transcriptPath: event.agent_transcript_path ?? null,
            resultPreview: event.last_assistant_message ? preview(event.last_assistant_message) : null,
          },
        });
      }
      break;

    case 'SessionEnd':
      actions.push({ type: 'session.end', sessionId: event.session_id, at: now });
      break;

    default:
      break;   // every other event contributes only the session touch
  }

  return actions;
}
