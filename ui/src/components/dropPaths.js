// Reading a file drop as text. The composer sends a message, not an upload: what Claude needs is
// where the file is, because it already has Read and Glob and both work on the machine the daemon
// runs on.
//
// Pure, and deliberately narrow about what counts as a path. A drag carries several
// representations of the same thing — a uri-list, plain text, and the file objects themselves — and
// only the first two ever reveal a location. Finder hands over bytes and a name and nothing else,
// so that case reports the name rather than inventing a path for it.

const FILE_URL = /^file:\/\/(?:localhost)?(\/.*)$/i;

// `/` for an absolute path, `~/` for one relative to home: both are unambiguous, and anything else
// dragged as text is prose. A bare `foo/bar` is not accepted — it would name a file relative to a
// directory nobody stated.
const PATH_TEXT = /^(?:\/|~\/)[^\n\r]*$/;

function decode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

const lines = (value) => (typeof value === 'string' ? value.split(/\r?\n/) : [])
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('#'));

/**
 * The paths a drop revealed, and the names of files whose location the browser withheld.
 *
 * @param {{uriList?: string, plain?: string, fileNames?: string[]}} transfer
 */
export function droppedPaths({ uriList = '', plain = '', fileNames = [] } = {}) {
  const paths = [];
  const add = (path) => { if (path && !paths.includes(path)) paths.push(path); };

  for (const line of lines(uriList)) {
    const match = FILE_URL.exec(line);
    if (match) add(decode(match[1]));
  }
  for (const line of lines(plain)) {
    const match = FILE_URL.exec(line);
    if (match) { add(decode(match[1])); continue; }
    if (PATH_TEXT.test(line)) add(line);
  }

  // A name already accounted for by a path is not unresolved: the same file appears in both halves
  // of every Finder drag that does expose a location.
  const located = new Set(paths.map((path) => path.slice(path.lastIndexOf('/') + 1)));
  const unresolved = (Array.isArray(fileNames) ? fileNames : [])
    .filter((name) => typeof name === 'string' && name !== '' && !located.has(name));

  return { paths, unresolved };
}

/**
 * The draft with `paths` written in at the caret. Backticked, so the transcript renders them as code
 * and a path containing spaces stays one token to the eye.
 */
export function insertPaths(text, caret, paths) {
  const at = Math.max(0, Math.min(caret ?? text.length, text.length));
  const before = text.slice(0, at);
  const after = text.slice(at);
  const body = paths.map((path) => `\`${path}\``).join(' ');
  const lead = before === '' || before.endsWith(' ') || before.endsWith('\n') ? '' : ' ';
  const tail = after.startsWith(' ') || after.startsWith('\n') ? '' : ' ';
  const inserted = `${lead}${body}${tail}`;
  return { text: `${before}${inserted}${after}`, caret: before.length + inserted.length };
}
