export async function fetchJson(path) {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) throw new Error(`request_failed_${res.status}`);
  return res.json();
}

// Writes report the daemon's own error code (`bad_project`, `unknown_request`, `empty_message`) as
// the thrown message, with the status attached: the caller has to tell "this prompt was already
// resolved" (404) apart from "the daemon is unreachable", and a generic `request_failed_404` cannot.
export async function postJson(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  let payload = null;
  try { payload = await res.json(); } catch { /* an error response may carry no body at all */ }
  if (res.status === 401) throw Object.assign(new Error('unauthorized'), { status: 401 });
  if (!res.ok) {
    throw Object.assign(new Error(payload?.error ?? `request_failed_${res.status}`), { status: res.status, body: payload });
  }
  return payload;
}

const EVENTS = [
  'run.open', 'run.close', 'run.enrich', 'session.end', 'catalog.changed',
  // Chat rides the same stream. EventSource dispatches only to named listeners, so an event the
  // daemon broadcasts under a name absent from this list is silently dropped — adding a server-side
  // event without adding it here is invisible rather than noisy.
  'chat.delta', 'chat.message', 'chat.tool_use', 'chat.result', 'chat.error', 'chat.status',
  'permission.request', 'permission.resolved',
];

export function connectStream({ onEvent, onError, onOpen }) {
  const source = new EventSource('/api/stream');
  for (const name of EVENTS) {
    source.addEventListener(name, (e) => onEvent(name, JSON.parse(e.data)));
  }
  // EventSource reconnects on its own after a transient drop (a laptop waking, a dropped TCP
  // connection) without telling the caller anything went wrong beyond the earlier onerror. Without
  // this, a "connection lost" notice set by onerror is only ever cleared by the next delivered event
  // — which on an idle dashboard may be never.
  source.onopen = () => onOpen?.();
  source.onerror = () => onError?.(new Error('stream_disconnected'));
  return () => source.close();
}
