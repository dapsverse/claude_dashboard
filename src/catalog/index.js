// src/catalog/index.js
import { watch } from 'node:fs';
import { join } from 'node:path';
import { scanAgents } from './agents.js';
import { scanSkills } from './skills.js';

export { scanAgents, scanSkills };

export function scanCatalog({ claudeDir, projectRoot }) {
  return {
    agents: scanAgents({ claudeDir, projectRoot }),
    skills: scanSkills({ claudeDir, projectRoot }),
    scannedAt: Date.now(),
  };
}

export function createCatalog({ claudeDir, projectRoot, debounceMs = 250 }) {
  let cached = null;
  const watchers = [];
  let timer = null;

  const get = () => (cached ??= scanCatalog({ claudeDir, projectRoot }));
  const refresh = () => { cached = scanCatalog({ claudeDir, projectRoot }); return cached; };

  return {
    get, refresh,
    watch(onChange) {
      const targets = [join(claudeDir, 'agents'), join(claudeDir, 'skills'), join(claudeDir, 'plugins', 'cache')];
      if (projectRoot) targets.push(join(projectRoot, '.claude'));
      for (const dir of targets) {
        try {
          // Not every platform supports recursive fs.watch (notably some Linux kernels);
          // wrap each watcher so one unsupported target does not take the others down.
          watchers.push(watch(dir, { recursive: true }, () => {
            clearTimeout(timer);
            timer = setTimeout(() => onChange(refresh()), debounceMs);
            timer.unref?.();
          }));
        } catch { /* directory absent or platform lacks recursive watch: skip it */ }
      }
    },
    close() { for (const w of watchers) { try { w.close(); } catch { /* already closed */ } } },
  };
}
