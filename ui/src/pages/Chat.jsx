import { useEffect, useRef } from 'react';
import { TranscriptItem, StreamingMessage } from '../components/MessageItem.jsx';
import { Composer } from '../components/Composer.jsx';
import { SessionFooter } from '../components/SessionFooter.jsx';
import { streamingBuffers } from '../components/chatState.js';

const ACTIVITY_TEXT = {
  task_started: (d) => `dispatching ${d?.subagentType ?? 'a subagent'}${d?.description ? ` — ${d.description}` : ''}`,
  task_progress: (d) => `${d?.subagentType ?? 'subagent'} working${d?.lastToolName ? ` — ${d.lastToolName}` : ''}`,
  task_notification: (d) => `${d?.subagentType ?? 'subagent'} ${d?.status ?? 'reported'}`,
  tool_progress: (d) => `${d?.toolName ?? 'tool'} running${typeof d?.elapsedSeconds === 'number' ? ` ${Math.round(d.elapsedSeconds)}s` : ''}`,
  status: (d) => (typeof d?.status?.message === 'string' ? d.status.message : 'working'),
};

function activityLine(activity) {
  if (!activity) return null;
  const build = ACTIVITY_TEXT[activity.kind];
  return build ? build(activity.data) : null;
}

export function Chat({ session, runs, now, catalog = null }) {
  const { chat, selected, busy, historyError, permissionNotice, dismissPermissionNotice } = session;
  const scrollerRef = useRef(null);
  const pinnedRef = useRef(true);
  const buffers = streamingBuffers(chat);

  // Follow the conversation only while the user is already at the bottom. Yanking the view down
  // while they are reading something further up is the single most irritating thing a chat log can
  // do, and a streaming answer would do it several times a second.
  useEffect(() => {
    const el = scrollerRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [chat.items, buffers.length, chat.streams]);

  const onScroll = () => {
    const el = scrollerRef.current;
    if (el) pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  const activity = busy ? activityLine(chat.activity) : null;
  const disabledReason = selected === null
    ? 'Choose a project in the sidebar before sending a message.'
    : null;

  return (
    <div className="chat">
      {permissionNotice && (
        <p className="notice" role="status">
          {permissionNotice}
          <button type="button" className="btn subtle" onClick={dismissPermissionNotice}>Dismiss</button>
        </p>
      )}
      {historyError && (
        <p className="notice" role="status">
          Could not load this project&apos;s history ({historyError}). Anything below is only what has
          arrived since this page opened.
        </p>
      )}

      {/* role="log" announces each completed message once. The streaming buffer below is hidden from
          assistive technology on purpose: announcing a partial answer several times a second is
          noise, and the finished message that replaces it is announced in full. */}
      <div className="transcript" ref={scrollerRef} onScroll={onScroll} role="log" aria-label="Conversation" aria-busy={busy}>
        {chat.items.length === 0 && buffers.length === 0
          ? (
            selected === null
              ? <p className="empty">Pick a project in the sidebar, or add one, and the conversation for it appears here.</p>
              : (
                <p className="empty">
                  Nothing in this conversation yet. Send a message to start one — Claude runs in{' '}
                  <span className="mono">{selected}</span> with your own agents, skills and CLAUDE.md loaded,
                  and any tool call that needs approval pauses here for you to answer.
                </p>
              )
          )
          : chat.items.map((item) => (
            <TranscriptItem key={item.key} item={item} state={chat} runs={runs} now={now} />
          ))}

        {buffers.map((buffer) => (
          <div key={buffer.branch} aria-hidden="true"><StreamingMessage buffer={buffer} /></div>
        ))}

        {busy && (
          <p className="activity-line" aria-hidden="true">
            <span className="dot running" />
            {activity ?? 'working'}
          </p>
        )}
      </div>

      <Composer
        busy={busy}
        disabledReason={disabledReason}
        // The same catalog the Agents and Skills pages render, reused as the composer's @ list: the
        // orchestrator can only dispatch what is actually installed.
        catalog={catalog}
        onSend={session.send}
        onInterrupt={session.interrupt}
        onReset={session.reset}
      />
      <SessionFooter state={chat} />
    </div>
  );
}
