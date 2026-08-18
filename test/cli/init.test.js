// test/cli/init.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeHooks, hookEntries, isOurs } from '../../src/cli/hook-config.js';

const DIR = '/opt/agentpanel/hooks';
const foreign = {
  PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/other/tool.sh' }] }],
};

test('registers all five events', () => {
  const h = hookEntries(DIR);
  assert.deepEqual(Object.keys(h).sort(),
    ['PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'SubagentStop']);
});

test('dispatch events match both tool names via the exact-string list matcher', () => {
  const h = hookEntries(DIR);
  assert.equal(h.PreToolUse[0].matcher, 'Agent|Task');
  assert.equal(h.PostToolUse[0].matcher, 'Agent|Task');
});

test('every handler is async and short-timeout, and SessionEnd fits its 1.5s budget', () => {
  const h = hookEntries(DIR);
  const all = Object.values(h).flatMap((g) => g.flatMap((m) => m.hooks));
  assert.ok(all.every((x) => x.async === true), 'async keeps sessions unblocked');
  assert.ok(all.every((x) => x.timeout <= 5 && x.timeout >= 2));
  assert.equal(h.SessionEnd[0].hooks[0].timeout, 2);
});

test('merge preserves foreign hooks on the same event', () => {
  const { hooks } = mergeHooks(foreign, DIR);
  const commands = hooks.PreToolUse.flatMap((m) => m.hooks.map((h) => h.command));
  assert.ok(commands.some((c) => c.includes('/other/tool.sh')), 'foreign handler survived');
  assert.ok(commands.some((c) => c.includes('agentpanel-hook.sh')), 'ours was added');
});

test('merge is idempotent — running init twice yields one copy', () => {
  const once = mergeHooks(foreign, DIR).hooks;
  const twice = mergeHooks(once, DIR).hooks;
  const mine = twice.PreToolUse.flatMap((m) => m.hooks).filter(isOurs);
  assert.equal(mine.length, 1);
  assert.deepEqual(once, twice);
});

test('re-running after a path change replaces the stale entry rather than stacking', () => {
  const old = mergeHooks({}, '/old/path/hooks').hooks;
  const fresh = mergeHooks(old, DIR).hooks;
  const commands = fresh.SubagentStop.flatMap((m) => m.hooks.map((h) => h.command));
  assert.equal(commands.length, 1);
  assert.ok(commands[0].includes(DIR));
});

test('merge reports what it added and removed', () => {
  const result = mergeHooks({}, DIR);
  assert.equal(result.added.length, 5);
  assert.equal(result.removed.length, 0);
  assert.equal(mergeHooks(result.hooks, DIR).removed.length, 5);
});

test('an event group left with no handlers is deleted, not left empty', () => {
  const ours = mergeHooks({}, DIR).hooks;
  const { hooks } = mergeHooks(ours, DIR, { remove: true });
  assert.equal(hooks.SubagentStop, undefined);
});

test('a foreign entry that is not a recognised group survives untouched', () => {
  const bare = { SubagentStop: [{ type: 'command', command: '/foreign/script.sh' }] };
  const { hooks } = mergeHooks(bare, DIR);
  assert.ok(JSON.stringify(hooks.SubagentStop).includes('/foreign/script.sh'));
});

test('a malformed entry does not throw', () => {
  assert.doesNotThrow(() => mergeHooks({ SubagentStop: [null] }, DIR));
  assert.doesNotThrow(() => mergeHooks({ SubagentStop: [{ hooks: { not: 'an array' } }] }, DIR));
});

test('isOurs recognises our scripts and nothing else', () => {
  assert.equal(isOurs({ command: '"/x/hooks/agentpanel-hook.sh"' }), true);
  assert.equal(isOurs({ command: '/x/hooks/agentpanel-bootstrap.sh' }), true);
  assert.equal(isOurs({ command: '/x/other.sh' }), false);
  assert.equal(isOurs({}), false);
});
