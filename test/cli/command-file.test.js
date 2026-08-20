import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  installCommandFile, removeCommandFile, renderCommandFile, commandFilePath,
  dashboardCommand, isOurs, OWNERSHIP_MARKER,
} from '../../src/cli/command-file.js';
import { runInit } from '../../src/cli/init.js';
import { runUninstall } from '../../src/cli/uninstall.js';

const TEMPLATE = fileURLToPath(new URL('../../commands/dashboard.md', import.meta.url));
const HOOKS = fileURLToPath(new URL('../../hooks', import.meta.url));

const fresh = () => mkdtempSync(join(tmpdir(), 'ap-cmd-'));
const args = (claudeDir, entry = '/opt/agentpanel/bin/agentpanel.js') => ({
  claudeDir, templatePath: TEMPLATE, nodeBin: '/usr/bin/node', entry,
});

test('the rendered command quotes the entry path, so a space in it is not two arguments', () => {
  const rendered = renderCommandFile('run: __AGENTPANEL_COMMAND__', {
    nodeBin: '/usr/bin/node', entry: '/Users/me/My Tools/agentpanel/bin/agentpanel.js',
  });
  assert.equal(rendered, 'run: /usr/bin/node "/Users/me/My Tools/agentpanel/bin/agentpanel.js" dashboard');
  assert.equal(dashboardCommand('node', '/a/b.js'), 'node "/a/b.js" dashboard');
});

test('install creates the commands directory and writes an owned file', () => {
  const claudeDir = fresh();
  const result = installCommandFile(args(claudeDir));
  assert.equal(result.status, 'written');
  assert.equal(result.path, join(claudeDir, 'commands', 'dashboard.md'));

  const contents = readFileSync(result.path, 'utf8');
  assert.ok(isOurs(contents));
  assert.match(contents, /\/opt\/agentpanel\/bin\/agentpanel\.js" dashboard/);
  assert.ok(!contents.includes('__AGENTPANEL_COMMAND__'));
});

test('install is idempotent, and rewrites only when the entry path moved', () => {
  const claudeDir = fresh();
  installCommandFile(args(claudeDir));
  assert.equal(installCommandFile(args(claudeDir)).status, 'current');

  const moved = installCommandFile(args(claudeDir, '/usr/local/lib/node_modules/agentpanel/bin/agentpanel.js'));
  assert.equal(moved.status, 'updated');
  assert.match(readFileSync(moved.path, 'utf8'), /usr\/local\/lib\/node_modules/);
});

test('install refuses to overwrite a /dashboard somebody else wrote', () => {
  const claudeDir = fresh();
  mkdirSync(join(claudeDir, 'commands'), { recursive: true });
  const target = commandFilePath(claudeDir);
  writeFileSync(target, '# my own dashboard command\n');

  assert.equal(installCommandFile(args(claudeDir)).status, 'foreign');
  assert.equal(readFileSync(target, 'utf8'), '# my own dashboard command\n');
});

test('remove deletes our file, reports an absent one, and never touches a foreign one', () => {
  const claudeDir = fresh();
  assert.equal(removeCommandFile({ claudeDir }).status, 'absent');

  installCommandFile(args(claudeDir));
  assert.equal(removeCommandFile({ claudeDir }).status, 'removed');
  assert.equal(existsSync(commandFilePath(claudeDir)), false);

  writeFileSync(commandFilePath(claudeDir), '# mine\n');
  assert.equal(removeCommandFile({ claudeDir }).status, 'foreign');
  assert.equal(readFileSync(commandFilePath(claudeDir), 'utf8'), '# mine\n');
});

test('the marker is what makes ownership decidable, not the filename', () => {
  assert.equal(isOurs(`x ${OWNERSHIP_MARKER} 1`), true);
  assert.equal(isOurs('# a command about dashboards'), false);
});

test('init installs the command alongside the hooks and says so', () => {
  const claudeDir = fresh();
  const lines = [];
  const result = runInit({
    settingsPath: join(claudeDir, 'settings.json'), hooksDir: HOOKS,
    ...args(claudeDir), assumeYes: true, log: (l) => lines.push(l),
  });

  assert.equal(result.written, true);
  assert.equal(result.command.status, 'written');
  assert.match(lines.join('\n'), /-> \/dashboard/);
  assert.match(lines.join('\n'), /available in sessions started from now on/);
  assert.ok(existsSync(commandFilePath(claudeDir)));
  assert.ok(existsSync(join(claudeDir, 'settings.json')));
});

test('init still installs the hooks when a foreign /dashboard blocks the command', () => {
  const claudeDir = fresh();
  mkdirSync(join(claudeDir, 'commands'), { recursive: true });
  writeFileSync(commandFilePath(claudeDir), '# mine\n');
  const lines = [];
  const result = runInit({
    settingsPath: join(claudeDir, 'settings.json'), hooksDir: HOOKS,
    ...args(claudeDir), assumeYes: true, log: (l) => lines.push(l),
  });

  assert.equal(result.written, true);
  assert.equal(result.command.status, 'foreign');
  const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
  assert.ok(Object.keys(settings.hooks).length > 0);        // the hooks are the point of init
  assert.match(lines.join('\n'), /was not written by agentpanel/);
  assert.equal(readFileSync(commandFilePath(claudeDir), 'utf8'), '# mine\n');
});

test('init without command arguments installs the hooks and nothing else', () => {
  const claudeDir = fresh();
  const result = runInit({
    settingsPath: join(claudeDir, 'settings.json'), hooksDir: HOOKS,
    assumeYes: true, log: () => {},
  });
  assert.equal(result.written, true);
  assert.equal(result.command, null);
  assert.equal(existsSync(join(claudeDir, 'commands')), false);
});

test('uninstall removes the command file it installed', async () => {
  const claudeDir = fresh();
  runInit({
    settingsPath: join(claudeDir, 'settings.json'), hooksDir: HOOKS,
    ...args(claudeDir), assumeYes: true, log: () => {},
  });

  const lines = [];
  await runUninstall({
    settingsPath: join(claudeDir, 'settings.json'),
    stateDir: join(claudeDir, 'agentpanel'),
    claudeDir,
    log: (l) => lines.push(l),
  });
  assert.equal(existsSync(commandFilePath(claudeDir)), false);
  assert.match(lines.join('\n'), /\(\/dashboard\)/);
});

test('uninstall leaves a foreign /dashboard in place and says it did', async () => {
  const claudeDir = fresh();
  mkdirSync(join(claudeDir, 'commands'), { recursive: true });
  writeFileSync(commandFilePath(claudeDir), '# mine\n');
  const lines = [];
  await runUninstall({
    settingsPath: join(claudeDir, 'settings.json'),
    stateDir: join(claudeDir, 'agentpanel'),
    claudeDir,
    log: (l) => lines.push(l),
  });
  assert.equal(readFileSync(commandFilePath(claudeDir), 'utf8'), '# mine\n');
  assert.match(lines.join('\n'), /left in place/);
});
