// The `@` autocomplete behind the composer: which token the caret is in, what the catalog offers for
// it, and what the draft looks like once a choice is made.
//
// Pure and framework-free like the other three modules beside it. Every rule here is a rule about
// text — an `@` in an email address is not a mention, the token at the caret is not the last token
// on the line, a plugin's entry is addressed under its namespace — and each one is a bug that would
// otherwise only show up under a real keyboard.

// What a name may contain: letters, digits, `-`, `_`, `.` and the `:` that separates a plugin from
// the agent or skill inside it. A space ends the mention, which is what makes "@rev iewer" prose
// rather than a half-typed mention.
const TERM = /^[\w.:-]*$/;

// An `@` only opens a mention at the start of the draft or after whitespace. Anything else is an
// email address, a decorator, or a price — and popping a list open over one would hijack Enter from
// someone who is only typing.
const OPENS = /[\s(\[{,;]/;

const DEFAULT_LIMIT = 8;

/**
 * The mention token the caret sits in, or null when it is not in one.
 * Returns the offset of the `@` and the text typed after it.
 */
export function mentionAt(text, caret) {
  if (typeof text !== 'string') return null;
  const upto = text.slice(0, Math.max(0, caret));
  const at = upto.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !OPENS.test(upto[at - 1])) return null;
  const term = upto.slice(at + 1);
  return TERM.test(term) ? { start: at, term } : null;
}

// A plugin's agent or skill is addressed as `plugin:name`; inserting the bare name would name
// something the orchestrator cannot resolve.
const tokenOf = (entry) => (entry.source ? `${entry.source}:${entry.name}` : entry.name);

const entryOf = (kind) => (entry) => ({
  kind,
  name: entry.name,
  token: tokenOf(entry),
  description: entry.description ?? '',
  scope: entry.scope ?? null,
  source: entry.source ?? null,
});

/**
 * What the catalog offers for `term`, prefix matches first and agents before skills at equal rank.
 * Matched against the namespaced token as well as the bare name, so "superpowers:brain" finds the
 * skill inside that plugin.
 */
export function mentionCandidates(catalog, term, limit = DEFAULT_LIMIT) {
  const needle = (term ?? '').toLowerCase();
  const all = [
    ...(Array.isArray(catalog?.agents) ? catalog.agents : []).map(entryOf('agent')),
    ...(Array.isArray(catalog?.skills) ? catalog.skills : []).map(entryOf('skill')),
  ];
  if (needle === '') return all.slice(0, limit);

  const ranked = [];
  for (const entry of all) {
    const name = entry.name.toLowerCase();
    const token = entry.token.toLowerCase();
    // 0: the name itself starts with what was typed. 1: the namespaced form does. 2: it appears
    // somewhere inside. Anything else is not a match at all — an unranked list of everything is
    // worse than an empty one, because it invites a Tab that inserts the wrong agent.
    const rank = name.startsWith(needle) ? 0
      : token.startsWith(needle) ? 1
      : token.includes(needle) ? 2
      : -1;
    if (rank >= 0) ranked.push({ rank, entry });
  }
  return ranked
    .sort((a, b) => a.rank - b.rank)             // Array#sort is stable, so equal ranks keep catalog order
    .slice(0, limit)
    .map((hit) => hit.entry);
}

/** The draft with the typed token replaced by the chosen one, and where the caret belongs after. */
export function applyMention(text, mention, candidate) {
  const before = text.slice(0, mention.start);
  const after = text.slice(mention.start + 1 + mention.term.length);
  const inserted = `@${candidate.token}`;
  // One space after the insertion, and only one: a mention is followed by more sentence, and a
  // second space would have to be deleted by hand every time.
  const spaced = after.startsWith(' ') ? after : ` ${after}`;
  return { text: `${before}${inserted}${spaced}`, caret: before.length + inserted.length + 1 };
}
