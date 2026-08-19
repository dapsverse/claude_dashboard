import { useEffect, useRef, useState } from 'react';
import { Layout } from './components/Layout.jsx';
import { LiveRail } from './components/LiveRail.jsx';
import { Agents } from './pages/Agents.jsx';
import { Skills } from './pages/Skills.jsx';
import { Activity } from './pages/Activity.jsx';
import { useRoute } from './router.jsx';
import { connectStream, fetchJson } from './api.js';
import { upsertRun, mergeSnapshot } from './components/runList.js';

export function App() {
  const [runs, setRuns] = useState([]);
  const [now, setNow] = useState(Date.now());
  const [connectionError, setConnectionError] = useState(null);
  const [catalog, setCatalog] = useState({ agents: [], skills: [] });
  const [catalogError, setCatalogError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [hooksInstalled, setHooksInstalled] = useState(true);
  const { path } = useRoute();
  const streamed = useRef(new Set());

  useEffect(() => {
    const stop = connectStream({
      onEvent: (name, payload) => {
        // A delivered event is proof the stream came back: EventSource reconnects on its own, and
        // leaving the notice up after that would be its own kind of lie.
        setConnectionError(null);
        if (name === 'catalog.changed') {
          setReloadKey((k) => k + 1);
          return;
        }
        if (!payload?.id) return;
        streamed.current.add(payload.id);
        setRuns((prev) => upsertRun(prev, payload));
      },
      onError: () => setConnectionError('stream_disconnected'),
    });

    // The stream opens immediately, but the initial snapshot goes through the daemon and a disk
    // read first. If an event for a run arrives before the snapshot resolves, the snapshot must not
    // clobber it — mergeSnapshot only fills in what the stream has not already reported.
    fetchJson('/api/runs')
      .then((d) => {
        setRuns((prev) => mergeSnapshot(prev, streamed.current, [...d.active, ...d.recent]));
        setConnectionError(null);
      })
      .catch((e) => setConnectionError(e.message));

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
    // Re-checked on the same signal as the catalog (mount, plus every `catalog.changed` broadcast) so
    // a mid-session `agentpanel init` clears the degraded message without a full page reload.
    fetchJson('/api/health').then((h) => setHooksInstalled(h?.hooksInstalled !== false)).catch(() => {});
  }, [reloadKey]);

  const page = path === '/agents' ? <Agents agents={catalog.agents} catalogError={catalogError} />
    : path === '/skills' ? <Skills skills={catalog.skills} catalogError={catalogError} />
    : path === '/activity' ? <Activity runs={runs.filter((r) => r.status !== 'running')} hooksInstalled={hooksInstalled} />
    : <p className="empty">Orchestrator chat arrives in Plan 2. Live agent activity is on the right.</p>;

  return (
    <Layout rail={<LiveRail runs={runs} now={now} />}>
      {/* Never replaces the page: a dropped stream leaves the last known rows on screen, and blanking
          them would destroy the only state the user still has. The clock keeps ticking on those rows,
          so saying the connection is gone is the difference between stale data and a lie. */}
      {connectionError && (
        <p className="notice" role="status">
          {connectionError === 'unauthorized'
            ? <>Session expired — reopen the URL printed by <code>agentpanel open</code>.</>
            : <>Lost the connection to the agentpanel daemon ({connectionError}). Live updates are
              paused and anything below may be out of date. Check <code>agentpanel status</code>; if
              the daemon was restarted, reopen the URL printed by <code>agentpanel open</code>.</>}
        </p>
      )}
      {page}
    </Layout>
  );
}
