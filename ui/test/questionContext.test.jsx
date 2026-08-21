import { describe, it, expect } from 'vitest';
import { questionPreamble } from '../src/components/questionContext.js';

const state = (items, streams = {}) => ({ items, streams });
const msg = (over) => ({ kind: 'message', role: 'assistant', parentToolUseId: null, blocks: [], ...over });
const ask = (id) => ({ type: 'tool_use', id, name: 'AskUserQuestion', input: {} });

describe('questionPreamble', () => {
  it('returns the text Claude wrote before the question in the same message', () => {
    const chat = state([
      msg({ role: 'user', blocks: [{ type: 'text', text: 'ship it' }] }),
      msg({ blocks: [{ type: 'text', text: 'Two ways to do this.' }, ask('t1')] }),
    ]);
    expect(questionPreamble(chat, { toolUseId: 't1' })).toBe('Two ways to do this.');
  });

  it('ignores text that comes after the tool call in that message', () => {
    const chat = state([
      msg({ blocks: [{ type: 'text', text: 'before' }, ask('t1'), { type: 'text', text: 'after' }] }),
    ]);
    expect(questionPreamble(chat, { toolUseId: 't1' })).toBe('before');
  });

  it('falls back to the previous assistant message when the asking one carries no text', () => {
    const chat = state([
      msg({ blocks: [{ type: 'text', text: 'I read the config.' }] }),
      msg({ blocks: [ask('t1')] }),
    ]);
    expect(questionPreamble(chat, { toolUseId: 't1' })).toBe('I read the config.');
  });

  // A preamble from the previous turn is not what Claude said before asking.
  it('never crosses the user message into an earlier turn', () => {
    const chat = state([
      msg({ blocks: [{ type: 'text', text: 'old turn' }] }),
      msg({ role: 'user', blocks: [{ type: 'text', text: 'next question' }] }),
      msg({ blocks: [ask('t1')] }),
    ]);
    expect(questionPreamble(chat, { toolUseId: 't1' })).toBe(null);
  });

  it('uses the live delta buffer while the asking message is still streaming', () => {
    const chat = state([], { main: { messageId: 'm1', text: 'Weighing the two options…' } });
    expect(questionPreamble(chat, { toolUseId: 't1' })).toBe('Weighing the two options…');
  });

  it('prefers the main branch over a subagent buffer', () => {
    const chat = state([], {
      main: { text: 'main thread' },
      sub1: { text: 'subagent chatter' },
    });
    expect(questionPreamble(chat, { toolUseId: 't1' })).toBe('main thread');
  });

  it('leaves an ambiguous set of subagent buffers alone', () => {
    const chat = state([], { a: { text: 'one' }, b: { text: 'two' } });
    expect(questionPreamble(chat, { toolUseId: 't1' })).toBe(null);
  });

  it('keeps the tail when the preamble is long, marked as elided', () => {
    const long = `${'x'.repeat(1400)}the sentence that sets up the question`;
    const chat = state([msg({ blocks: [{ type: 'text', text: long }, ask('t1')] })]);
    const out = questionPreamble(chat, { toolUseId: 't1' });
    expect(out.startsWith('…')).toBe(true);
    expect(out.endsWith('the sentence that sets up the question')).toBe(true);
    expect(out.length).toBe(1201);
  });

  it('reports nothing rather than guessing when there is no transcript', () => {
    expect(questionPreamble(null, { toolUseId: 't1' })).toBe(null);
    expect(questionPreamble(state([]), { toolUseId: null })).toBe(null);
    expect(questionPreamble(state([msg({ blocks: [ask('other')] })]), { toolUseId: 't1' })).toBe(null);
  });

  it('matches the branch when falling back, so a subagent question does not quote the main thread', () => {
    const chat = state([
      msg({ blocks: [{ type: 'text', text: 'main thread talking' }] }),
      msg({ parentToolUseId: 'd1', blocks: [{ type: 'text', text: 'subagent talking' }] }),
      msg({ parentToolUseId: 'd1', blocks: [ask('t1')] }),
    ]);
    expect(questionPreamble(chat, { toolUseId: 't1' })).toBe('subagent talking');
  });
});
