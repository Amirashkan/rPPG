import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fft, ifft, periodogram, welch, bandPeak, designButterworthBandpass, cascadeGain,
  IIRFilter, filtfilt, detrend, resampleUniform, findPeaks, refinePeak, stdOf,
} from '../src/dsp.js';

test('fft/ifft round-trip', () => {
  const n = 64;
  const re = Float64Array.from({ length: n }, (_, i) => Math.sin(i / 3) + i * 0.01);
  const im = new Float64Array(n);
  const orig = Float64Array.from(re);
  fft(re, im);
  ifft(re, im);
  for (let i = 0; i < n; i++) assert.ok(Math.abs(re[i] - orig[i]) < 1e-9);
});

test('fft rejects non-power-of-two input', () => {
  assert.throws(() => fft(new Float64Array(30), new Float64Array(30)), /power of two/);
});

test('periodogram locates a pure tone', () => {
  const fs = 30;
  const f0 = 1.25;
  const x = Float64Array.from({ length: 600 }, (_, i) => Math.sin((2 * Math.PI * f0 * i) / fs));
  const { freqs, psd } = periodogram(x, fs);
  const peak = bandPeak(freqs, psd, 0.5, 4);
  assert.ok(Math.abs(peak.freq - f0) < 0.01, `peak at ${peak.freq}`);
  assert.ok(peak.snrDb > 15, `snr ${peak.snrDb}`);
});

test('welch averages segments and still finds the tone', () => {
  const fs = 30;
  const x = Float64Array.from({ length: 900 }, (_, i) =>
    Math.sin((2 * Math.PI * 1.6 * i) / fs) + 0.5 * Math.random());
  const { freqs, psd } = welch(x, fs, { segment: 180, overlap: 0.5 });
  const peak = bandPeak(freqs, psd, 0.7, 3.5);
  assert.ok(Math.abs(peak.freq - 1.6) < 0.05, `peak at ${peak.freq}`);
});

test('bandPeak returns null when the band holds no bins', () => {
  const { freqs, psd } = periodogram(new Float64Array(128), 30);
  // Entirely above Nyquist, so no bin can fall inside it.
  assert.equal(bandPeak(freqs, psd, 20, 25), null);
});

test('butterworth band-pass is -3 dB at both edges and flat between', () => {
  const fs = 30;
  const s = designButterworthBandpass(2, 0.7, 3.5, fs);
  const db = (f) => 20 * Math.log10(cascadeGain(s, f, fs));
  assert.ok(Math.abs(db(0.7) + 3.01) < 0.05, `lo edge ${db(0.7)}`);
  assert.ok(Math.abs(db(3.5) + 3.01) < 0.05, `hi edge ${db(3.5)}`);
  assert.ok(db(1.5) > -0.2, `passband ${db(1.5)}`);
  assert.ok(db(0.1) < -30, `dc reject ${db(0.1)}`);
  assert.ok(db(10) < -25, `hf reject ${db(10)}`);
});

test('streaming filter removes DC and out-of-band tones', () => {
  const fs = 30;
  const filt = new IIRFilter(designButterworthBandpass(2, 0.7, 3.5, fs));
  const out = [];
  for (let i = 0; i < 1800; i++) {
    const t = i / fs;
    out.push(filt.process(120 + 3 * Math.sin(2 * Math.PI * 0.1 * t) + Math.sin(2 * Math.PI * 1.2 * t)));
  }
  const tail = Float64Array.from(out.slice(-600));
  assert.ok(Math.abs(stdOf(tail) - Math.SQRT1_2) < 0.1, `amplitude ${stdOf(tail)}`);
});

test('filtfilt is zero-phase', () => {
  const fs = 30;
  const n = 900;
  const x = Float64Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 1.2 * i) / fs));
  const y = filtfilt(designButterworthBandpass(2, 0.7, 3.5, fs), x);
  // Peaks of input and output must line up (no group delay).
  const px = findPeaks(x, { minDistance: 10 }).slice(2, -2);
  const py = findPeaks(y, { minDistance: 10 }).slice(2, -2);
  assert.equal(px.length, py.length);
  for (let i = 0; i < px.length; i++) assert.ok(Math.abs(px[i] - py[i]) <= 1);
});

test('detrend removes a linear ramp', () => {
  const x = Float64Array.from({ length: 100 }, (_, i) => 5 + 0.3 * i);
  const y = detrend(x);
  for (const v of y) assert.ok(Math.abs(v) < 1e-9);
});

test('resampleUniform lands on a regular grid', () => {
  const t = [0, 0.031, 0.078, 0.10, 0.14, 0.169, 0.2];
  const v = t.map((x) => 2 * x + 1);
  const { values } = resampleUniform(t, v, 30);
  assert.equal(values.length, 7);
  for (let i = 0; i < values.length; i++) {
    assert.ok(Math.abs(values[i] - (2 * (i / 30) + 1)) < 0.02, `sample ${i} = ${values[i]}`);
  }
});

test('findPeaks honours the minimum distance', () => {
  const fs = 30;
  const x = Float64Array.from({ length: 300 }, (_, i) => Math.sin((2 * Math.PI * 1 * i) / fs));
  const p = findPeaks(x, { minDistance: 20 });
  assert.equal(p.length, 10);
  for (let i = 1; i < p.length; i++) assert.ok(p[i] - p[i - 1] >= 20);
});

test('refinePeak interpolates between samples', () => {
  const x = [0, 1, 0.998, 0];   // true maximum sits between indices 1 and 2
  const r = refinePeak(x, 1);
  assert.ok(r > 1 && r < 1.5, `refined ${r}`);
});
