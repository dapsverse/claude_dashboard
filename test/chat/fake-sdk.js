// test/chat/fake-sdk.js
//
// A stand-in for @anthropic-ai/claude-agent-sdk's `query()`. The default suite must run offline with
// no token spend, so every session test drives this instead of the real SDK. It implements only the
// surface src/chat/session.js uses: an async-iterable of messages out, an AsyncIterable of
// SDKUserMessage in, and interrupt/close.

export function createChannel() {
  const queued = [];
  const waiters = [];
  let ended = false;

  return {
    push(value) {
      const waiter = waiters.shift();
      if (waiter) waiter({ value, done: false });
      else queued.push(value);
    },
    end() {
      ended = true;
      for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
    },
    fail(err) {
      this.error = err;
      this.end();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queued.length) { yield queued.shift(); continue; }
        if (ended) {
          if (this.error) throw this.error;
          return;
        }
        const next = await new Promise((resolve) => waiters.push(resolve));
        if (next.done) {
          if (this.error) throw this.error;
          return;
        }
        yield next.value;
      }
    },
  };
}

export function createFakeSdk() {
  const calls = [];

  return {
    calls,
    last() { return calls.at(-1); },
    forCwd(cwd) { return calls.filter((c) => c.options.cwd === cwd); },
    query({ prompt, options }) {
      const outbox = createChannel();
      const call = {
        options, outbox, inputs: [], interrupts: 0, closed: false, inputEnded: false,
        // Wait until `count` user messages have arrived, so a test never races the input pump.
        async waitForInput(count = 1) {
          for (let i = 0; i < 200 && call.inputs.length < count; i += 1) {
            await new Promise((r) => setTimeout(r, 1));
          }
          return call.inputs;
        },
      };
      calls.push(call);

      (async () => {
        for await (const message of prompt) call.inputs.push(message);
        call.inputEnded = true;
      })();

      return {
        [Symbol.asyncIterator]() { return outbox[Symbol.asyncIterator](); },
        async interrupt() { call.interrupts += 1; },
        close() { call.closed = true; outbox.end(); },
      };
    },
  };
}

export const initMessage = (sessionId = 'sess-1', over = {}) => ({
  type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-opus-5',
  cwd: '/p', tools: ['Read', 'Bash'], agents: ['reviewer'], permissionMode: 'default', ...over,
});

export const assistantText = (text, over = {}) => ({
  type: 'assistant', uuid: 'u-1', session_id: 'sess-1', parent_tool_use_id: null,
  message: { id: 'msg_1', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text }] },
  ...over,
});

export const resultMessage = (over = {}) => ({
  type: 'result', subtype: 'success', session_id: 'sess-1', is_error: false,
  duration_ms: 1234, duration_api_ms: 1000, num_turns: 2, result: 'all done',
  total_cost_usd: 0.0421, usage: { input_tokens: 10, output_tokens: 20 }, ...over,
});
