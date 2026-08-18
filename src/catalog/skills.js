// src/catalog/skills.js
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parseFrontmatter } from '../core/frontmatter.js';
import { pluginRoots } from './agents.js';

function skillsIn(dir, scope, source, version) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()); }
  catch { return []; }

  const out = [];
  for (const entry of entries) {
    const path = join(dir, entry.name, 'SKILL.md');
    if (!existsSync(path)) continue;
    let text;
    try { text = readFileSync(path, 'utf8'); } catch { continue; }
    let data;
    try { ({ data } = parseFrontmatter(text)); } catch { data = {}; }
    out.push({
      kind: 'skill',
      name: typeof data.name === 'string' && data.name ? data.name : basename(entry.name),
      description: typeof data.description === 'string' ? data.description : '',
      scope, source, version: version ?? null, path,
    });
  }
  return out;
}

export function scanSkills({ claudeDir, projectRoot }) {
  const found = [
    ...skillsIn(join(claudeDir, 'skills'), 'user', null, null),
    ...(projectRoot ? skillsIn(join(projectRoot, '.claude', 'skills'), 'project', null, null) : []),
  ];
  for (const root of pluginRoots(claudeDir)) {
    found.push(...skillsIn(join(root.dir, 'skills'), 'plugin', root.plugin, root.version));
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}
