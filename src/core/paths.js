// src/core/paths.js
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR
    ? resolve(process.env.CLAUDE_CONFIG_DIR)
    : join(homedir(), '.claude');
}

export function stateDir() { return join(claudeHome(), 'agentpanel'); }
export function runtimeFilePath() { return join(stateDir(), 'daemon.json'); }
export function dbPath() { return join(stateDir(), 'data.db'); }
export function logFilePath() { return join(stateDir(), 'daemon.log'); }
export function userSettingsPath() { return join(claudeHome(), 'settings.json'); }
export function userAgentsDir() { return join(claudeHome(), 'agents'); }
export function userSkillsDir() { return join(claudeHome(), 'skills'); }
export function pluginsCacheDir() { return join(claudeHome(), 'plugins', 'cache'); }
export function projectAgentsDir(root) { return join(resolve(root), '.claude', 'agents'); }
export function projectSkillsDir(root) { return join(resolve(root), '.claude', 'skills'); }
