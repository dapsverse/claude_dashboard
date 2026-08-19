// src/daemon/routes/body.js
//
// Shared request helpers. Extracted from routes/hooks.js when the chat routes needed the same
// bounded body reader — one implementation, so a limit fixed in one place is fixed everywhere.
export const MAX_BODY = 256 * 1024;

export function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

export function readBody(req, limit = MAX_BODY) {
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

// Reads and parses a JSON body, answering the request itself on every failure. Returns `undefined`
// when it has already responded, so a caller's `if (body === undefined) return;` is the whole of
// its error handling.
export async function readJson(req, res, limit = MAX_BODY) {
  let raw;
  try { raw = await readBody(req, limit); }
  catch (err) {
    if (err.code === 'TOO_LARGE') {
      // The rest of the body may still be sitting unread on the socket; tell the
      // client not to reuse this connection instead of yanking it out from under it.
      res.setHeader('connection', 'close');
      json(res, 413, { error: 'bad_body' });
    } else {
      json(res, 400, { error: 'bad_body' });
    }
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      json(res, 400, { error: 'bad_json' });
      return undefined;
    }
    return parsed;
  } catch {
    json(res, 400, { error: 'bad_json' });
    return undefined;
  }
}
