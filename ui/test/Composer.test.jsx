import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Composer } from '../src/components/Composer.jsx';

const catalog = {
  agents: [
    { name: 'reviewer', description: 'Reviews a diff', scope: 'user' },
    { name: 'programmer', description: 'Implements changes', scope: 'user' },
  ],
  skills: [{ name: 'brainstorming', description: 'Explores intent', scope: 'plugin', source: 'superpowers' }],
};

const draw = (over = {}) => {
  const props = {
    busy: false,
    disabledReason: null,
    onSend: vi.fn(),
    onInterrupt: vi.fn(),
    onReset: vi.fn(),
    catalog,
    ...over,
  };
  render(<Composer {...props} />);
  return { ...props, input: screen.getByLabelText(/message to the orchestrator/i) };
};

// Typing into a textarea does not move the caret in jsdom, so the caret is set explicitly — which is
// also what the component reads at runtime.
const type = (input, value) => {
  // No pre-assignment of input.value: React's change detection compares against the last value it
  // set, and writing it by hand first makes the change event look like a no-op.
  fireEvent.change(input, { target: { value } });
  input.selectionStart = value.length;
  input.selectionEnd = value.length;
  fireEvent.select(input);
};

const drop = (input, { uriList = '', plain = '', files = [] }) => {
  fireEvent.drop(input, {
    dataTransfer: {
      files,
      types: [...(files.length ? ['Files'] : []), ...(uriList ? ['text/uri-list'] : []), ...(plain ? ['text/plain'] : [])],
      getData: (type) => (type === 'text/uri-list' ? uriList : type === 'text/plain' ? plain : ''),
    },
  });
};

describe('Composer file drops', () => {
  it('writes a dropped path into the draft', () => {
    const { input } = draw();
    drop(input, { uriList: 'file:///Users/daps/schema.sql' });
    expect(input.value).toBe('`/Users/daps/schema.sql` ');
  });

  it('keeps what was already typed', () => {
    const { input } = draw();
    type(input, 'review');
    drop(input, { plain: '/a/b.sql' });
    expect(input.value).toBe('review `/a/b.sql` ');
  });

  // The honest failure mode: Finder gives the browser bytes and a name, never a location.
  it('falls back to the file name and says why', () => {
    const { input } = draw();
    drop(input, { files: [{ name: 'screenshot.png' }] });
    expect(input.value).toBe('`screenshot.png` ');
    expect(screen.getByText(/did not reveal where/i)).toBeTruthy();
  });

  it('says nothing and changes nothing for a drag carrying no file', () => {
    const { input } = draw();
    drop(input, { plain: 'just some prose' });
    expect(input.value).toBe('');
    expect(screen.queryByText(/did not reveal where/i)).toBe(null);
  });

  it('refuses a drop while a turn is running', () => {
    const { input } = draw({ busy: true });
    drop(input, { uriList: 'file:///a.sql' });
    expect(input.value).toBe('');
  });
});

describe('Composer mentions', () => {
  it('offers agents and skills for an @ token, badged by kind', () => {
    const { input } = draw();
    type(input, 'pakai @rev');
    expect(screen.getByRole('option', { name: /reviewer/ })).toBeTruthy();
    expect(screen.getByText('agent')).toBeTruthy();
  });

  it('inserts the chosen name on Enter instead of sending', () => {
    const { input, onSend } = draw();
    type(input, 'pakai @rev');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    expect(input.value).toBe('pakai @reviewer ');
  });

  it('inserts on Tab as well', () => {
    const { input } = draw();
    type(input, '@prog');
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(input.value).toBe('@programmer ');
  });

  it('walks the list with the arrow keys', () => {
    const { input } = draw();
    type(input, '@');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('@programmer ');
  });

  it('inserts a plugin skill under its namespace', () => {
    const { input } = draw();
    type(input, '@brainstorm');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('@superpowers:brainstorming ');
  });

  it('closes on Escape and sends on the next Enter', () => {
    const { input, onSend } = draw();
    type(input, 'pakai @rev');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBe(null);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('pakai @rev');
  });

  it('leaves prose alone: no list, and Enter still sends', () => {
    const { input, onSend } = draw();
    type(input, 'mail daps@example.com');
    expect(screen.queryByRole('listbox')).toBe(null);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('mail daps@example.com');
  });

  it('says so rather than offering an empty list when nothing matches', () => {
    const { input, onSend } = draw();
    type(input, '@zzz');
    expect(screen.queryByRole('listbox')).toBe(null);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('@zzz');
  });

  // mousedown, not click: the row accepts on the press, because a click would blur the textarea
  // first and the mention the caret was in would be gone by the time the handler ran.
  it('accepts a press on a row', () => {
    const { input } = draw();
    type(input, '@rev');
    fireEvent.mouseDown(screen.getByRole('option', { name: /reviewer/ }));
    expect(input.value).toBe('@reviewer ');
  });

  it('offers nothing when the catalog is empty', () => {
    const { input } = draw({ catalog: { agents: [], skills: [] } });
    type(input, '@rev');
    expect(screen.queryByRole('listbox')).toBe(null);
  });
});
