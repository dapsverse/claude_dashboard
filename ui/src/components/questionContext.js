// What Claude said in the run-up to a question, recovered from the transcript the browser already
// holds. The daemon's `permission.request` carries the questions and nothing else, and the modal
// covers the page it opens over — so without this the user answers a question with no idea what it
// is about, which is the whole reason a preamble gets written in the first place.
//
// Pure and framework-free like `chatState.js` and `permissionQueue.js`: the rules below — a
// preamble belongs to the message that asked, never to a previous turn; the live delta buffer is
// the same text before the message lands — are rules about data.

// Long enough for a real preamble, short enough that the answer sheet stays the thing on screen.
// The *tail* is kept when it overruns: the sentences nearest the question are the ones that set it
// up.
const MAX_CONTEXT_CHARS = 1200;

const isMessage = (item) => item?.kind === 'message';

const textOf = (blocks) => (Array.isArray(blocks) ? blocks : [])
  .filter((b) => b?.type === 'text' && typeof b.text === 'string')
  .map((b) => b.text)
  .join('\n\n')
  .trim();

function clamp(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;
  return trimmed.length <= MAX_CONTEXT_CHARS
    ? trimmed
    : `…${trimmed.slice(trimmed.length - MAX_CONTEXT_CHARS)}`;
}

// The nearest assistant text before `index` on the same branch. Stops at the user's own message:
// text from the previous turn is not what Claude said before asking, and presenting it as such
// would be a lie the user cannot check while the modal is up.
function textBefore(items, index, parentToolUseId) {
  for (let i = index - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (!isMessage(item)) continue;
    if (item.role === 'user') return null;
    if (item.role !== 'assistant') continue;
    if ((item.parentToolUseId ?? null) !== parentToolUseId) continue;
    const text = textOf(item.blocks);
    if (text !== '') return text;
  }
  return null;
}

// The delta buffer is the same message that is about to arrive, so it is the preamble while the
// tool_use block is still streaming. 'main' wins; a lone subagent branch is used only when it is
// unambiguous, because a request carries no branch of its own to match against.
function streamingText(streams) {
  const buffers = Object.entries(streams ?? {}).filter(([, b]) => typeof b?.text === 'string' && b.text.trim() !== '');
  const main = buffers.find(([branch]) => branch === 'main');
  if (main) return main[1].text;
  return buffers.length === 1 ? buffers[0][1].text : null;
}

/**
 * The text Claude wrote immediately before this request's tool call, or null when the transcript
 * cannot show it — a request for another project, or a reload that restored the prompt but not the
 * message that raised it.
 *
 * `chat` must be the state for `request.projectPath`; the caller checks that, because only it knows
 * which project is selected.
 */
export function questionPreamble(chat, request) {
  const items = Array.isArray(chat?.items) ? chat.items : [];
  const toolUseId = request?.toolUseId ?? null;

  const index = toolUseId === null ? -1 : items.findIndex((item) => isMessage(item)
    && Array.isArray(item.blocks)
    && item.blocks.some((b) => b?.type === 'tool_use' && b.id === toolUseId));

  if (index >= 0) {
    const item = items[index];
    const cut = item.blocks.findIndex((b) => b?.type === 'tool_use' && b.id === toolUseId);
    // Text after the tool_use in the same message is not part of the run-up to it, so only the
    // blocks before the cut count.
    const own = textOf(item.blocks.slice(0, cut));
    if (own !== '') return clamp(own);
    return clamp(textBefore(items, index, item.parentToolUseId ?? null));
  }

  // The message carrying the tool_use has not landed yet: canUseTool can reach the browser before
  // the assistant message that raised it does, and on a reload it may never land at all.
  return clamp(streamingText(chat?.streams) ?? textBefore(items, items.length, null));
}
