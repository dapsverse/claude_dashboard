// test/catalog/catalog.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanAgents, scanSkills, scanCatalog } from '../../src/catalog/index.js';

function fixtureTree() {
  const claudeDir = mkdtempSync(join(tmpdir(), 'ap-cat-'));
  const projectRoot = mkdtempSync(join(tmpdir(), 'ap-proj-'));

  mkdirSync(join(claudeDir, 'agents'), { recursive: true });
  writeFileSync(join(claudeDir, 'agents', 'reviewer.md'),
    '---\nname: reviewer\ndescription: Reviews code.\ntools: Read, Grep\nmodel: opus\n---\nbody');
  writeFileSync(join(claudeDir, 'agents', 'nameless.md'), '---\ndescription: No name key.\n---\nbody');
  writeFileSync(join(claudeDir, 'agents', 'notes.txt'), 'ignored');

  mkdirSync(join(projectRoot, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(projectRoot, '.claude', 'agents', 'local-helper.md'),
    '---\nname: local-helper\ndescription: Project scoped.\n---\nbody');

  mkdirSync(join(claudeDir, 'skills', 'brainstorm'), { recursive: true });
  writeFileSync(join(claudeDir, 'skills', 'brainstorm', 'SKILL.md'),
    '---\nname: brainstorm\ndescription: Turns ideas into designs.\n---\nbody');

  const plug = join(claudeDir, 'plugins', 'cache', 'official', 'superpowers', '6.3.0');
  mkdirSync(join(plug, 'skills', 'tdd'), { recursive: true });
  writeFileSync(join(plug, 'skills', 'tdd', 'SKILL.md'),
    '---\nname: test-driven-development\ndescription: TDD workflow.\n---\nbody');
  mkdirSync(join(plug, 'agents'), { recursive: true });
  writeFileSync(join(plug, 'agents', 'plugin-agent.md'),
    '---\nname: plugin-agent\ndescription: From a plugin.\n---\nbody');

  return { claudeDir, projectRoot };
}

test('finds user, project, and plugin agents with correct scopes', () => {
  const agents = scanAgents(fixtureTree());
  const byName = Object.fromEntries(agents.map((a) => [a.name, a]));
  assert.equal(byName.reviewer.scope, 'user');
  assert.equal(byName['local-helper'].scope, 'project');
  assert.equal(byName['plugin-agent'].scope, 'plugin');
  assert.equal(byName['plugin-agent'].source, 'superpowers');
});

test('agent fields are carried through', () => {
  const a = scanAgents(fixtureTree()).find((x) => x.name === 'reviewer');
  assert.equal(a.description, 'Reviews code.');
  assert.equal(a.tools, 'Read, Grep');
  assert.equal(a.model, 'opus');
  assert.equal(a.kind, 'agent');
});

test('a missing name falls back to the filename stem', () => {
  assert.ok(scanAgents(fixtureTree()).some((a) => a.name === 'nameless'));
});

test('non-markdown files are ignored', () => {
  assert.equal(scanAgents(fixtureTree()).some((a) => a.path.endsWith('.txt')), false);
});

test('finds user and plugin skills, with the plugin version', () => {
  const skills = scanSkills(fixtureTree());
  const byName = Object.fromEntries(skills.map((s) => [s.name, s]));
  assert.equal(byName.brainstorm.scope, 'user');
  assert.equal(byName['test-driven-development'].scope, 'plugin');
  assert.equal(byName['test-driven-development'].source, 'superpowers');
  assert.equal(byName['test-driven-development'].version, '6.3.0');
});

test('missing directories yield empty results rather than throwing', () => {
  const out = scanCatalog({ claudeDir: '/nonexistent', projectRoot: '/also-nonexistent' });
  assert.deepEqual(out.agents, []);
  assert.deepEqual(out.skills, []);
});

test('an unreadable or malformed file is skipped, not fatal', () => {
  const tree = fixtureTree();
  writeFileSync(join(tree.claudeDir, 'agents', 'broken.md'), '---\nthis is not: [valid');
  assert.ok(scanAgents(tree).length >= 3);
});

test('results are sorted by name for a stable UI', () => {
  const names = scanAgents(fixtureTree()).map((a) => a.name);
  assert.deepEqual(names, [...names].sort());
});
