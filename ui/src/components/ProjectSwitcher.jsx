import { useState } from 'react';

// Every chat call is keyed by project path, so this control decides what the whole page is about.
// It is a `<select>` rather than a list of links because the set is small, unbounded in principle,
// and native keyboard behaviour here is better than anything worth reimplementing.
export function ProjectSwitcher({ projects, selected, onSelect, onAdd, error }) {
  const [adding, setAdding] = useState(false);
  const [path, setPath] = useState('');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState(null);

  async function submit(e) {
    e.preventDefault();
    const value = path.trim();
    if (value === '' || pending) return;
    setPending(true);
    setFailure(null);
    try {
      await onAdd(value);
      setPath('');
      setAdding(false);
    } catch (err) {
      setFailure(err?.message === 'bad_project'
        ? 'That is not a directory on this machine. Give an absolute path to an existing folder.'
        : `Could not add the project (${err?.message ?? 'unknown error'}).`);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="projects">
      <h2>Project</h2>
      {error && <p className="notice">Could not load the project list ({error}).</p>}

      {projects.length === 0
        ? <p className="empty">No project yet. Add the folder you want the orchestrator to work in.</p>
        : (
          <>
            <label className="sr-only" htmlFor="project-select">Selected project</label>
            <select id="project-select" value={selected ?? ''} onChange={(e) => onSelect(e.target.value)}>
              {/* Only until the stored selection has been read back; a `<select>` with a value that
                  matches no option would otherwise render blank and read as an empty combobox. */}
              {selected === null && <option value="">Choose a project…</option>}
              {projects.map((p) => <option key={p.path} value={p.path}>{p.name || p.path}</option>)}
            </select>
            {selected && <p className="project-path mono" title={selected}>{selected}</p>}
          </>
        )}

      {adding
        ? (
          <form className="project-add" onSubmit={submit}>
            <label htmlFor="project-path">Absolute path</label>
            <input
              id="project-path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/Users/you/code/thing"
              autoComplete="off"
              spellCheck="false"
            />
            {failure && <p className="notice" role="alert">{failure}</p>}
            <div className="project-add-actions">
              <button type="submit" className="btn primary" disabled={pending || path.trim() === ''}>
                {pending ? 'Adding…' : 'Add'}
              </button>
              <button type="button" className="btn" onClick={() => { setAdding(false); setFailure(null); }}>Cancel</button>
            </div>
          </form>
        )
        : <button type="button" className="btn subtle" onClick={() => setAdding(true)}>Add project</button>}
    </div>
  );
}
