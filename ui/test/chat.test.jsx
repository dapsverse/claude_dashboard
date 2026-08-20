import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { ToolCard, DispatchChip } from '../src/components/ToolCard.jsx';
import { PermissionModal } from '../src/components/PermissionModal.jsx';
import { SessionFooter } from '../src/components/SessionFooter.jsx';
import { Composer } from '../src/components/Composer.jsx';
import { ProjectSwitcher } from '../src/components/ProjectSwitcher.jsx';
import { Chat } from '../src/pages/Chat.jsx';
import { initialChatState, applyChatEvent, appendUserMessage } from '../src/components/chatState.js';

// The stored shape the daemon actually writes: no `input`, a redacted JSON string instead.
const STORED_WRITE = { type: 'tool_use', id: 'toolu_1', name: 'Write', inputPreview: '{"file_path":"/tmp/x.txt","content":"ok\\n"}' };
const STORED_DISPATCH = {
  type: 'tool_use', id: 'toolu_2', name: 'Agent',
  inputPreview: '{"description":"Reply done","prompt":"reply with the single word done","subagent_type":"general-purpose"}',
};

describe('ToolCard', () => {
  it('summarises a live call by the field that says what it does', () => {
    render(<ToolCard block={{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }} />);
    expect(screen.getByText('npm test')).toBeTruthy();
    expect(screen.getByText('input')).toBeTruthy();
  });

  it('summarises a stored call the same way, instead of printing its JSON', () => {
    render(<ToolCard block={STORED_WRITE} />);
    expect(screen.getByText('/tmp/x.txt')).toBeTruthy();
    expect(screen.getByText('stored input (redacted)')).toBeTruthy();
    expect(screen.queryByText(STORED_WRITE.inputPreview)).toBeNull();
  });

  it('falls back to the raw preview when the cap truncated it mid-object, and says so', () => {
    render(<ToolCard block={{ type: 'tool_use', id: 't1', name: 'Write', inputPreview: '{"content":"a very long' }} />);
    expect(screen.getByText('stored input (redacted, truncated)')).toBeTruthy();
    expect(screen.getAllByText('{"content":"a very long').length).toBeGreaterThan(0);
  });

  it('shows the tool use id, so a card can be matched to a hook payload', () => {
    render(<ToolCard block={STORED_WRITE} />);
    expect(screen.getByText('toolu_1')).toBeTruthy();
  });
});

describe('DispatchChip', () => {
  const run = { id: 's1:toolu_2', agentType: 'reviewer', description: 'review the diff', status: 'running', startedAt: 1000, durationMs: null };

  it('reads the live rail row when there is one', () => {
    render(<DispatchChip block={{ ...STORED_DISPATCH, input: { subagent_type: 'ignored' } }} run={run} now={3000} />);
    expect(screen.getByText('reviewer')).toBeTruthy();
    expect(screen.getByText('review the diff')).toBeTruthy();
    expect(screen.getByText('2s')).toBeTruthy();
  });

  it('names the subagent from a stored dispatch rather than dumping its JSON', () => {
    render(<DispatchChip block={STORED_DISPATCH} run={undefined} now={3000} />);
    expect(screen.getByText('general-purpose')).toBeTruthy();
    expect(screen.getByText('Reply done')).toBeTruthy();
    expect(screen.queryByText(STORED_DISPATCH.inputPreview)).toBeNull();
  });

  it('says a dispatch is not yet in the rail rather than inventing a status', () => {
    render(<DispatchChip block={STORED_DISPATCH} run={undefined} now={3000} />);
    expect(screen.getByText(/not yet reported by the live agents panel/)).toBeTruthy();
  });
});

describe('SessionFooter', () => {
  it('shows only what the session actually reported', () => {
    const { container } = render(<SessionFooter state={{ ...initialChatState, sessionId: 's1', result: { totalCostUsd: 0.34 } }} />);
    expect(screen.getByText('$0.34')).toBeTruthy();
    expect(screen.getByText('s1')).toBeTruthy();
    // A restored session knows neither of these, and a row of dashes reads as a broken footer.
    expect(container.textContent).not.toMatch(/model/);
    expect(container.textContent).not.toMatch(/turns/);
  });

  it('sums the usage buckets into one honest token figure', () => {
    render(<SessionFooter state={{
      ...initialChatState,
      result: { usage: { input_tokens: 2, cache_creation_input_tokens: 34_908, cache_read_input_tokens: 0, output_tokens: 11 } },
    }} />);
    expect(screen.getByText('34,921 tok')).toBeTruthy();
  });

  it('states that the last turn failed, now that the transcript no longer repeats its text', () => {
    render(<SessionFooter state={{ ...initialChatState, sessionId: 's1', result: { totalCostUsd: 0.34, isError: true } }} />);
    expect(screen.getByText('failed')).toBeTruthy();
  });

  it('says there is no session rather than printing an empty list', () => {
    render(<SessionFooter state={initialChatState} />);
    expect(screen.getByText(/no session yet/i)).toBeTruthy();
  });
});

describe('PermissionModal', () => {
  const request = (over = {}) => ({
    id: 'p1', projectPath: '/p', toolName: 'Write', input: { file_path: '/tmp/x', content: 'hello\n' },
    toolUseId: 'toolu_1', agentId: null, reason: null, title: null, description: null,
    ts: 1000, expiresAt: 1000 + 120_000, restored: false, ...over,
  });

  it('opens with focus on Deny, never on an allow button', () => {
    render(<PermissionModal request={request()} queued={1} now={1000} onDecide={vi.fn()} selectedProject="/p" />);
    expect(document.activeElement.textContent).toBe('Deny');
  });

  it('shows the raw input in full, exactly as the tool received it', () => {
    render(<PermissionModal request={request()} queued={1} now={1000} onDecide={vi.fn()} selectedProject="/p" />);
    const raw = screen.getByText(/"file_path": "\/tmp\/x"/);
    expect(raw.textContent).toMatch(/"content": "hello/);
  });

  it('counts down to the auto-deny deadline', () => {
    render(<PermissionModal request={request()} queued={1} now={1000} onDecide={vi.fn()} selectedProject="/p" />);
    expect(screen.getByText('auto-denies in 2:00')).toBeTruthy();
  });

  it('says the deadline passed rather than showing a negative clock', () => {
    render(<PermissionModal request={request()} queued={1} now={999_999} onDecide={vi.fn()} selectedProject="/p" />);
    expect(screen.getByText('deadline passed — denying')).toBeTruthy();
  });

  it('escape denies, because there is no dismissing a blocked tool call', () => {
    const onDecide = vi.fn().mockResolvedValue(undefined);
    render(<PermissionModal request={request()} queued={1} now={1000} onDecide={onDecide} selectedProject="/p" />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onDecide).toHaveBeenCalledWith('p1', 'deny');
  });

  it('refuses to present a restored request as an approvable one', () => {
    render(<PermissionModal request={request({ restored: true, input: null })} queued={1} now={1000} onDecide={vi.fn()} selectedProject="/p" />);
    expect(screen.getByRole('alert').textContent).toMatch(/not available after a page reload/);
    expect(screen.queryByText(/full input, exactly as the tool received it/)).toBeNull();
  });

  it('names the other project when the prompt belongs to one the user is not looking at', () => {
    render(<PermissionModal request={request({ projectPath: '/other' })} queued={2} now={1000} onDecide={vi.fn()} selectedProject="/p" />);
    expect(screen.getByText('/other')).toBeTruthy();
    expect(screen.getByText('2 waiting')).toBeTruthy();
  });

  it('says the request was already settled when the daemon answers 404', async () => {
    const onDecide = vi.fn().mockRejectedValue(Object.assign(new Error('unknown_request'), { status: 404 }));
    render(<PermissionModal request={request()} queued={1} now={1000} onDecide={onDecide} selectedProject="/p" />);
    fireEvent.click(screen.getByText('Allow once'));
    const failure = await screen.findByText(/already settled/);
    expect(failure.textContent).toMatch(/did not run/);
  });

  it('keeps the request waiting when the decision could not be sent at all', async () => {
    const onDecide = vi.fn().mockRejectedValue(new Error('stream_disconnected'));
    render(<PermissionModal request={request()} queued={1} now={1000} onDecide={onDecide} selectedProject="/p" />);
    fireEvent.click(screen.getByText('Deny'));
    expect((await screen.findByText(/Could not send the decision/)).textContent).toMatch(/still waiting/);
  });

  it('states that "always" is scoped to the conversation', () => {
    render(<PermissionModal request={request()} queued={1} now={1000} onDecide={vi.fn()} selectedProject="/p" />);
    expect(screen.getByText('Always allow Write')).toBeTruthy();
    expect(screen.getByText(/never written to your settings files/)).toBeTruthy();
  });
});

describe('Composer', () => {
  const props = (over = {}) => ({
    busy: false, disabledReason: null, onSend: vi.fn().mockResolvedValue(undefined),
    onInterrupt: vi.fn().mockResolvedValue(undefined), onReset: vi.fn().mockResolvedValue(undefined), ...over,
  });

  it('sends on Enter and clears the draft', async () => {
    const p = props();
    render(<Composer {...p} />);
    const box = screen.getByLabelText('Message to the orchestrator');
    fireEvent.change(box, { target: { value: 'run the tests' } });
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }); });
    expect(p.onSend).toHaveBeenCalledWith('run the tests');
    expect(box.value).toBe('');
  });

  it('keeps the draft when the send fails', async () => {
    const p = props({ onSend: vi.fn().mockRejectedValue(new Error('nope')) });
    render(<Composer {...p} />);
    const box = screen.getByLabelText('Message to the orchestrator');
    fireEvent.change(box, { target: { value: 'precious' } });
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }); });
    expect(p.onSend).toHaveBeenCalledWith('precious');
    await waitFor(() => expect(box.value).toBe('precious'));
  });

  it('leaves Shift+Enter and an IME composition alone', () => {
    const p = props();
    render(<Composer {...p} />);
    const box = screen.getByLabelText('Message to the orchestrator');
    fireEvent.change(box, { target: { value: 'line one' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    expect(p.onSend).not.toHaveBeenCalled();
  });

  it('offers Interrupt instead of Send while a turn is running', () => {
    render(<Composer {...props({ busy: true })} />);
    expect(screen.getByText('Interrupt')).toBeTruthy();
    expect(screen.queryByText('Send')).toBeNull();
    expect(screen.getByLabelText('Message to the orchestrator').disabled).toBe(true);
  });

  it('says why the composer is closed when no project is chosen', () => {
    render(<Composer {...props({ disabledReason: 'Choose a project in the sidebar before sending a message.' })} />);
    expect(screen.getByPlaceholderText(/Choose a project/)).toBeTruthy();
  });

  it('asks before a reset, and says what a reset costs', async () => {
    const p = props();
    render(<Composer {...p} />);
    fireEvent.click(screen.getByText('New session'));
    expect(screen.getByRole('alert').textContent).toMatch(/discards the conversation and its history/);
    fireEvent.click(screen.getByText('Keep it'));
    expect(p.onReset).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('New session'));
    await act(async () => { fireEvent.click(screen.getByText('Discard and start over')); });
    expect(p.onReset).toHaveBeenCalled();
  });
});

describe('ProjectSwitcher', () => {
  const projects = [{ path: '/a', name: 'a', addedAt: 1, lastUsedAt: 2 }];

  it('shows the full path of the selected project, not just its folder name', () => {
    render(<ProjectSwitcher projects={projects} selected="/a" onSelect={vi.fn()} onAdd={vi.fn()} error={null} />);
    expect(screen.getByTitle('/a')).toBeTruthy();
  });

  const reject = (error, body) => vi.fn().mockRejectedValue(Object.assign(new Error(error), { status: 400, body }));

  const openForm = (onAdd) => {
    render(<ProjectSwitcher projects={projects} selected="/a" onSelect={vi.fn()} onAdd={onAdd} error={null} />);
    fireEvent.click(screen.getByText('Add project'));
    return screen.getByLabelText('Absolute path');
  };

  const submit = async (value) => {
    fireEvent.change(screen.getByLabelText('Absolute path'), { target: { value } });
    await act(async () => { fireEvent.click(screen.getByText('Add')); });
  };

  it('offers the absolute form of a path typed without its leading slash', async () => {
    const onAdd = reject('not_absolute', { suggestion: '/Users/me/code' });
    openForm(onAdd);
    await submit('Users/me/code');

    expect(screen.getByRole('alert').textContent).toMatch(/relative path/);
    await act(async () => { fireEvent.click(screen.getByText('Use /Users/me/code')); });
    expect(onAdd).toHaveBeenLastCalledWith('/Users/me/code', { create: false });
  });

  // The dead end this replaced: "that is not a directory on this machine", with nothing to do next.
  it('offers to create a folder that does not exist yet, naming the exact path', async () => {
    const onAdd = reject('missing', { path: '/Users/me/new-thing' });
    openForm(onAdd);
    await submit('/Users/me/new-thing');

    expect(screen.getByRole('alert').textContent).toMatch(/Nothing exists at \/Users\/me\/new-thing yet/);
    await act(async () => { fireEvent.click(screen.getByText('Create this folder and add it')); });
    // Creating is always the second, explicit request — the first submit asked for no such thing.
    expect(onAdd).toHaveBeenNthCalledWith(1, '/Users/me/new-thing', { create: false });
    expect(onAdd).toHaveBeenNthCalledWith(2, '/Users/me/new-thing', { create: true });
  });

  it('offers nothing for a path that can never be a folder', async () => {
    openForm(reject('not_a_directory', { path: '/Users/me/notes.txt' }));
    await submit('/Users/me/notes.txt');

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/cannot be a folder/);
    expect(alert.querySelector('button')).toBeNull();
  });

  it('reports a refused mkdir with the reason the filesystem gave', async () => {
    openForm(reject('create_failed', { path: '/locked/child', detail: 'EACCES' }));
    await submit('/locked/child');
    expect(screen.getByRole('alert').textContent).toMatch(/could not be created \(EACCES\)/);
  });

  it('falls back to the raw error for something it has no sentence for', async () => {
    openForm(reject('request_failed_500', {}));
    await submit('/Users/me/x');
    expect(screen.getByRole('alert').textContent).toMatch(/request_failed_500/);
  });

  it('clears a stale rejection as soon as the path is edited', async () => {
    openForm(reject('missing', { path: '/Users/me/new-thing' }));
    await submit('/Users/me/new-thing');
    expect(screen.getByRole('alert')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Absolute path'), { target: { value: '/Users/me/other' } });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('offers to add the first project when there are none', () => {
    render(<ProjectSwitcher projects={[]} selected={null} onSelect={vi.fn()} onAdd={vi.fn()} error={null} />);
    expect(screen.getByText(/No project yet/)).toBeTruthy();
    expect(screen.queryByLabelText('Selected project')).toBeNull();
  });
});

describe('Chat page', () => {
  const session = (over = {}) => ({
    chat: initialChatState, selected: '/p', busy: false, historyError: null,
    permissionNotice: null, dismissPermissionNotice: vi.fn(),
    send: vi.fn(), interrupt: vi.fn(), reset: vi.fn(), ...over,
  });

  it('tells the user what a message will actually do before there is one', () => {
    render(<Chat session={session()} runs={[]} now={0} />);
    expect(screen.getByText(/with your own agents, skills and CLAUDE.md loaded/)).toBeTruthy();
    expect(screen.getByText('/p')).toBeTruthy();
  });

  it('asks for a project first when none is chosen', () => {
    render(<Chat session={session({ selected: null })} runs={[]} now={0} />);
    expect(screen.getByText(/Pick a project in the sidebar/)).toBeTruthy();
    expect(screen.getByPlaceholderText(/Choose a project/)).toBeTruthy();
  });

  it('renders the transcript, and the streaming buffer where assistive tech will not read it twice', () => {
    const chat = applyChatEvent(
      appendUserMessage(initialChatState, 'hello', 1000),
      'chat.delta', { messageId: 'm1', text: 'partial' },
    );
    render(<Chat session={session({ chat })} runs={[]} now={0} />);
    expect(screen.getByText('hello')).toBeTruthy();
    const streaming = screen.getByText('partial');
    expect(streaming.closest('[aria-hidden="true"]')).toBeTruthy();
  });

  it('says what the session is doing while a turn runs', () => {
    const chat = applyChatEvent(initialChatState, 'chat.status', {
      state: 'activity', kind: 'task_started', data: { subagentType: 'reviewer', description: 'review the diff' },
    });
    render(<Chat session={session({ chat, busy: true })} runs={[]} now={0} />);
    expect(screen.getByText(/dispatching reviewer — review the diff/)).toBeTruthy();
  });

  it('falls back to plain "working" for an activity kind it does not know', () => {
    const chat = applyChatEvent(initialChatState, 'chat.status', { state: 'activity', kind: 'something_new', data: {} });
    render(<Chat session={session({ chat, busy: true })} runs={[]} now={0} />);
    expect(screen.getByText('working')).toBeTruthy();
  });

  it('warns that history is missing rather than presenting a partial transcript as the whole one', () => {
    render(<Chat session={session({ historyError: 'request_failed_500' })} runs={[]} now={0} />);
    expect(screen.getByRole('status').textContent).toMatch(/request_failed_500/);
  });

  it('links a dispatched subagent to the live rail row instead of drawing it twice', () => {
    let chat = applyChatEvent(initialChatState, 'chat.message', {
      messageId: 'm1', blocks: [{ type: 'tool_use', id: 'toolu_9', name: 'Agent', input: { description: 'review', subagent_type: 'reviewer' } }],
    });
    chat = applyChatEvent(chat, 'chat.tool_use', { toolUseId: 'toolu_9', name: 'Agent', input: {}, agentDispatch: true });
    const runs = [{ id: 'sess-abc:toolu_9', agentType: 'reviewer', description: 'review the diff', status: 'running', startedAt: 0, durationMs: null }];
    render(<Chat session={session({ chat })} runs={runs} now={4000} />);
    expect(screen.getByText('dispatched')).toBeTruthy();
    expect(screen.getByText('review the diff')).toBeTruthy();
    expect(screen.getByText('4s')).toBeTruthy();
  });

  it('surfaces a warning that never reached the approval gate', () => {
    const chat = applyChatEvent(initialChatState, 'chat.status', {
      state: 'warning', kind: 'permission_denied', data: { toolName: 'Write' },
    });
    render(<Chat session={session({ chat })} runs={[]} now={0} />);
    expect(screen.getByText(/denied by Claude Code's own permission rules/)).toBeTruthy();
  });

  it('marks a fatal error as the end of the session and says the next send restarts it', () => {
    const chat = applyChatEvent(initialChatState, 'chat.error', {
      message: 'The previous conversation could not be resumed.', detail: 'Error: boom', fatal: true,
    });
    render(<Chat session={session({ chat })} runs={[]} now={0} />);
    expect(screen.getByRole('alert').textContent).toMatch(/Sending again starts a new one/);
    expect(screen.getByText('Error: boom')).toBeTruthy();
  });

  it('offers to dismiss a settled-prompt notice', () => {
    const dismiss = vi.fn();
    render(<Chat session={session({ permissionNotice: 'That approval request had already been settled', dismissPermissionNotice: dismiss })} runs={[]} now={0} />);
    fireEvent.click(screen.getByText('Dismiss'));
    expect(dismiss).toHaveBeenCalled();
  });
});
