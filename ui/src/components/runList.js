// Pure, framework-free helpers for reconciling the live rail's run list against the SSE stream and
// the initial REST snapshot (`GET /api/runs`). Kept dependency-free from React and from the app
// shell so the subtle merge/race logic can be exercised directly in a unit test, independent of
// rendering.
//
// The stream opens before the snapshot request resolves (it goes through the daemon and a disk
// read), so an event for a run can arrive first. When the snapshot then lands, it must not
// overwrite what the stream already reported — the snapshot is a picture of an earlier moment.

// A run id is `${sessionId}:${toolUseId}` — the correlator builds it that way so a dispatch can be
// matched from either end. The session's own progress events are keyed by the tool_use id alone, so
// splitting it back out here is what lets a rail row show what its subagent is doing. Split on the
// first colon: a session id is a uuid and never contains one, while nothing guarantees that of a
// tool_use id.
export function runToolUseId(run) {
  const id = typeof run?.id === 'string' ? run.id : '';
  const at = id.indexOf(':');
  return at < 0 ? '' : id.slice(at + 1);
}

/** Insert or replace `run` by id, keeping at most one row per id. */
export function upsertRun(runs, run) {
  if (!run?.id) return runs;
  return [run, ...runs.filter((r) => r.id !== run.id)];
}

// `GET /api/runs` returns `{ active, recent }`, and `listRecent` does not filter by status — a
// running run sits in both arrays with the same id, so naively concatenating them renders every
// running agent twice. Dedupe the snapshot itself before merging, rather than relying on the API
// to change shape.
function dedupeById(list) {
  const seen = new Set();
  const out = [];
  for (const run of list) {
    if (!run?.id || seen.has(run.id)) continue;
    seen.add(run.id);
    out.push(run);
  }
  return out;
}

/**
 * Merge a REST snapshot into the current run list without letting it clobber anything the stream
 * has already reported. `streamedIds` is the set of run ids the stream has delivered at least one
 * event for since the component mounted.
 */
export function mergeSnapshot(runs, streamedIds, snapshotRuns) {
  const fromStream = runs.filter((r) => streamedIds.has(r.id));
  const known = new Set(fromStream.map((r) => r.id));
  return [...fromStream, ...dedupeById(snapshotRuns).filter((r) => !known.has(r.id))];
}

/**
 * The rows the rail should draw: this project's, minus anything the user has cleared.
 *
 * Scoped by project because a run is a fact about one working directory, and a rail that mixes them
 * shows agents from a project the user closed hours ago. A run that names no project is kept — its
 * session was never recorded, so it cannot be attributed, and hiding a running agent on a guess is
 * worse than showing an unattributed one.
 */
export function visibleRuns(runs, { projectPath = null, dismissed = null } = {}) {
  return runs.filter((run) => {
    if (dismissed?.has(run.id)) return false;
    if (projectPath === null) return true;             // nothing selected yet: scope to nothing
    return run.projectPath == null || run.projectPath === projectPath;
  });
}

/** The ids of every row that has stopped — what "clear finished" removes, and nothing else. */
export function finishedIds(runs) {
  return runs.filter((run) => run.status !== 'running').map((run) => run.id);
}
