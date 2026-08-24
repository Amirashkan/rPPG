import test from 'node:test';
import assert from 'node:assert/strict';
import { RppgPipeline } from '../src/pipeline.js';
import { synthFrames } from './synth.mjs';

/**
 * A marginal recording: a real pulse, but with the SNR wandering across the
 * lock threshold the way a seated subject with glasses and a slightly wrong ROI
 * actually looks. This is the case that used to flip locked/searching every few
 * seconds.
 */
function marginalFrames({ bpm = 72, seconds = 90, seed = 4 } = {}) {
  const frames = synthFrames({ bpm, seconds, pulseAmp: 1.0, noise: 0.5, seed });
  let phase = seed;
  return frames.map((f) => {
    phase += 0.017;
    // Slow SNR wander: pulse strength breathes, noise breathes the other way.
    const gain = 0.55 + 0.45 * Math.sin(phase * 0.7);
    const noise = 0.9 + 0.7 * Math.sin(phase * 0.41 + 1.1);
    const jitter = () => (Math.random() - 0.5) * noise;
    const mid = (f.r + f.g + f.b) / 3;
    return {
      t: f.t,
      r: mid + (f.r - mid) * gain + jitter(),
      g: mid + (f.g - mid) * gain + jitter(),
      b: mid + (f.b - mid) * gain + jitter(),
    };
  });
}

function run(frames, options) {
  const p = new RppgPipeline(options);
  const states = [];
  for (const f of frames) {
    const m = p.pushFrame({ ...f, quality: { roiFill: 0.95, motion: 0.01, clipping: 0 } });
    if (m) states.push({ t: m.t, state: m.state, bpm: m.bpm, confidence: m.confidence });
  }
  return { pipeline: p, states };
}

function transitions(states) {
  let n = 0;
  for (let i = 1; i < states.length; i++) {
    if (states[i].state !== states[i - 1].state) n++;
  }
  return n;
}

test('lock does not chatter on a marginal signal', () => {
  // A bare threshold on the same signal - what this used to do.
  const naive = { lockEnter: 0.55, lockExit: 0.55, lockDwellSec: 0, confRise: 0.2, confFall: 0.2 };
  let bare = 0;
  let hyst = 0;
  for (const seed of [3, 4, 5, 6, 7, 8]) {
    const frames = marginalFrames({ seconds: 90, seed });
    bare += transitions(run(frames, naive).states.filter((s) => s.t > 15));
    hyst += transitions(run(frames).states.filter((s) => s.t > 15));
  }
  assert.ok(hyst < bare, `hysteresis gave ${hyst} transitions vs ${bare} for a bare threshold`);
  // This signal is built to cross the threshold every ~18 s, so some
  // transitions are honest. What must not happen is flip-flopping.
  const perMinute = (hyst / (6 * 75)) * 60;
  assert.ok(perMinute < 3, `${perMinute.toFixed(1)} lock transitions per minute`);
});

test('lock transitions are never closer together than the dwell time', () => {
  const { states } = run(marginalFrames({ seconds: 120, seed: 21 }));
  const settled = states.filter((s) => s.t > 15);
  let lastFlip = -Infinity;
  for (let i = 1; i < settled.length; i++) {
    if (settled[i].state === settled[i - 1].state) continue;
    const gap = settled[i].t - lastFlip;
    assert.ok(gap >= 2.0, `two lock transitions ${gap.toFixed(1)} s apart at t=${settled[i].t.toFixed(1)}`);
    lastFlip = settled[i].t;
  }
  assert.ok(settled.some((s) => s.state === 'locked'), 'never locked at all');
});

test('a brief artefact does not break an established lock', () => {
  const good = synthFrames({ bpm: 75, seconds: 30, seed: 11 });
  // One second of violent motion in the middle of an otherwise clean recording.
  const frames = good.map((f) => {
    if (f.t > 20 && f.t < 21) {
      const kick = 40 * Math.sin(f.t * 130);
      return { t: f.t, r: f.r + kick, g: f.g + kick * 0.9, b: f.b + kick * 1.1 };
    }
    return f;
  });
  const { states } = run(frames);
  const after = states.filter((s) => s.t > 22 && s.t < 26);
  assert.ok(after.length > 0);
  assert.ok(
    after.filter((s) => s.state === 'locked').length / after.length > 0.7,
    'lock did not survive a one-second artefact',
  );
});

test('the tracked rate stays put through the artefact', () => {
  const good = synthFrames({ bpm: 75, seconds: 30, seed: 12 });
  const frames = good.map((f) => (f.t > 20 && f.t < 21
    ? { t: f.t, r: f.r + 30, g: f.g - 25, b: f.b + 18 }
    : f));
  const { states } = run(frames);
  for (const s of states.filter((x) => x.t > 22)) {
    assert.ok(Math.abs(s.bpm - 75) < 8, `rate wandered to ${s.bpm.toFixed(1)} at t=${s.t}`);
  }
});

test('does not lock onto the second harmonic', () => {
  // A pulse whose harmonic is stronger than its fundamental - common with a
  // sharp systolic upstroke, and the classic cause of a doubled reading.
  const fs = 30;
  const bpm = 60;
  const f0 = bpm / 60;
  const frames = [];
  for (let i = 0; i < fs * 40; i++) {
    const t = i / fs;
    const p = 0.6 * Math.sin(2 * Math.PI * f0 * t) + 1.0 * Math.sin(4 * Math.PI * f0 * t);
    frames.push({ t, r: 178 + 0.33 * p, g: 132 + 0.77 * p, b: 112 + 0.53 * p });
  }
  const { pipeline } = run(frames);
  const got = pipeline.freqHz * 60;
  // 120 bpm would be the harmonic; either reading is "a peak", but a doubled
  // heart rate is the wrong one to report.
  assert.ok(got < 100, `locked onto ${got.toFixed(1)} bpm (harmonic doubling)`);
});
