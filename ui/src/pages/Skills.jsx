import { useState } from 'react';

export function Skills({ skills, initialQuery = '' }) {
  const [query, setQuery] = useState(initialQuery);
  const term = query.trim().toLowerCase();
  const shown = term
    ? skills.filter((s) => `${s.name} ${s.description}`.toLowerCase().includes(term))
    : skills;

  return (
    <div>
      <label className="search">
        <span className="sr-only">Search skills</span>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search skills" />
      </label>
      {shown.length === 0
        ? <p className="empty">No skills match. Skills live in ~/.claude/skills and in enabled plugins.</p>
        : <ul className="cards">
            {shown.map((s) => (
              <li key={`${s.scope}:${s.source ?? ''}:${s.name}`} className="card">
                <h3>{s.name}</h3>
                <p>{s.description}</p>
                <dl>
                  <dt>scope</dt><dd><span className={`badge ${s.scope}`}>{s.scope}</span></dd>
                  {s.source && <><dt>from</dt><dd>{s.source}{s.version ? ` ${s.version}` : ''}</dd></>}
                </dl>
              </li>
            ))}
          </ul>}
    </div>
  );
}
