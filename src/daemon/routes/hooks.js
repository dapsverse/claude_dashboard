// src/daemon/routes/hooks.js
import { planActions } from '../../core/correlator.js';

const MAX_BODY = 256 * 1024;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let size = 0;
    const chunks = [];

    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        // Stop consuming without tearing down the socket: the response still needs
        // to go out on it. Dropping the 'data' listener pauses the stream, so the
        // rest of an oversized payload is never buffered into memory.
        settled = true;
        req.removeListener('data', onData);
        req.removeListener('end', onEnd);
        reject(Object.assign(new Error('too_large'), { code: 'TOO_LARGE' }));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', (err) => { if (!settled) { settled = true; reject(err); } });
  });
}

export function applyActions(actions, { runs, sessions, hub }) {
  for (const action of actions) {
    switch (action.type) {
      case 'session.touch':
        sessions.touch(action.session);
        break;
      case 'session.end':
        sessions.end(action.sessionId, action.at);
        runs.endSessionRuns(action.sessionId, action.at);
        hub.broadcast('session.end', { sessionId: action.sessionId });
        break;
      case 'run.open':
        runs.open(action.run);
        hub.broadcast('run.open', runs.get(action.run.id));
        break;
      case 'run.close':
        if (runs.close(action.close)) hub.broadcast('run.close', runs.get(action.close.id));
        break;
      case 'run.enrich': {
        const id = runs.enrich(action.match, action.patch);
        if (id) hub.broadcast('run.enrich', runs.get(id));
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
    stateChanging: true,
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

      const actions = planActions(event, { now: now() });
      applyActions(actions, { runs, sessions, hub });
      json(res, 200, { ok: true, actions: actions.length });
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
