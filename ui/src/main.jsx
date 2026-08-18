import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Layout } from './components/Layout.jsx';
import { LiveRail } from './components/LiveRail.jsx';
import { Agents } from './pages/Agents.jsx';
import { Skills } from './pages/Skills.jsx';
import { Activity } from './pages/Activity.jsx';
import { useRoute } from './router.jsx';
import { connectStream, fetchJson } from './api.js';
import './styles.css';

function App() {
  const [runs, setRuns] = useState([]);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState(null);
  const [catalog, setCatalog] = useState({ agents: [], skills: [] });
  const [catalogError, setCatalogError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [hooksInstalled, setHooksInstalled] = useState(true);
  const { path } = useRoute();
  const streamed = useRef(new Set());

  useEffect(() => {
    const stop = connectStream({
      onEvent: (name, payload) => {
        if (name === 'catalog.changed') {
          setReloadKey((k) => k + 1);
          return;
        }
        if (!payload?.id) return;
        streamed.current.add(payload.id);
        setRuns((prev) => [payload, ...prev.filter((r) => r.id !== payload.id)]);
      },
      onError: () => setError('stream_disconnected'),
    });

    // The stream opens immediately, but the initial snapshot goes through the daemon and a disk
    // read first. If an event for a run arrives before the snapshot resolves, the snapshot must not
    // clobber it — only fill in runs the stream has not already reported.
    fetchJson('/api/runs')
      .then((d) => setRuns((prev) => {
        const fromStream = prev.filter((r) => streamed.current.has(r.id));
        const known = new Set(fromStream.map((r) => r.id));
        return [...fromStream, ...[...d.active, ...d.recent].filter((r) => !known.has(r.id))];
      }))
      .catch((e) => setError(e.message));

    return stop;
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    fetchJson('/api/catalog')
      .then((d) => { setCatalog(d); setCatalogError(null); })
      .catch((e) => setCatalogError(e.message));
  }, [reloadKey]);

  useEffect(() => {
    // `/api/health` is public, and the field may be absent against an older daemon. Only an explicit
    // `false` means "hooks are not installed"; anything else leaves the normal empty state in place.
    fetchJson('/api/health').then((h) => setHooksInstalled(h?.hooksInstalled !== false)).catch(() => {});
  }, []);

  if (error === 'unauthorized') {
    return <p className="fatal">Session expired — reopen the URL printed by <code>agentpanel open</code>.</p>;
  }

  const page = path === '/agents' ? <Agents agents={catalog.agents} catalogError={catalogError} />
    : path === '/skills' ? <Skills skills={catalog.skills} catalogError={catalogError} />
    : path === '/activity' ? <Activity runs={runs.filter((r) => r.status !== 'running')} hooksInstalled={hooksInstalled} />
    : <p className="empty">Orchestrator chat arrives in Plan 2. Live agent activity is on the right.</p>;

  return <Layout rail={<LiveRail runs={runs} now={now} />}>{page}</Layout>;
}

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
