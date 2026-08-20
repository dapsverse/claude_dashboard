// src/cli/command-file.js
//
// The `/dashboard` slash command: a markdown file in the user's own `~/.claude/commands/`, installed
// by `init` alongside the hooks and removed by `uninstall`.
//
// It is a template rather than a static file because the command it tells Claude to run has to be an
// absolute path into this installation — the same reason the hook entries in settings.json are
// absolute. `npx` runs from a cache directory that a later version rehashes, which `init` already
// warns about; a relative path would additionally break the moment the user is in another directory.

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const COMMAND_NAME = 'dashboard';

// Every file this module writes carries it, and nothing else on the user's machine does. It is what
// makes "leave a file we did not write alone" decidable — for the install that must not clobber
// someone's own `/dashboard`, and for the uninstall that must not delete it either.
export const OWNERSHIP_MARKER = 'agentpanel-command-version:';

const PLACEHOLDER = '__AGENTPANEL_COMMAND__';

export const commandsDir = (claudeDir) => join(claudeDir, 'commands');
export const commandFilePath = (claudeDir) => join(commandsDir(claudeDir), `${COMMAND_NAME}.md`);

/**
 * The shell command the slash command runs. Quoted, because a path with a space in it would
 * otherwise be split into two arguments — and built from `entry` alone, never from anything a user
 * typed, so there is nothing here to interpolate a command into.
 */
export const dashboardCommand = (nodeBin, entry) => `${nodeBin} "${entry}" dashboard`;

export function renderCommandFile(template, { nodeBin, entry }) {
  return template.split(PLACEHOLDER).join(dashboardCommand(nodeBin, entry));
}

export const isOurs = (contents) => String(contents).includes(OWNERSHIP_MARKER);

/**
 * Install (or refresh) the command file.
 *
 * Returns one of:
 *   { status: 'written' }   — created it
 *   { status: 'updated' }   — ours, and the contents changed (a new entry path, a new template)
 *   { status: 'current' }   — ours, and already byte-identical
 *   { status: 'foreign' }   — a `/dashboard` we did not write. Left untouched: silently replacing a
 *                             command the user wrote themselves is worse than not installing ours.
 */
export function installCommandFile({ claudeDir, templatePath, nodeBin, entry }) {
  const target = commandFilePath(claudeDir);
  const contents = renderCommandFile(readFileSync(templatePath, 'utf8'), { nodeBin, entry });

  if (existsSync(target)) {
    const existing = readFileSync(target, 'utf8');
    if (!isOurs(existing)) return { status: 'foreign', path: target };
    if (existing === contents) return { status: 'current', path: target };
    writeFileSync(target, contents);
    return { status: 'updated', path: target };
  }

  mkdirSync(commandsDir(claudeDir), { recursive: true });
  writeFileSync(target, contents);
  return { status: 'written', path: target };
}

/**
 * Remove it again. A file without our marker is reported rather than deleted — by then it is
 * somebody else's `/dashboard`, whatever it was when we looked at it last.
 */
export function removeCommandFile({ claudeDir }) {
  const target = commandFilePath(claudeDir);
  if (!existsSync(target)) return { status: 'absent', path: target };
  if (!isOurs(readFileSync(target, 'utf8'))) return { status: 'foreign', path: target };
  rmSync(target, { force: true });
  return { status: 'removed', path: target };
}
