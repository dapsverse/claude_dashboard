import { describe, it, expect } from 'vitest';
import { droppedPaths, insertPaths } from '../src/components/dropPaths.js';

describe('droppedPaths', () => {
  it('reads a file URL out of a uri-list drag', () => {
    const out = droppedPaths({ uriList: 'file:///Users/daps/Documents/schema.sql' });
    expect(out).toEqual({ paths: ['/Users/daps/Documents/schema.sql'], unresolved: [] });
  });

  it('decodes percent-escapes and the empty localhost host', () => {
    const out = droppedPaths({ uriList: 'file://localhost/Users/daps/my%20notes.md' });
    expect(out.paths).toEqual(['/Users/daps/my notes.md']);
  });

  it('skips uri-list comments and blank lines', () => {
    const out = droppedPaths({ uriList: '# comment\n\nfile:///a.txt\r\nfile:///b.txt' });
    expect(out.paths).toEqual(['/a.txt', '/b.txt']);
  });

  it('takes an absolute path dragged as plain text', () => {
    expect(droppedPaths({ plain: '/Users/daps/Documents/agentpanel/src/store/runs.js' }).paths)
      .toEqual(['/Users/daps/Documents/agentpanel/src/store/runs.js']);
    expect(droppedPaths({ plain: '~/notes/todo.md' }).paths).toEqual(['~/notes/todo.md']);
  });

  it('refuses plain text that is prose rather than a path', () => {
    expect(droppedPaths({ plain: 'have a look at the schema' })).toEqual({ paths: [], unresolved: [] });
  });

  it('prefers the uri-list and never lists the same path twice', () => {
    const out = droppedPaths({ uriList: 'file:///a.txt', plain: '/a.txt' });
    expect(out.paths).toEqual(['/a.txt']);
  });

  // Finder hands the browser bytes and a name, never a location. Reporting the name is honest;
  // inventing a path would be worse than saying nothing.
  it('reports a file whose location the browser withheld', () => {
    const out = droppedPaths({ fileNames: ['screenshot.png'] });
    expect(out).toEqual({ paths: [], unresolved: ['screenshot.png'] });
  });

  it('does not report a file that the uri-list already located', () => {
    const out = droppedPaths({ uriList: 'file:///Users/daps/screenshot.png', fileNames: ['screenshot.png'] });
    expect(out).toEqual({ paths: ['/Users/daps/screenshot.png'], unresolved: [] });
  });

  it('is empty for a drag that carries nothing usable', () => {
    expect(droppedPaths({})).toEqual({ paths: [], unresolved: [] });
    expect(droppedPaths({ uriList: 'https://example.com/x.png' })).toEqual({ paths: [], unresolved: [] });
  });
});

describe('insertPaths', () => {
  it('inserts at the caret, backticked, with a trailing space', () => {
    const out = insertPaths('review this: ', 13, ['/a/b.sql']);
    expect(out.text).toBe('review this: `/a/b.sql` ');
    expect(out.caret).toBe(out.text.length);
  });

  it('separates several paths and keeps the rest of the draft', () => {
    const out = insertPaths('lihat  dulu', 6, ['/a.txt', '/b.txt']);
    expect(out.text).toBe('lihat `/a.txt` `/b.txt` dulu');
  });

  it('does not double a space that is already there', () => {
    const out = insertPaths('x ', 2, ['/a.txt']);
    expect(out.text).toBe('x `/a.txt` ');
  });

  it('spaces the insertion off from a word it lands against', () => {
    const out = insertPaths('lihat', 5, ['/a.txt']);
    expect(out.text).toBe('lihat `/a.txt` ');
  });
});
