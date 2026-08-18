import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Layout } from './components/Layout.jsx';
import { LiveRail } from './components/LiveRail.jsx';
import { connectStream, fetchJson } from './api.js';
import './styles.css';

function App() {
  const [runs, setRuns] = useState([]);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchJson('/api/runs').then((d) => setRuns([...d.active, ...d.recent])).catch((e) => setError(e.message));
    return connectStream({
      onEvent: (_name, run) => setRuns((prev) => {
        if (!run?.id) return prev;
        const rest = prev.filter((r) => r.id !== run.id);
        return [run, ...rest];
      }),
      onError: () => setError('stream_disconnected'),
    });
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (error === 'unauthorized') {
    return <p className="fatal">Session expired — reopen the URL printed by <code>agentpanel open</code>.</p>;
  }

  return <Layout rail={<LiveRail runs={runs} now={now} />} />;
}

createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
