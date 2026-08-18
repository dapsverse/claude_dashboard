// src/core/frontmatter.js
function coerce(raw) {
  const v = raw.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v) && !/^0\d/.test(v)) return Number(v);
  if (/^\[.*\]$/.test(v)) {
    return v.slice(1, -1).split(',').map((s) => unquote(s.trim())).filter((s) => s.length > 0);
  }
  return unquote(v);
}

function unquote(v) {
  if ((v.startsWith('"') && v.endsWith('"') && v.length > 1)
   || (v.startsWith("'") && v.endsWith("'") && v.length > 1)) return v.slice(1, -1);
  return v;
}

export function parseFrontmatter(text) {
  // Normalise line endings first. A file authored on Windows arrives with `\r\n`, and every line would
  // then end in a `\r` that the key regex cannot match — the parser would return an empty object and
  // silently lose the whole header rather than failing loudly.
  const src = String(text ?? '').replace(/\r\n/g, '\n');
  if (!src.startsWith('---')) return { data: {}, body: src };

  const end = src.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: src };

  const block = src.slice(src.indexOf('\n') + 1, end);
  const body = src.slice(src.indexOf('\n', end + 1) + 1);
  const data = {};
  let listKey = null;

  for (const line of block.split('\n')) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;

    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) { data[listKey].push(unquote(item[1].trim())); continue; }

    const pair = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (!pair) continue;

    const [, key, rest] = pair;
    if (rest.trim() === '') { data[key] = []; listKey = key; }
    else { data[key] = coerce(rest); listKey = null; }
  }

  for (const [k, v] of Object.entries(data)) if (Array.isArray(v) && v.length === 0) delete data[k];
  return { data, body };
}
