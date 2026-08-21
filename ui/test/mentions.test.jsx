import { describe, it, expect } from 'vitest';
import { mentionAt, mentionCandidates, applyMention } from '../src/components/mentions.js';

const catalog = {
  agents: [
    { name: 'reviewer', description: 'Reviews a diff', scope: 'user' },
    { name: 'programmer', description: 'Implements changes', scope: 'user' },
    { name: 'cavecrew-reviewer', description: 'Caveman diff review', scope: 'plugin', source: 'caveman' },
  ],
  skills: [
    { name: 'brainstorming', description: 'Explores intent', scope: 'plugin', source: 'superpowers' },
    { name: 'dashboard', description: 'Open the dashboard', scope: 'user' },
  ],
};

describe('mentionAt', () => {
  it('finds the token being typed at the caret', () => {
    expect(mentionAt('pakai @rev', 10)).toEqual({ start: 6, term: 'rev' });
  });

  it('fires on a bare @ so the whole catalog can be browsed', () => {
    expect(mentionAt('@', 1)).toEqual({ start: 0, term: '' });
  });

  // An email address or a decorator is not a mention, and popping a list open over one would hijack
  // Enter from someone who is only typing prose.
  it('ignores an @ that is glued to the preceding word', () => {
    expect(mentionAt('mail me at daps@example', 23)).toBe(null);
  });

  it('ends the mention at whitespace', () => {
    expect(mentionAt('@reviewer please look', 21)).toBe(null);
  });

  it('reads the token at the caret, not the last one in the line', () => {
    expect(mentionAt('@reviewer and @prog', 19)).toEqual({ start: 14, term: 'prog' });
    expect(mentionAt('@reviewer and @prog', 9)).toEqual({ start: 0, term: 'reviewer' });
  });

  it('accepts the namespaced form', () => {
    expect(mentionAt('@caveman:cave', 13)).toEqual({ start: 0, term: 'caveman:cave' });
  });

  it('refuses a term that cannot be a name', () => {
    expect(mentionAt('@rev iewer', 10)).toBe(null);
    expect(mentionAt('cost @ 5', 8)).toBe(null);
  });
});

describe('mentionCandidates', () => {
  it('ranks a prefix match above a substring match', () => {
    const hits = mentionCandidates(catalog, 'rev');
    expect(hits.map((h) => h.name)).toEqual(['reviewer', 'cavecrew-reviewer']);
  });

  it('labels which catalog each hit came from', () => {
    const [hit] = mentionCandidates(catalog, 'brainstorm');
    expect(hit.kind).toBe('skill');
    expect(hit.description).toBe('Explores intent');
  });

  // Plugin agents and skills are addressed as plugin:name — inserting the bare name would name
  // something the orchestrator cannot resolve.
  it('inserts a plugin entry under its namespaced token', () => {
    expect(mentionCandidates(catalog, 'cavecrew')[0].token).toBe('caveman:cavecrew-reviewer');
    expect(mentionCandidates(catalog, 'dashboard')[0].token).toBe('dashboard');
  });

  it('returns both kinds for an empty term, agents first', () => {
    const hits = mentionCandidates(catalog, '');
    expect(hits.length).toBe(5);
    expect(hits[0].kind).toBe('agent');
  });

  it('is case-insensitive and caps the list', () => {
    expect(mentionCandidates(catalog, 'REV').map((h) => h.name)).toEqual(['reviewer', 'cavecrew-reviewer']);
    expect(mentionCandidates(catalog, '', 2)).toHaveLength(2);
  });

  it('matches the namespace as well as the name', () => {
    expect(mentionCandidates(catalog, 'superpowers:brain')[0].name).toBe('brainstorming');
  });

  it('reports nothing rather than everything when nothing matches', () => {
    expect(mentionCandidates(catalog, 'zzz')).toEqual([]);
  });
});

describe('applyMention', () => {
  it('replaces the typed token and leaves the caret past a trailing space', () => {
    const out = applyMention('pakai @rev buat ini', { start: 6, term: 'rev' }, { token: 'reviewer' });
    expect(out.text).toBe('pakai @reviewer buat ini');
    expect(out.caret).toBe('pakai @reviewer '.length);
  });

  it('does not double the space when one already follows', () => {
    const out = applyMention('@rev ', { start: 0, term: 'rev' }, { token: 'reviewer' });
    expect(out.text).toBe('@reviewer ');
    expect(out.caret).toBe('@reviewer '.length);
  });

  it('appends at the end of the draft', () => {
    const out = applyMention('lihat @caveman:cave', { start: 6, term: 'caveman:cave' }, { token: 'caveman:cavecrew-reviewer' });
    expect(out.text).toBe('lihat @caveman:cavecrew-reviewer ');
  });
});
