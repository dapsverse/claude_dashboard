// src/core/correlator.js
//
// Pure hook event correlator: one Claude Code hook event in, a list of actions out.
// No I/O, no clock reads, no database access — that keeps this the easiest module
// to test exhaustively, and the one the whole daemon turns on.
import { preview } from './redact.js';

// The dispatch tool that spawns a subagent. Verified against real hook payloads
// captured from CLI 2.1.234: the tool is named 'Agent', not 'Task', though the
// SDK's own type names suggest otherwise. 'Task' is kept for other builds and for
// setups where toolAliases renames the tool.
const AGENT_TOOL_NAMES = new Set(['Agent', 'Task']);

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

export function planActions(event, { now }) {
  if (!event || typeof event.session_id !== 'string') return [];

  const actions = [{
    type: 'session.touch',
    session: { id: event.session_id, projectPath: event.cwd ?? null, source: 'terminal', at: now },
  }];

  const input = event.tool_input ?? {};

  switch (event.hook_event_name) {
    case 'PreToolUse':
      if (AGENT_TOOL_NAMES.has(event.tool_name) && event.tool_use_id) {
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
      if (AGENT_TOOL_NAMES.has(event.tool_name) && event.tool_use_id) {
        actions.push({
          type: 'run.close',
          close: {
            id: runId(event.session_id, event.tool_use_id),
            status: isErrorResponse(event.tool_response) ? 'error' : 'done',
            endedAt: now,
            durationMs: event.duration_ms ?? null,
            resultPreview: preview(extractText(event.tool_response)),
          },
        });
      }
      break;

    // Heuristic only: SubagentStop shares no join key with the Task/Agent events, so it
    // matches the oldest open run with the same (session_id, agent_type) and is skipped
    // when that is not determinable.
    case 'SubagentStop':
      if (event.agent_type) {
        actions.push({
          type: 'run.enrich',
          match: { sessionId: event.session_id, agentType: event.agent_type },
          patch: {
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
