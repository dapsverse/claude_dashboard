// test/core/frontmatter.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter } from '../../src/core/frontmatter.js';

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
