export function Agents({ agents, catalogError }) {
  if (catalogError) {
    return <p className="empty">Could not load the agent catalog ({catalogError}). Check the daemon is running and reload.</p>;
  }
  if (agents.length === 0) {
    return <p className="empty">No agents found in ~/.claude/agents, this project, or any enabled plugin.</p>;
  }
  return (
    <ul className="cards">
      {agents.map((a) => {
        const hasTools = Array.isArray(a.tools) ? a.tools.length > 0 : Boolean(a.tools);
        return (
          <li key={`${a.scope}:${a.source ?? ''}:${a.name}`} className="card">
            <h3>{a.name}</h3>
            <p>{a.description}</p>
            <dl>
              <dt>scope</dt><dd><span className={`badge ${a.scope}`}>{a.scope}</span></dd>
              {a.source && <><dt>from</dt><dd>{a.source}</dd></>}
              {a.model && <><dt>model</dt><dd>{a.model}</dd></>}
              {hasTools && <><dt>tools</dt><dd className="mono">{Array.isArray(a.tools) ? a.tools.join(', ') : a.tools}</dd></>}
            </dl>
          </li>
        );
      })}
    </ul>
  );
}
