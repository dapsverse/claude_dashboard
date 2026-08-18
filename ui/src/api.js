export async function fetchJson(path) {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (res.status === 401) throw new Error('unauthorized');
  if (!res.ok) throw new Error(`request_failed_${res.status}`);
  return res.json();
}

const EVENTS = ['run.open', 'run.close', 'run.enrich', 'session.end', 'catalog.changed'];

export function connectStream({ onEvent, onError }) {
  const source = new EventSource('/api/stream');
  for (const name of EVENTS) {
    source.addEventListener(name, (e) => onEvent(name, JSON.parse(e.data)));
  }
  source.onerror = () => onError?.(new Error('stream_disconnected'));
  return () => source.close();
}
