import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { findAvailablePort, isPortFree, PortRangeExhaustedError } from '../../src/core/port.js';

function occupy(port) {
  return new Promise((res) => {
    const s = createServer();
    s.listen(port, '127.0.0.1', () => res(s));
  });
}

test('skips an occupied port and returns the next free one', async () => {
  const held = await occupy(18888);
  try {
    const port = await findAvailablePort({ start: 18888, end: 18890 });
    assert.equal(port, 18889);
  } finally { held.close(); }
});

test('reports an occupied port as not free', async () => {
  const held = await occupy(18891);
  try { assert.equal(await isPortFree(18891), false); }
  finally { held.close(); }
});

test('throws when the whole range is taken', async () => {
  const a = await occupy(18892);
  try {
    await assert.rejects(
      () => findAvailablePort({ start: 18892, end: 18892 }),
      (e) => e instanceof PortRangeExhaustedError
    );
  } finally { a.close(); }
});
