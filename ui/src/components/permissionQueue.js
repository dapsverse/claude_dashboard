// The queue of unanswered tool-approval prompts. Pure and framework-free for the same reason as
// `chatState.js`: this is the security surface, and the rules that keep it honest — never lose a
// second request behind the first, never leave a prompt on screen for a request the daemon has
// already settled — are rules about data.
//
// Deliberately *not* scoped to the selected project. A prompt is a tool call blocked on an answer;
// hiding one because the user is looking at another project would strand it until it auto-denies,
// with nothing on screen to explain why. The modal names the project instead.

// Mirrors the daemon's DEFAULT_TIMEOUT_MS. Only ever used for a prompt restored from
// `/api/chat/history`, whose descriptor carries `ts` but no `expiresAt`; a live `permission.request`
// states its own deadline and that always wins.
export const APPROVAL_WINDOW_MS = 5 * 60 * 1000;

export function addRequest(queue, payload) {
  if (!payload?.id) return queue;
  const request = {
    id: payload.id,
    projectPath: payload.projectPath ?? null,
    toolName: payload.toolName ?? null,
    // 'question' draws the answer sheet, anything else the approval prompt. Taken from the payload
    // rather than derived from the tool name so a build that renames AskUserQuestion degrades to a
    // plain prompt instead of to an unanswerable question.
    kind: payload.kind === 'question' ? 'question' : 'tool',
    // Unlike `input`, the questions survive a reload: the history descriptor carries them because
    // they are the model's own text, not a command about to run, so re-rendering them after a
    // refresh is the difference between answering the question and stranding it.
    questions: Array.isArray(payload.questions) ? payload.questions : null,
    input: payload.input ?? null,
    toolUseId: payload.toolUseId ?? null,
    agentId: payload.agentId ?? null,
    reason: payload.reason ?? null,
    title: payload.title ?? null,
    description: payload.description ?? null,
    ts: payload.ts ?? null,
    expiresAt: payload.expiresAt ?? (payload.ts == null ? null : payload.ts + APPROVAL_WINDOW_MS),
    // A restored prompt is missing the one thing that makes approval meaningful. The flag travels
    // with it so the modal can say so rather than presenting an empty input as an innocent one.
    restored: payload.restored === true,
  };
  const existing = queue.findIndex((r) => r.id === request.id);
  if (existing < 0) return [...queue, request];
  // A live event for a prompt we only had a descriptor for: keep the position in the queue, take the
  // fuller payload.
  const next = [...queue];
  next[existing] = {
    ...next[existing],
    ...request,
    // A later payload that carries no questions must not erase the ones already on screen: the
    // history descriptor and the live event arrive in either order, and only one of them is
    // guaranteed to have them.
    questions: request.questions ?? next[existing].questions,
    restored: request.restored && next[existing].restored,
  };
  return next;
}

/**
 * Remove one prompt by id. Used for `permission.resolved` regardless of decision: `allow`, `deny`
 * and `always` are the user's own answers, while `timeout`, `aborted` and `closed` are the daemon
 * settling a prompt nobody answered — every one of them means this prompt is gone, and leaving it
 * up would invite an answer that resolves nothing.
 */
export function removeRequest(queue, id) {
  return queue.some((r) => r.id === id) ? queue.filter((r) => r.id !== id) : queue;
}

/** Descriptors from `GET /api/chat/history`, merged in without dropping anything already queued. */
export function restoreRequests(queue, descriptors) {
  let next = queue;
  for (const descriptor of Array.isArray(descriptors) ? descriptors : []) {
    next = addRequest(next, { ...descriptor, restored: true });
  }
  return next;
}
