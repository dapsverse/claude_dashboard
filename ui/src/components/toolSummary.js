// One line that says what a tool call will actually do, for the collapsed card and for the approval
// prompt's header. It is a convenience, never a substitute: every place this string appears also
// offers the full raw input, because a summary is by definition lossy and no one should approve a
// command from a summary of it.

const FIELDS = {
  Bash: ['command'],
  BashOutput: ['bash_id'],
  Read: ['file_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  NotebookEdit: ['notebook_path'],
  Glob: ['pattern', 'path'],
  Grep: ['pattern', 'path'],
  WebFetch: ['url'],
  WebSearch: ['query'],
  Task: ['description', 'subagent_type'],
  Agent: ['description', 'subagent_type'],
  Skill: ['command'],
  TodoWrite: [],
};

const MAX = 160;

const clamp = (text) => (text.length > MAX ? `${text.slice(0, MAX - 1)}…` : text);

export function summarizeToolInput(name, input) {
  if (typeof input === 'string') return clamp(input.replace(/\s+/g, ' ').trim());
  if (input === null || typeof input !== 'object') return '';

  const preferred = FIELDS[name];
  if (preferred) {
    const parts = preferred.map((field) => input[field]).filter((v) => typeof v === 'string' && v !== '');
    if (parts.length > 0) return clamp(parts.join(' · ').replace(/\s+/g, ' ').trim());
  }

  // An unknown tool — a plugin's, or one from a newer CLI. The first short string field is a far
  // better guess at its subject than the first key alphabetically.
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && value.trim() !== '') return clamp(`${key}: ${value.replace(/\s+/g, ' ').trim()}`);
  }
  const keys = Object.keys(input);
  return keys.length === 0 ? '' : clamp(keys.join(', '));
}

/** The raw input, pretty-printed, for the block the user is expected to actually read. */
export function formatToolInput(input) {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return input;
  try { return JSON.stringify(input, null, 2); }
  catch { return String(input); }               // circular, or a getter that throws
}

// A tool_use block restored from `/api/chat/history` carries `inputPreview` — the daemon's redacted
// JSON rendering of the input — instead of the input itself. Parsing it back means the transcript can
// summarise a stored call the same way it summarises a live one, rather than printing a JSON blob as
// the summary line. It legitimately fails: the preview is capped at 2000 chars and a longer input is
// truncated mid-object, so a null return is normal and the caller must fall back to the raw string.
export function readStoredInput(inputPreview) {
  if (typeof inputPreview !== 'string') return null;
  const trimmed = inputPreview.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;                                // truncated by the preview cap, or not JSON at all
  }
}
