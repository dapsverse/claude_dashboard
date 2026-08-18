// src/catalog/agents.js
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { parseFrontmatter } from '../core/frontmatter.js';

function listFiles(dir, ext) {
  try {
    return readdirSync(dir)
      .filter((f) => extname(f) === ext)
      .map((f) => join(dir, f))
      .filter((p) => { try { return statSync(p).isFile(); } catch { return false; } });
  } catch { return []; }
}

function readAgent(path, scope, source) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return null; }
  let data;
  try { ({ data } = parseFrontmatter(text)); } catch { data = {}; }
  return {
    kind: 'agent',
    name: typeof data.name === 'string' && data.name ? data.name : basename(path, '.md'),
    description: typeof data.description === 'string' ? data.description : '',
    tools: data.tools ?? null,
    model: typeof data.model === 'string' ? data.model : null,
    scope, source, path,
  };
}

// Plugin layout: <claudeDir>/plugins/cache/<marketplace>/<plugin>/<version>/{agents,skills}
export function pluginRoots(claudeDir) {
  const base = join(claudeDir, 'plugins', 'cache');
  const roots = [];
  for (const marketplace of safeList(base)) {
    for (const plugin of safeList(join(base, marketplace))) {
      for (const version of safeList(join(base, marketplace, plugin))) {
        roots.push({ dir: join(base, marketplace, plugin, version), plugin, marketplace, version });
      }
    }
  }
  return roots;
}

function safeList(dir) {
  try { return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch { return []; }
}

export function scanAgents({ claudeDir, projectRoot }) {
  const found = [];
  for (const p of listFiles(join(claudeDir, 'agents'), '.md')) found.push(readAgent(p, 'user', null));
  if (projectRoot) {
    for (const p of listFiles(join(projectRoot, '.claude', 'agents'), '.md')) found.push(readAgent(p, 'project', null));
  }
  for (const root of pluginRoots(claudeDir)) {
    for (const p of listFiles(join(root.dir, 'agents'), '.md')) found.push(readAgent(p, 'plugin', root.plugin));
  }
  return found.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}
