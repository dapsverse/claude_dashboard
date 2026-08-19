// test/core/frontmatter.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from '../../src/core/frontmatter.js';

const AGENT_FIXTURE = fileURLToPath(new URL('../fixtures/agents/business-analyst.md', import.meta.url));

test('parses a typical agent header', () => {
  const { data, body } = parseFrontmatter([
    '---',
    'name: reviewer',
    'description: Reviews a diff and reports defects. Read-only.',
    'tools: Read, Grep, Bash',
    'model: opus',
    '---',
    '',
    'You are a reviewer.',
  ].join('\n'));
  assert.equal(data.name, 'reviewer');
  assert.match(data.description, /^Reviews a diff/);
  assert.equal(data.tools, 'Read, Grep, Bash');
  assert.equal(body.trim(), 'You are a reviewer.');
});

test('parses inline arrays', () => {
  const { data } = parseFrontmatter('---\ntools: [Read, Write, Bash]\n---\n');
  assert.deepEqual(data.tools, ['Read', 'Write', 'Bash']);
});

test('parses block arrays', () => {
  const { data } = parseFrontmatter('---\ntools:\n  - Read\n  - Write\n---\n');
  assert.deepEqual(data.tools, ['Read', 'Write']);
});

test('strips matching quotes and keeps inner colons', () => {
  const { data } = parseFrontmatter('---\ndescription: "Use when: X happens"\n---\n');
  assert.equal(data.description, 'Use when: X happens');
});

test('parses booleans and numbers', () => {
  const { data } = parseFrontmatter('---\nenabled: true\nweight: 3\nname: 007\n---\n');
  assert.equal(data.enabled, true);
  assert.equal(data.weight, 3);
  assert.equal(data.name, '007', 'a quoted-looking id stays a string when it has a leading zero');
});

test('returns an empty object when there is no frontmatter', () => {
  const { data, body } = parseFrontmatter('# Just a heading\n');
  assert.deepEqual(data, {});
  assert.equal(body, '# Just a heading\n');
});

test('tolerates an unterminated block instead of throwing', () => {
  const { data } = parseFrontmatter('---\nname: broken\nno end marker');
  assert.deepEqual(data, {});
});

test('ignores comment lines and blank lines', () => {
  const { data } = parseFrontmatter('---\n# a comment\n\nname: x\n---\n');
  assert.deepEqual(data, { name: 'x' });
});

test('parses a header written with Windows line endings', () => {
  const { data, body } = parseFrontmatter('---\r\nname: reviewer\r\ntools: [Read, Grep]\r\n---\r\nbody here');
  assert.equal(data.name, 'reviewer');
  assert.deepEqual(data.tools, ['Read', 'Grep']);
  assert.equal(body.trim(), 'body here');
});

test('parses a folded block scalar (>) into one space-joined string', () => {
  const { data } = parseFrontmatter([
    '---',
    'description: >',
    '  Turns a fuzzy product idea into concrete requirements: user stories,',
    '  acceptance criteria, scope boundaries, and open questions.',
    '---',
  ].join('\n'));
  assert.equal(
    data.description,
    'Turns a fuzzy product idea into concrete requirements: user stories, acceptance criteria, scope boundaries, and open questions.',
  );
});

test('parses a literal block scalar (|) keeping newlines', () => {
  const { data } = parseFrontmatter([
    '---',
    'description: |',
    '  Line one.',
    '  Line two.',
    '---',
  ].join('\n'));
  assert.equal(data.description, 'Line one.\nLine two.');
});

test('a blank line in a folded block becomes a paragraph break', () => {
  const { data } = parseFrontmatter([
    '---',
    'description: >',
    '  First paragraph line a.',
    '  First paragraph line b.',
    '',
    '  Second paragraph.',
    '---',
  ].join('\n'));
  assert.equal(
    data.description,
    'First paragraph line a. First paragraph line b.\n\nSecond paragraph.',
  );
});

test('the strip chomping indicator (>-) drops a trailing blank line', () => {
  const { data } = parseFrontmatter([
    '---',
    'description: >-',
    '  Some text.',
    '',
    'tools: Read',
    '---',
  ].join('\n'));
  assert.equal(data.description, 'Some text.');
  assert.equal(data.tools, 'Read');
});

test('a block scalar as the last key in the frontmatter', () => {
  const { data } = parseFrontmatter([
    '---',
    'name: reviewer',
    'description: >',
    '  A description that is the last key.',
    '---',
  ].join('\n'));
  assert.equal(data.name, 'reviewer');
  assert.equal(data.description, 'A description that is the last key.');
});

test('a block scalar followed by another key', () => {
  const { data } = parseFrontmatter([
    '---',
    'description: >',
    '  Line one.',
    '  Line two.',
    'tools: Read, Write',
    '---',
  ].join('\n'));
  assert.equal(data.description, 'Line one. Line two.');
  assert.equal(data.tools, 'Read, Write');
});

test('an empty block scalar parses to an empty string', () => {
  const { data } = parseFrontmatter([
    '---',
    'name: reviewer',
    'description: >',
    'tools: Read',
    '---',
  ].join('\n'));
  assert.equal(data.description, '');
  assert.equal(data.tools, 'Read');
});

test('reads the description out of a real folded-block agent fixture', () => {
  const { data } = parseFrontmatter(readFileSync(AGENT_FIXTURE, 'utf8'));
  assert.equal(data.name, 'business-analyst');
  assert.notEqual(data.description, '>');
  assert.equal(
    data.description,
    'Turns a fuzzy product idea into concrete requirements: user stories, '
    + 'acceptance criteria, scope boundaries, and open questions that must be '
    + 'answered before building. Use at the start of a feature or product.',
  );
});
