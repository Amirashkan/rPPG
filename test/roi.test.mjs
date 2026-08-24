import test from 'node:test';
import assert from 'node:assert/strict';
import { RoiSampler, skinChromaWeight } from '../src/roi.js';
import { stdOf } from '../src/dsp.js';
import { makeFrames, legacySample, traceSnr, N } from './roi-fixture.mjs';

test('soft weights beat a per-frame hard threshold on the same pixels', () => {
  const frames = makeFrames();
  const sampler = new RoiSampler();
  const soft = [];
  const hard = [];
  for (const f of frames) {
    soft.push(sampler.sample(f.data, N).g);
    hard.push(legacySample(f.data, N).g);
  }

  const s = traceSnr(soft, 25, 72);
  const h = traceSnr(hard, 25, 72);

  assert.ok(Math.abs(s.bpm - 72) < 2, `soft mask found ${s.bpm.toFixed(1)} bpm`);
  assert.ok(s.snrDb > h.snrDb + 2, `soft ${s.snrDb.toFixed(1)} dB vs hard ${h.snrDb.toFixed(1)} dB`);
});

test('mask churn stays far below the pulse amplitude', () => {
  const frames = makeFrames();
  const sampler = new RoiSampler();
  const churn = [];
  const trace = [];
  for (const f of frames) {
    const s = sampler.sample(f.data, N);
    churn.push(s.maskChurn);
    trace.push(s.g);
  }
  // Skip the EMA warm-up.
  const settled = churn.slice(60);
  const mean = settled.reduce((a, b) => a + b, 0) / settled.length;
  assert.ok(mean < 0.01, `mean per-pixel mask churn ${mean.toFixed(4)}`);
  assert.ok(stdOf(Float64Array.from(trace.slice(60))) > 0, 'trace is not constant');
});

test('the ROI mean stops tracking mask membership', () => {
  // This is the diagnostic that found the bug in a real recording: changes in
  // the averaged colour correlated with changes in how many pixels the mask
  // accepted. That correlation means the trace is partly measuring the mask
  // rather than the face. The recording measured 0.466 with the old mask.
  const frames = makeFrames();
  const sampler = new RoiSampler();
  const sg = [];
  const sf = [];
  const hg = [];
  const hf = [];
  for (const f of frames) {
    const s = sampler.sample(f.data, N);
    sg.push(s.g);
    sf.push(s.roiFill);
    const h = legacySample(f.data, N);
    hg.push(h.g);
    hf.push(h.roiFill);
  }

  const absDiff = (a) => {
    const d = [];
    for (let i = 1; i < a.length; i++) d.push(Math.abs(a[i] - a[i - 1]));
    return d;
  };
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const corr = (a, b) => {
    const ma = mean(a);
    const mb = mean(b);
    let n = 0;
    let da = 0;
    let db = 0;
    for (let i = 0; i < a.length; i++) {
      n += (a[i] - ma) * (b[i] - mb);
      da += (a[i] - ma) ** 2;
      db += (b[i] - mb) ** 2;
    }
    return Math.abs(n / Math.sqrt(da * db));
  };

  const legacy = corr(absDiff(hg), absDiff(hf));
  const soft = corr(absDiff(sg), absDiff(sf));
  assert.ok(legacy > 0.25, `expected the legacy mask to show the coupling, got ${legacy.toFixed(3)}`);
  assert.ok(soft < legacy / 2, `soft mask coupling ${soft.toFixed(3)} vs legacy ${legacy.toFixed(3)}`);
});

test('chroma weight still separates skin from hair and glints', () => {
  assert.ok(skinChromaWeight(196, 150, 128) > 0.9, 'forehead skin');
  // Soft gates give a negligible weight rather than a hard zero - that is what
  // stops a pixel on the boundary from jumping the average.
  assert.ok(skinChromaWeight(250, 248, 245) < 0.02, 'lens glint is neutral, not skin');
  assert.ok(skinChromaWeight(45, 40, 42) < 0.02, 'glasses rim');
});

test('unmasked sampling is a plain average', () => {
  const data = new Uint8ClampedArray(N * 4);
  for (let p = 0; p < N; p++) {
    data[p * 4] = 100; data[p * 4 + 1] = 150; data[p * 4 + 2] = 200; data[p * 4 + 3] = 255;
  }
  const s = new RoiSampler().sample(data, N, false);
  assert.equal(s.r, 100);
  assert.equal(s.g, 150);
  assert.equal(s.b, 200);
  assert.equal(s.roiFill, 1);
});
