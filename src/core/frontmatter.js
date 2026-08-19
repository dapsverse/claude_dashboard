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

// Collects the lines that belong to a block scalar started right after `lines[start - 1]`.
// A block scalar in this frontmatter is always a top-level value, so its content is any blank
// line or any line indented past column 0; the block ends at the first non-blank line back at
// column 0 (the next key), or at the end of the frontmatter block.
function readBlockLines(lines, start) {
  const raw = [];
  let i = start;
  let blockIndent = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') { raw.push(''); continue; }
    const indent = line.length - line.trimStart().length;
    if (indent === 0) break;
    if (blockIndent === null) blockIndent = indent;
    raw.push(indent >= blockIndent ? line.slice(blockIndent) : line.trimStart());
  }
  return { raw, next: i };
}

// Applies a chomping indicator to a value built without a trailing newline. `-` (strip) drops
// any trailing blank lines entirely, `+` (keep) restores every one of them as newlines, and the
// default (clip) keeps at most a single trailing newline.
function chompValue(value, trailingBlanks, indicator) {
  if (indicator === '-') return value;
  if (indicator === '+') return value + '\n'.repeat(trailingBlanks);
  return trailingBlanks > 0 ? `${value}\n` : value;
}

function splitTrailingBlanks(raw) {
  const lines = raw.slice();
  let trailingBlanks = 0;
  while (lines.length && lines[lines.length - 1] === '') { lines.pop(); trailingBlanks++; }
  return { lines, trailingBlanks };
}

// Folded (`>`) block scalar: lines join into one string with single spaces, and a blank line
// becomes a paragraph break.
function foldedValue(raw, indicator) {
  const { lines, trailingBlanks } = splitTrailingBlanks(raw);
  const paragraphs = [];
  let current = [];
  for (const line of lines) {
    if (line === '') { paragraphs.push(current.join(' ')); current = []; }
    else current.push(line.trim());
  }
  paragraphs.push(current.join(' '));
  return chompValue(paragraphs.join('\n\n'), trailingBlanks, indicator);
}

// Literal (`|`) block scalar: lines keep their newlines as-is.
function literalValue(raw, indicator) {
  const { lines, trailingBlanks } = splitTrailingBlanks(raw);
  return chompValue(lines.join('\n'), trailingBlanks, indicator);
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

  const lines = block.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#/.test(line) || line.trim() === '') continue;

    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) { data[listKey].push(unquote(item[1].trim())); continue; }

    const pair = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (!pair) continue;

    const [, key, rest] = pair;
    const trimmedRest = rest.trim();

    const scalar = /^([>|])([+-]?)$/.exec(trimmedRest);
    if (scalar) {
      const [, style, indicator] = scalar;
      try {
        const { raw, next } = readBlockLines(lines, i + 1);
        data[key] = style === '>' ? foldedValue(raw, indicator) : literalValue(raw, indicator);
        i = next - 1;
      } catch { data[key] = ''; }
      listKey = null;
      continue;
    }

    if (trimmedRest === '') { data[key] = []; listKey = key; }
    else { data[key] = coerce(rest); listKey = null; }
  }

  for (const [k, v] of Object.entries(data)) if (Array.isArray(v) && v.length === 0) delete data[k];
  return { data, body };
}
