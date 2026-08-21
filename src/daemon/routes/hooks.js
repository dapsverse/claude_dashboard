// src/daemon/routes/hooks.js
import { planActions } from '../../core/correlator.js';
import { json, readBody } from './body.js';

export function applyActions(actions, { runs, sessions, hub }) {
  for (const action of actions) {
    switch (action.type) {
      case 'session.touch':
        sessions.touch(action.session);
        break;
      case 'session.end': {
        sessions.end(action.sessionId, action.at);
        // One run.close per staled run, not just the session event: the dashboard keys everything it
        // renders by run id and drops a payload without one, so a bare {sessionId} left the rail
        // showing a phantom agent with a ticking clock until the page was reloaded. The sweeper
        // cannot repair it either — the run is out of listActive() the moment it is staled.
        for (const id of runs.endSessionRuns(action.sessionId, action.at)) {
          hub.broadcast('run.close', runs.get(id));
        }
        hub.broadcast('session.end', { sessionId: action.sessionId });
        break;
      }
      case 'run.open':
        runs.open(action.run);
        hub.broadcast('run.open', runs.get(action.run.id));
        break;
      case 'run.close':
        if (runs.close(action.close)) hub.broadcast('run.close', runs.get(action.close.id));
        break;
      // A background dispatch returned but its agent did not: record the id the SubagentStop will
      // arrive under, and broadcast the row so the rail keeps it running rather than dropping it.
      case 'run.launch':
        if (runs.launch({ id: action.id, agentId: action.agentId })) hub.broadcast('run.enrich', runs.get(action.id));
        break;
      case 'run.finish': {
        const outcome = runs.finish(action.match, action.patch);
        // `run.close` only when the run actually ended here. A foreground run is merely enriched —
        // its own PostToolUse closes it moments later with the tool's duration and full response,
        // and announcing a close now would stop the rail's clock on a run that is still open.
        if (outcome) hub.broadcast(outcome.closed ? 'run.close' : 'run.enrich', runs.get(outcome.id));
        break;
      }
      default:
        break;
    }
  }
}

export function hooksRoute({ runs, sessions, hub, now = Date.now }) {
  return {
    method: 'POST',
    path: '/api/hooks',
    handler: async (req, res) => {
      let raw;
      try { raw = await readBody(req); }
      catch (err) {
        if (err.code === 'TOO_LARGE') {
          // The rest of the body may still be sitting unread on the socket; tell the
          // client not to reuse this connection instead of yanking it out from under it.
          res.setHeader('connection', 'close');
          return json(res, 413, { error: 'bad_body' });
        }
        return json(res, 400, { error: 'bad_body' });
      }

      let event;
      try { event = JSON.parse(raw); }
      catch { return json(res, 400, { error: 'bad_json' }); }

      // A well-formed event with one wrong-typed leaf field — `cwd: {}` is enough — reaches the
      // store and throws there. Answer 500 rather than letting it escape: this endpoint is fed by
      // hook scripts on every Agent tool call, and a daemon that dies on one bad payload is worse
      // than a daemon that refuses one bad payload.
      try {
        const actions = planActions(event, { now: now() });
        applyActions(actions, { runs, sessions, hub });
        json(res, 200, { ok: true, actions: actions.length });
      } catch (err) {
        json(res, 500, { error: 'apply_failed', detail: String(err?.message ?? err) });
      }
    },
  };
}

export function runsRoute({ runs }) {
  return {
    method: 'GET',
    path: '/api/runs',
    handler: (_req, res) => json(res, 200, { active: runs.listActive(), recent: runs.listRecent(200) }),
  };
}
