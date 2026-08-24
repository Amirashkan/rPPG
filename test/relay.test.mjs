import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const PORT = 8899;

async function waitFor(fn, ms = 5000) {
  const t0 = Date.now();
  for (;;) {
    try { return await fn(); } catch (e) {
      if (Date.now() - t0 > ms) throw e;
      await new Promise((r) => setTimeout(r, 60));
    }
  }
}

const openSocket = (url) => new Promise((res, rej) => {
  const ws = new WebSocket(url);
  ws.onopen = () => res(ws);
  ws.onerror = (e) => rej(new Error('connect failed'));
});

test('relay fans messages out to other clients', async (t) => {
  const proc = spawn(process.execPath, ['server/relay.mjs', String(PORT), '--quiet'], { stdio: 'ignore' });
  t.after(() => proc.kill());

  await waitFor(async () => {
    const r = await fetch(`http://localhost:${PORT}/health`);
    assert.ok(r.ok);
  });

  const publisher = await waitFor(() => openSocket(`ws://localhost:${PORT}`));
  const consumer = await openSocket(`ws://localhost:${PORT}`);

  const got = [];
  consumer.onmessage = (e) => got.push(JSON.parse(e.data));

  const sample = { type: 'rppg.metrics', v: 1, bpm: 72.5, phase: 1.23, confidence: 0.9, state: 'locked' };
  publisher.send(JSON.stringify(sample));
  // A payload over 125 bytes exercises the 16-bit length path.
  const big = { type: 'rppg.frame', v: 1, pad: 'x'.repeat(400) };
  publisher.send(JSON.stringify(big));

  await waitFor(() => assert.equal(got.length, 2));
  assert.deepEqual(got[0], sample);
  assert.equal(got[1].pad.length, 400);

  // The publisher must not receive its own messages back.
  let echoed = 0;
  publisher.onmessage = () => { echoed++; };
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(echoed, 0);

  const health = await (await fetch(`http://localhost:${PORT}/health`)).json();
  assert.equal(health.ok, true);
  assert.equal(health.messages, 2);

  publisher.close();
  consumer.close();
});
