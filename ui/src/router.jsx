import { useCallback, useSyncExternalStore } from 'react';

// A single module-level source of truth for the current path, shared by every call site.
// `useState` per call site would desync Layout's nav highlighting from a page-selecting
// consumer elsewhere in the tree: pushState from one instance would never re-render the
// other, since no popstate event fires for same-tab navigation. Every useRoute() caller
// subscribes to the same store instead, so all of them re-render on any navigate() or
// browser back/forward.
let path = window.location.pathname;
const listeners = new Set();

function notify() {
  for (const listener of listeners) listener();
}

window.addEventListener('popstate', () => {
  path = window.location.pathname;
  notify();
});

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return path;
}

export function useRoute() {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const navigate = useCallback((next) => {
    window.history.pushState({}, '', next);
    path = next;
    notify();
  }, []);

  return { path: current, navigate };
}
