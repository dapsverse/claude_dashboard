import { formatElapsed } from '../components/RunRow.jsx';

export function Activity({ runs, hooksInstalled = true }) {
  if (!hooksInstalled) {
    return <p className="empty">Agent tracking is off because the hooks are not installed. Run <code>agentpanel init</code>, then start a new Claude Code session.</p>;
  }
  if (runs.length === 0) {
    return <p className="empty">No agent runs recorded yet. They appear here as soon as any session dispatches a subagent.</p>;
  }
  return (
    <table className="activity">
      <thead><tr><th>agent</th><th>description</th><th>status</th><th>duration</th></tr></thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r.id}>
            <td>{r.agentType ?? 'unknown'}</td>
            <td>{r.description}</td>
            <td><span className={`badge ${r.status}`}>{r.status}</span></td>
            <td>{formatElapsed(r.durationMs ?? 0)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
