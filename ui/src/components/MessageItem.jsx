import { Markdown } from './Markdown.jsx';
import { ToolCard, DispatchChip } from './ToolCard.jsx';
import { isDispatch } from './chatState.js';

const ROLE_LABEL = { user: 'you', assistant: 'claude', system: 'session' };

const clock = (ts) => {
  if (!Number.isFinite(ts)) return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const WARNING_TEXT = {
  rate_limit_event: (d) => `Rate limit ${d?.status ?? 'update'}${d?.resetsAt ? ` — resets ${new Date(d.resetsAt * 1000).toLocaleTimeString()}` : ''}.`,
  auth_status: (d) => (d?.error ? `Authentication problem: ${d.error}` : 'Re-authenticating with Anthropic.'),
  permission_denied: (d) => `${d?.toolName ?? 'A tool'} was denied by Claude Code's own permission rules, before this dashboard was asked.`,
  model_refusal_fallback: (d) => `${d?.originalModel ?? 'The model'} refused; continuing on ${d?.fallbackModel ?? 'a fallback model'}.`,
  model_refusal_no_fallback: (d) => `${d?.originalModel ?? 'The model'} refused and there is no fallback configured.`,
};

function warningText(kind, data) {
  const build = WARNING_TEXT[kind];
  return build ? build(data) : kind;
}

export function TranscriptItem({ item, state, runs, now }) {
  if (item.kind === 'error') {
    return (
      <div className={`chat-error${item.fatal ? ' fatal-error' : ''}`} role="alert">
        <p className="chat-error-message">{item.message}</p>
        {item.fatal && <p className="chat-error-hint">This session has ended. Sending again starts a new one.</p>}
        {item.detail && (
          <details>
            <summary>diagnostic detail</summary>
            <pre className="raw" tabIndex={0}>{item.detail}</pre>
          </details>
        )}
      </div>
    );
  }

  if (item.kind === 'warning') {
    return (
      <div className="chat-warning" role="status">
        <span className="badge stale">{item.warningKind}</span>
        <span>{warningText(item.warningKind, item.data)}</span>
      </div>
    );
  }

  const nested = item.parentToolUseId != null;
  return (
    <article className={`msg ${item.role}${nested ? ' nested' : ''}`}>
      <header className="msg-head">
        <span className="msg-role mono">{ROLE_LABEL[item.role] ?? item.role}</span>
        {item.subagentType && <span className="badge plugin">{item.subagentType}</span>}
        {nested && !item.subagentType && <span className="badge plugin">subagent</span>}
        {item.ts && <span className="msg-time" aria-hidden="true">{clock(item.ts)}</span>}
      </header>
      <div className="msg-body">
        {item.blocks.map((block, index) => {
          const key = `${item.key}b${index}`;
          if (block.type === 'text') {
            // The user's own words are shown exactly as typed. Running them through the markdown
            // renderer would silently restyle a message they can still see in their own scrollback.
            return item.role === 'user'
              ? <p key={key} className="user-text">{block.text}</p>
              : <Markdown key={key} source={block.text} />;
          }
          if (block.type === 'thinking') {
            return (
              <details key={key} className="thinking">
                <summary>thinking</summary>
                <div className="thinking-body">{block.text}</div>
              </details>
            );
          }
          if (block.type === 'tool_use') {
            if (isDispatch(state, block)) {
              // The rail keys a run by `${sessionId}:${toolUseId}`, and the session id there comes
              // from the hook path rather than from this session object. Matching on the tool use id
              // alone is what makes the link hold when the two spellings differ.
              const run = runs.find((r) => typeof r.id === 'string' && r.id.endsWith(`:${block.id}`));
              return <DispatchChip key={key} block={block} run={run} now={now} />;
            }
            return <ToolCard key={key} block={block} />;
          }
          return null;
        })}
      </div>
    </article>
  );
}

/** The in-flight delta buffer: the same shape as an assistant message, drawn while it is still growing. */
export function StreamingMessage({ buffer }) {
  const nested = buffer.branch !== 'main';
  return (
    <article className={`msg assistant streaming${nested ? ' nested' : ''}`} aria-busy="true">
      <header className="msg-head">
        <span className="msg-role mono">claude</span>
        {nested && <span className="badge plugin">subagent</span>}
      </header>
      <div className="msg-body">
        <Markdown source={buffer.text} />
      </div>
    </article>
  );
}
