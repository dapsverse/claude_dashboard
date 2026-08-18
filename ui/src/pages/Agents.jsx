export function Agents({ agents }) {
  if (agents.length === 0) {
    return <p className="empty">No agents found in ~/.claude/agents, this project, or any enabled plugin.</p>;
  }
  return (
    <ul className="cards">
      {agents.map((a) => (
        <li key={`${a.scope}:${a.source ?? ''}:${a.name}`} className="card">
          <h3>{a.name}</h3>
          <p>{a.description}</p>
          <dl>
            <dt>scope</dt><dd><span className={`badge ${a.scope}`}>{a.scope}</span></dd>
            {a.source && <><dt>from</dt><dd>{a.source}</dd></>}
            {a.model && <><dt>model</dt><dd>{a.model}</dd></>}
            {a.tools && <><dt>tools</dt><dd className="mono">{Array.isArray(a.tools) ? a.tools.join(', ') : a.tools}</dd></>}
          </dl>
        </li>
      ))}
    </ul>
  );
}
