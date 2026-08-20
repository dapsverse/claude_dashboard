import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson, postJson } from './api.js';
import { applyChatEvent, appendUserMessage, fromHistory, initialChatState, isBusy } from './components/chatState.js';
import { addRequest, removeRequest, restoreRequests } from './components/permissionQueue.js';

const STORAGE_KEY = 'agentpanel.project';

const readStored = () => {
  // Read from an effect, never during render, and never without a guard: Safari in private mode
  // throws on `localStorage` access rather than returning null, which would take the whole app down
  // on mount.
  try { return window.localStorage.getItem(STORAGE_KEY); } catch { return null; }
};

const writeStored = (value) => {
  try { window.localStorage.setItem(STORAGE_KEY, value); } catch { /* storage disabled or full */ }
};

/**
 * Everything the chat page needs, kept out of App so the shell stays a shell. Chat events arrive
 * through `handleEvent`, which App calls from the one EventSource it already owns — a second stream
 * would double every run event the live rail renders.
 */
export function useChatSession() {
  const [projects, setProjects] = useState([]);
  const [projectsError, setProjectsError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [chat, setChat] = useState(initialChatState);
  const [permissions, setPermissions] = useState([]);
  const [historyError, setHistoryError] = useState(null);
  const [permissionNotice, setPermissionNotice] = useState(null);
  const [sending, setSending] = useState(false);

  // The event handler is created once and must not go stale, so the two things it reads at event
  // time live in refs rather than in its closure. Re-creating it would tear down and re-open the
  // EventSource on every project switch.
  const selectedRef = useRef(null);
  const loadingRef = useRef(false);
  const bufferRef = useRef([]);

  useEffect(() => { selectedRef.current = selected; }, [selected]);

  const handleEvent = useCallback((name, payload) => {
    if (name === 'permission.request') {
      // Not filtered by project. A prompt is a tool call blocked on an answer; hiding one because
      // the user is looking at a different project would strand it until it auto-denies.
      setPermissions((queue) => addRequest(queue, payload));
      return;
    }
    if (name === 'permission.resolved') {
      setPermissions((queue) => removeRequest(queue, payload.id));
      return;
    }
    if (!name.startsWith('chat.')) return;
    if (payload?.projectPath !== selectedRef.current) return;
    // The history request goes through the daemon and SQLite; an event for this project can land
    // first. Buffering rather than applying keeps it from being overwritten when the restored
    // transcript arrives, and it is replayed on top the moment that happens.
    if (loadingRef.current) { bufferRef.current.push([name, payload]); return; }
    setChat((state) => applyChatEvent(state, name, payload));
  }, []);

  const loadProjects = useCallback(async () => {
    const data = await fetchJson('/api/projects');
    const list = Array.isArray(data.projects) ? data.projects : [];
    setProjects(list);
    setProjectsError(null);
    return list;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const stored = readStored();
    loadProjects()
      .then((list) => {
        if (cancelled) return;
        // The list is ordered by last use, so falling back to the first entry restores the project
        // the user was last in even when nothing was stored.
        const match = list.find((p) => p.path === stored) ?? list[0];
        setSelected(match?.path ?? null);
      })
      .catch((err) => { if (!cancelled) setProjectsError(err.message); });
    return () => { cancelled = true; };
  }, [loadProjects]);

  useEffect(() => {
    if (selected === null) return undefined;
    let cancelled = false;
    loadingRef.current = true;
    bufferRef.current = [];
    setChat(initialChatState);
    setHistoryError(null);

    fetchJson(`/api/chat/history?projectPath=${encodeURIComponent(selected)}`)
      .then((history) => {
        if (cancelled) return;
        const restored = bufferRef.current.reduce(
          (state, [name, payload]) => applyChatEvent(state, name, payload),
          fromHistory(history),
        );
        setChat(restored);
        // A reload in the middle of an approval must not strand the blocked tool: the descriptors
        // come back from the same request, and they go back into the queue.
        setPermissions((queue) => restoreRequests(queue, history.pendingPermissions));
      })
      .catch((err) => { if (!cancelled) setHistoryError(err.message); })
      .finally(() => {
        if (cancelled) return;
        loadingRef.current = false;
        bufferRef.current = [];
      });

    return () => {
      cancelled = true;
      loadingRef.current = false;
      bufferRef.current = [];
    };
  }, [selected]);

  const select = useCallback((path) => {
    setSelected(path);
    writeStored(path);
  }, []);

  const fail = (message, detail) =>
    setChat((state) => applyChatEvent(state, 'chat.error', { message, detail, fatal: false, ts: Date.now() }));

  const send = useCallback(async (text) => {
    const projectPath = selectedRef.current;
    if (projectPath === null) return;
    // The daemon stores the user's message but never broadcasts it back, so the transcript has to
    // show it locally or the user watches their own message vanish.
    setChat((state) => appendUserMessage(state, text, Date.now()));
    setSending(true);
    try {
      await postJson('/api/chat', { projectPath, text });
    } catch (err) {
      fail('Your message could not be sent.', err?.message ?? String(err));
    } finally {
      setSending(false);
    }
  }, []);

  const interrupt = useCallback(async () => {
    const projectPath = selectedRef.current;
    if (projectPath === null) return;
    try { await postJson('/api/chat/interrupt', { projectPath }); }
    catch (err) { fail('The session could not be interrupted.', err?.message ?? String(err)); }
  }, []);

  const reset = useCallback(async () => {
    const projectPath = selectedRef.current;
    if (projectPath === null) return;
    try {
      await postJson('/api/chat/reset', { projectPath });
      // The daemon broadcasts `chat.status: reset` too, and the reducer is idempotent about it.
      // Clearing here as well means a reset still visibly happens when the stream is down.
      setChat((state) => applyChatEvent(state, 'chat.status', { state: 'reset', projectPath, ts: Date.now() }));
    } catch (err) {
      fail('The session could not be reset.', err?.message ?? String(err));
    }
  }, []);

  const decide = useCallback(async (id, decision) => {
    try {
      await postJson(`/api/permissions/${encodeURIComponent(id)}`, { decision });
      setPermissionNotice(null);
    } catch (err) {
      if (err?.status === 404) {
        // The daemon no longer knows this request: it timed out, or an interrupt or shutdown
        // settled it. Every one of those denied the tool. Drop the prompt — it can never be
        // answered — but say why, or the modal would appear to close itself.
        setPermissions((queue) => removeRequest(queue, id));
        setPermissionNotice('That approval request had already been settled — it timed out, or the session was interrupted. The tool did not run.');
        return;
      }
      throw err;
    }
    setPermissions((queue) => removeRequest(queue, id));
  }, []);

  const addProject = useCallback(async (path) => {
    const { project } = await postJson('/api/projects', { path });
    await loadProjects();
    if (project?.path) select(project.path);
  }, [loadProjects, select]);

  return {
    projects, projectsError, selected, select, addProject,
    chat, permissions, historyError, permissionNotice, dismissPermissionNotice: () => setPermissionNotice(null),
    busy: sending || isBusy(chat),
    send, interrupt, reset, decide,
    handleEvent,
  };
}
