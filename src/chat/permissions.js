// src/chat/permissions.js
//
// The approval gate between an SDK session and the tools it wants to run. This is a security
// boundary, and it fails closed in every direction: an unanswered request denies, an aborted
// session denies, a shutdown denies, an unrecognised decision is refused. The one thing this module
// must never do is return `null` — the SDK reads that as "the host answered out of band" and parks
// the tool call forever with no deadline.
import { randomUUID } from 'node:crypto';

// Read-only tools, auto-allowed so the dashboard is usable at all: without this every question about
// a codebase becomes a dozen approval prompts, and a user who is clicking through prompts to get
// work done is not reading them. Deliberately three, deliberately named — nothing that writes,
// executes, or reaches the network is on this list, and `canUseTool` is only consulted for calls the
// user's own settings did not already decide.
export const AUTO_ALLOW_TOOLS = ['Read', 'Glob', 'Grep'];

export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

const DENY_TIMEOUT = 'No answer in the agentpanel dashboard within the approval window, so the request timed out and the tool was not run. Ask again if you still need it.';
const DENY_ABORTED = 'The session was interrupted before this permission request was answered, so the tool was not run.';
const DENY_CLOSED = 'agentpanel stopped while this permission request was open, so the tool was not run.';
const DENY_USER = 'The user denied this tool call in the agentpanel dashboard.';
const DENY_QUESTION = 'The user dismissed this question in the agentpanel dashboard without answering it. Do not re-ask it unless they raise the subject again.';

const DECISIONS = new Set(['allow', 'deny', 'always']);

// AskUserQuestion is not a tool that *does* something the user approves; it is a question, and the
// CLI hands it to `canUseTool` precisely because the host is its renderer. Its own
// `checkPermissions` returns `behavior: 'ask'` unconditionally and its result block reads "The user
// did not answer the questions." unless the allow carries the answers back in `updatedInput`. A
// dashboard that treats it as a generic prompt shows an Allow button, answers nothing, and leaves
// the model reporting that nobody replied.
export const QUESTION_TOOL = 'AskUserQuestion';

// The tool's own schema caps questions at 4 and options at 4. Enforced here too: these strings are
// rendered in a browser and echoed back into a tool result, and neither should be unbounded because
// a model emitted something malformed.
const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 8;
const MAX_ANSWER_CHARS = 2000;
const MAX_NOTES_CHARS = 2000;

const str = (value, max) => (typeof value === 'string' && value.trim() !== '' ? value.slice(0, max) : null);

// Returns the questions in the shape the browser renders, or null when the input is not something
// that can be rendered as a question at all — in which case the request degrades to an ordinary
// approval prompt rather than to a modal with nothing in it.
export function normalizeQuestions(input) {
  const raw = input?.questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const questions = [];
  for (const entry of raw.slice(0, MAX_QUESTIONS)) {
    const question = str(entry?.question, 2000);
    if (question === null) continue;
    const options = (Array.isArray(entry?.options) ? entry.options : [])
      .slice(0, MAX_OPTIONS)
      .map((option) => ({
        label: str(option?.label, 500),
        description: str(option?.description, 2000),
        preview: str(option?.preview, 8000),
      }))
      .filter((option) => option.label !== null);
    if (options.length === 0) continue;         // nothing to click: not renderable as a question
    questions.push({
      question,
      header: str(entry?.header, 60),
      options,
      multiSelect: entry?.multiSelect === true,
    });
  }
  return questions.length === 0 ? null : questions;
}

// The answers that go back to the tool, rebuilt from the questions we actually asked rather than
// trusted as sent. A key the model never asked about, or a value that is not a string, is dropped:
// the tool result is text the model will act on, and the browser does not get to put arbitrary keys
// in it. Multi-select arrives as an array and is joined with ", ", which is the format the tool's
// own output contract documents.
function sanitizeAnswers(questions, raw) {
  if (raw === null || typeof raw !== 'object') return {};
  const asked = new Map(questions.map((q) => [q.question, q]));
  const answers = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!asked.has(key)) continue;
    const text = Array.isArray(value)
      ? value.filter((v) => typeof v === 'string').join(', ')
      : typeof value === 'string' ? value : '';
    const trimmed = text.trim();
    if (trimmed === '') continue;
    answers[key] = trimmed.slice(0, MAX_ANSWER_CHARS);
  }
  return answers;
}

// `annotations.preview` is derived from the question, never taken from the request body: it is the
// preview text of the option the user picked, and the browser echoing its own string back would let
// a tool result claim the user was shown something they were not. Notes are the user's own words and
// are the one part that does come from the client.
function buildAnnotations(questions, answers, notes) {
  const source = notes === null || typeof notes !== 'object' ? {} : notes;
  const annotations = {};
  for (const question of questions) {
    const answer = answers[question.question];
    const picked = answer === undefined ? undefined : question.options.find((o) => o.label === answer);
    const note = str(source[question.question], MAX_NOTES_CHARS);
    const entry = {
      ...(picked?.preview ? { preview: picked.preview } : {}),
      ...(note === null ? {} : { notes: note.trim() }),
    };
    if (Object.keys(entry).length > 0) annotations[question.question] = entry;
  }
  return Object.keys(annotations).length === 0 ? null : annotations;
}

export function createPermissionGate({
  hub,
  now = Date.now,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  autoAllow = AUTO_ALLOW_TOOLS,
  newId = randomUUID,
}) {
  const autoAllowed = new Set(autoAllow);
  const pending = new Map();

  function settle(id, decision, result) {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener('abort', entry.onAbort);
    hub.broadcast('permission.resolved', { id, projectPath: entry.projectPath, decision, ts: now() });
    entry.resolve(result);
    return true;
  }

  const deny = (message) => ({ behavior: 'deny', message });

  function request(projectPath, toolName, input, options) {
    const { signal, toolUseID, agentID, decisionReason, title, description } = options ?? {};
    // Already aborted before we got here: broadcasting a request the UI could answer would show the
    // user a prompt for a session that is gone.
    if (signal?.aborted) return Promise.resolve(deny(DENY_ABORTED));

    const id = newId();
    const ts = now();
    // A question only renders as a question when its payload actually carries answerable questions.
    // Anything else — a malformed input, a future shape this build does not understand — falls back
    // to the ordinary approval prompt, which is honest about what it can and cannot show.
    const questions = toolName === QUESTION_TOOL ? normalizeQuestions(input) : null;
    const kind = questions === null ? 'tool' : 'question';
    // A question has no deadline. An approval window makes sense for a tool call — an unanswered
    // one denies, which is the safe end of the fail-closed rule — but a question is the model
    // waiting on the user to think, and a clock on that only produces two bad outcomes: an answer
    // rushed to beat it, or an auto-deny that tells the model the user refused to reply. The CLI's
    // own renderer waits indefinitely too. Interrupt, reset and shutdown still settle it, so the
    // tool call cannot outlive the session it belongs to.
    const deadline = kind === 'question' ? null : ts + timeoutMs;
    return new Promise((resolve) => {
      const onAbort = () => settle(id, 'aborted', deny(DENY_ABORTED));
      const timer = deadline === null ? null : setTimeout(() => settle(id, 'timeout', deny(DENY_TIMEOUT)), timeoutMs);
      timer?.unref?.();                         // an open prompt must not hold the process open
      signal?.addEventListener('abort', onAbort, { once: true });

      pending.set(id, {
        id, projectPath, toolName, ts, resolve, timer, signal, onAbort,
        kind, questions, input: input ?? {},
        descriptor: { id, projectPath, toolName, toolUseId: toolUseID ?? null, ts, kind, questions },
      });

      hub.broadcast('permission.request', {
        id,
        projectPath,
        toolName,
        // 'tool' or 'question'. The browser needs to know which of the two screens to draw before
        // it looks at anything else, and it must not infer it from the tool name — a build that
        // renames the tool would then render an unanswerable question as an approval prompt.
        kind,
        questions,
        // The raw input, not a redacted preview: approving a command you cannot read is not
        // approval. This crosses an authenticated loopback channel only, and what lands in the
        // database is redacted separately.
        input: input ?? {},
        toolUseId: toolUseID ?? null,
        agentId: agentID ?? null,
        reason: decisionReason ?? null,
        title: title ?? null,
        description: description ?? null,
        expiresAt: deadline,
        ts,
      });
    });
  }

  return {
    // One `canUseTool` per project, so a request can never be attributed to — or answered from —
    // another project's session.
    forProject(projectPath) {
      return async (toolName, input, options) => {
        if (autoAllowed.has(toolName)) return { behavior: 'allow' };
        return request(projectPath, toolName, input, options);
      };
    },

    resolve(id, decision, answer) {
      if (!DECISIONS.has(decision)) return { ok: false, reason: 'bad_decision' };
      if (!pending.has(id)) return { ok: false, reason: 'unknown_request' };
      const entry = pending.get(id);
      const { toolName } = entry;

      if (entry.kind === 'question') {
        // "Always allow" is meaningless for a question and actively harmful: a session rule would
        // let every later question through this gate unanswered, and each one would come back to the
        // model as "the user did not answer" with no prompt ever shown.
        if (decision === 'always') return { ok: false, reason: 'bad_decision' };
        if (decision === 'deny') {
          settle(id, 'deny', deny(DENY_QUESTION));
          return { ok: true };
        }
        const answers = sanitizeAnswers(entry.questions, answer?.answers);
        const annotations = buildAnnotations(entry.questions, answers, answer?.notes);
        // `questions` has to be carried through untouched: the tool reads it back out of its own
        // input to build the result, and dropping it turns the answer into a crash on the CLI side.
        settle(id, 'allow', {
          behavior: 'allow',
          updatedInput: {
            ...entry.input,
            answers,
            ...(annotations === null ? {} : { annotations }),
          },
        });
        return { ok: true, answered: Object.keys(answers).length };
      }

      const result = decision === 'deny'
        ? deny(DENY_USER)
        : decision === 'always'
          // Session scope only. The SDK's own `suggestions` may target userSettings or
          // projectSettings, which would write a permanent rule into the user's files from a single
          // click in a browser tab. "Always" here means "for the rest of this conversation".
          ? { behavior: 'allow', updatedPermissions: [{ type: 'addRules', rules: [{ toolName }], behavior: 'allow', destination: 'session' }] }
          : { behavior: 'allow' };
      settle(id, decision, result);
      return { ok: true };
    },

    // Everything still open for one project — used when a session is interrupted or reset, and to
    // let a reconnecting tab re-render the prompts it missed.
    list(projectPath) {
      const all = [...pending.values()];
      const rows = projectPath === undefined ? all : all.filter((e) => e.projectPath === projectPath);
      return rows.map((e) => e.descriptor);
    },

    abortProject(projectPath) {
      for (const entry of [...pending.values()]) {
        if (entry.projectPath === projectPath) settle(entry.id, 'aborted', deny(DENY_ABORTED));
      }
    },

    close() {
      for (const entry of [...pending.values()]) settle(entry.id, 'closed', deny(DENY_CLOSED));
    },
  };
}
