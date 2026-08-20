import { useState } from 'react';

// What the daemon reports, turned into a sentence and — where there is one — an offer. A rejected
// path used to end at "that is not a directory on this machine", which is true and useless: the two
// mistakes people actually make are a path typed without its leading slash and a folder that does
// not exist yet, and both have an obvious next step.
function explain(err) {
  const code = err?.message;
  const body = err?.body ?? {};
  if (code === 'not_absolute' && body.suggestion) {
    return { text: 'That is a relative path. Paths here start at the root of the disk.', retry: { label: `Use ${body.suggestion}`, path: body.suggestion, create: false } };
  }
  if (code === 'missing' && body.path) {
    return { text: `Nothing exists at ${body.path} yet.`, retry: { label: 'Create this folder and add it', path: body.path, create: true } };
  }
  if (code === 'not_a_directory') {
    // Either the path itself is a file, or a file sits somewhere along it. Both are unfixable by
    // creating anything, so this is the one rejection with nothing to offer.
    return { text: `${body.path ?? 'That path'} cannot be a folder — it is a file, or a file is in the way further up. Pick a folder instead.` };
  }
  if (code === 'create_failed') {
    return { text: `The folder could not be created (${body.detail ?? 'unknown error'}). Check the permissions on the folder above it.` };
  }
  if (code === 'unreadable') {
    return { text: `${body.path ?? 'That path'} exists but cannot be read (${body.detail ?? 'unknown error'}).` };
  }
  if (code === 'bad_project') {
    return { text: 'Give the absolute path of a folder on this machine.' };
  }
  return { text: `Could not add the project (${code ?? 'unknown error'}).` };
}

// Every chat call is keyed by project path, so this control decides what the whole page is about.
// It is a `<select>` rather than a list of links because the set is small, unbounded in principle,
// and native keyboard behaviour here is better than anything worth reimplementing.
export function ProjectSwitcher({ projects, selected, onSelect, onAdd, error }) {
  const [adding, setAdding] = useState(false);
  const [path, setPath] = useState('');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState(null);

  async function attempt(value, create) {
    if (value === '' || pending) return;
    setPending(true);
    setFailure(null);
    try {
      await onAdd(value, { create });
      setPath('');
      setAdding(false);
    } catch (err) {
      setFailure(explain(err));
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
          <form className="project-add" onSubmit={(e) => { e.preventDefault(); attempt(path.trim(), false); }}>
            <label htmlFor="project-path">Absolute path</label>
            <input
              id="project-path"
              value={path}
              onChange={(e) => { setPath(e.target.value); setFailure(null); }}
              placeholder="/Users/you/code/thing"
              autoComplete="off"
              spellCheck="false"
            />
            {failure && (
              <div className="notice" role="alert">
                <p>{failure.text}</p>
                {/* The retry states the exact path it will use, and creating a folder is always a
                    second explicit click — never something the first submit does on its own. */}
                {failure.retry && (
                  <button
                    type="button"
                    className="btn primary"
                    disabled={pending}
                    onClick={() => { setPath(failure.retry.path); attempt(failure.retry.path, failure.retry.create); }}
                  >
                    {failure.retry.label}
                  </button>
                )}
              </div>
            )}
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
