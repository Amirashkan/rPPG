import test from 'node:test';
import assert from 'node:assert/strict';
import { RppgPipeline, reanalyse } from '../src/pipeline.js';
import { synthFrames } from './synth.mjs';

function run(frames, options) {
  const p = new RppgPipeline(options);
  const records = [];
  for (const f of frames) {
    const m = p.pushFrame({ ...f, quality: { roiFill: 0.9, motion: 0.01, clipping: 0 } });
    if (m) records.push(m);
  }
  return { pipeline: p, records };
}

test('recovers heart rate from a synthetic pulse', () => {
  for (const bpm of [52, 72, 96, 130]) {
    const { pipeline } = run(synthFrames({ bpm, seconds: 30, seed: bpm }));
    assert.ok(
      Math.abs(pipeline.freqHz * 60 - bpm) < 3,
      `bpm ${bpm}: estimated ${(pipeline.freqHz * 60).toFixed(1)}`,
    );
    assert.equal(pipeline.state, 'locked');
  }
});

test('rejects a strong shared illumination drift', () => {
  // POS should cancel light that moves all three channels together.
  const { pipeline } = run(synthFrames({ bpm: 78, seconds: 30, illum: 25, pulseAmp: 0.8 }));
  assert.ok(Math.abs(pipeline.freqHz * 60 - 78) < 4, `got ${(pipeline.freqHz * 60).toFixed(1)}`);
});

test('all three methods track a clean signal', () => {
  for (const method of ['pos', 'chrom', 'green']) {
    const { pipeline } = run(synthFrames({ bpm: 84, seconds: 30, illum: 2, noise: 0.2 }), { method });
    assert.ok(
      Math.abs(pipeline.freqHz * 60 - 84) < 4,
      `${method}: ${(pipeline.freqHz * 60).toFixed(1)}`,
    );
  }
});

test('emits metrics records at the configured rate', () => {
  const { records } = run(synthFrames({ bpm: 72, seconds: 20 }), { metricsHz: 5 });
  assert.ok(records.length > 80 && records.length < 120, `got ${records.length} records`);
  const m = records.at(-1);
  assert.equal(m.type, 'rppg.metrics');
  assert.equal(m.v, 1);
  assert.ok(m.phase >= 0 && m.phase < 2 * Math.PI);
  assert.ok(m.wave >= -1 && m.wave <= 1);
  assert.ok(m.signal >= -1 && m.signal <= 1);
  assert.ok(m.confidence > 0.5);
  assert.equal(typeof m.quality.roiFill, 'number');
});

test('phase advances at the heart rate', () => {
  const { records } = run(synthFrames({ bpm: 90, seconds: 30 }), { metricsHz: 30 });
  const tail = records.slice(-200);
  let wraps = 0;
  for (let i = 1; i < tail.length; i++) if (tail[i].phase < tail[i - 1].phase) wraps++;
  const span = tail.at(-1).t - tail[0].t;
  const cyclesPerMin = (wraps / span) * 60;
  assert.ok(Math.abs(cyclesPerMin - 90) < 6, `phase cycles/min = ${cyclesPerMin.toFixed(1)}`);
});

test('detects beats with plausible inter-beat intervals', () => {
  const { pipeline } = run(synthFrames({ bpm: 66, seconds: 40, noise: 0.25 }));
  const ibis = pipeline.beats.map((b) => b.ibiMs).filter(Boolean);
  assert.ok(ibis.length > 25, `only ${ibis.length} intervals`);
  const mean = ibis.reduce((a, b) => a + b, 0) / ibis.length;
  assert.ok(Math.abs(mean - 60000 / 66) < 60, `mean IBI ${mean.toFixed(0)} ms`);
  const hrv = pipeline.hrv();
  assert.ok(hrv.rmssdMs > 0 && hrv.rmssdMs < 200);
});

test('survives a dropped-camera gap and reacquires', () => {
  const a = synthFrames({ bpm: 75, seconds: 15, seed: 7 });
  const b = synthFrames({ bpm: 75, seconds: 20, seed: 8 }).map((f) => ({ ...f, t: f.t + 17 }));
  const { pipeline } = run([...a, ...b]);
  assert.ok(pipeline.droppedFrames > 0, 'gap should be recorded');
  assert.ok(Math.abs(pipeline.freqHz * 60 - 75) < 4, `got ${(pipeline.freqHz * 60).toFixed(1)}`);
});

test('reports low confidence when there is no pulse at all', () => {
  const { pipeline } = run(synthFrames({ bpm: 72, seconds: 25, pulseAmp: 0, noise: 1.2, illum: 12 }));
  assert.ok(pipeline.confidence < 0.55, `confidence ${pipeline.confidence.toFixed(2)}`);
  assert.notEqual(pipeline.state, 'locked');
});

test('offline re-analysis is at least as accurate as the live pass', () => {
  const frames = synthFrames({ bpm: 68, seconds: 30, noise: 0.6 });
  const out = reanalyse(frames);
  assert.ok(Math.abs(out.bpm - 68) < 2.5, `offline bpm ${out.bpm.toFixed(1)}`);
  assert.ok(out.beats.length > 25, `offline beats ${out.beats.length}`);
  assert.equal(out.pulse.length, out.t.length);
});

test('offline re-analysis sizes its history to the recording', () => {
  // A sentinel capacity here once reserved 8 GB per call.
  const frames = synthFrames({ bpm: 70, seconds: 20 });
  const before = process.memoryUsage().arrayBuffers;
  const out = reanalyse(frames);
  const grew = process.memoryUsage().arrayBuffers - before;
  assert.ok(grew < 50e6, `allocated ${(grew / 1e6).toFixed(1)} MB for a 20 s recording`);
  assert.ok(out.pulse.length > 20 * 30 * 0.9);
});

test('methods reject an unknown name', () => {
  assert.throws(() => new RppgPipeline({ method: 'nope' }), /unknown rPPG method/);
});

test('changing the band re-designs the filter and keeps tracking', () => {
  const frames = synthFrames({ bpm: 110, seconds: 30 });
  const p = new RppgPipeline();
  p.setBand(60, 180);
  for (const f of frames) p.pushFrame({ ...f, quality: { roiFill: 0.9 } });
  assert.ok(Math.abs(p.freqHz * 60 - 110) < 4, `got ${(p.freqHz * 60).toFixed(1)}`);
});
