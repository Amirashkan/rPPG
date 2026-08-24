// The rPPG pipeline: irregular camera frames in, pulse + heart-rate metrics out.
//
//   frames -> uniform resampling -> windowed chrominance extraction ->
//   band-pass -> [ spectral HR | quadrature phase tracking | beat detection ]
//
// Everything here is pure computation: no DOM, no camera. That keeps it
// testable in Node and reusable for offline re-analysis of recorded sessions.

import {
  designButterworthBandpass, IIRFilter, welch, bandPeak, bandPower, localPeakNear,
  meanOf, stdOf, detrend, findPeaks, refinePeak, filtfilt,
} from './dsp.js';
import { WindowedExtractor, METHOD_INFO } from './methods.js';

export const DEFAULTS = {
  fs: 30,               // uniform analysis rate (Hz)
  method: 'pos',
  minBpm: 42,
  maxBpm: 210,
  windowSec: 1.6,       // chrominance window (POS spec)
  analysisSec: 10,      // spectral window for the HR estimate
  historySec: 60,       // retained pulse history
  metricsHz: 5,         // rate of full metric emissions
  trackerBandwidthHz: 0.3, // how fast the phase tracker may follow HR changes
  maxGapSec: 1.5,       // longer frame gaps restart the uniform timeline

  // Lock hysteresis. A single threshold on a noisy confidence makes the state
  // chatter between locked and searching every few seconds, which is both
  // useless to look at and useless to drive a visual from. Entering the lock
  // takes a clearly good signal; leaving it takes a clearly bad one, sustained.
  lockEnter: 0.62,
  lockExit: 0.42,
  lockDwellSec: 2.0,
  confRise: 0.25,       // per estimate (2 Hz), so ~2 s to rise
  confFall: 0.08,       // ~6 s to fall: brief dips do not drop the lock
  slewLockedHz: 0.06,   // 3.6 bpm/s once locked
  slewSearchHz: 0.35,   // 21 bpm/s while reacquiring
  freezeBelow: 0.25,    // below this confidence, hold the rate instead of chasing noise
  subharmonicRatio: 0.25, // prefer f/2 when it carries this fraction of the peak
  artefactSigma: 5,     // |sample| above this many baseline RMS is not a pulse
};

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const TWO_PI = Math.PI * 2;

/** Map SNR in dB onto a 0..1 confidence with a soft knee around 0 dB. */
function snrToConfidence(snrDb) {
  return clamp(1 / (1 + Math.exp(-(snrDb + 1.0) / 2.2)), 0, 1);
}

export class RppgPipeline {
  constructor(options = {}) {
    this.opt = { ...DEFAULTS, ...options };
    const { fs, minBpm, maxBpm } = this.opt;

    this.loHz = minBpm / 60;
    this.hiHz = maxBpm / 60;

    this.extractor = new WindowedExtractor({
      fs,
      method: this.opt.method,
      windowSec: this.opt.windowSec,
      capacitySec: this.opt.historySec,
    });

    this.bandpass = new IIRFilter(designButterworthBandpass(2, this.loHz, this.hiHz, fs));

    this.capacity = Math.round(this.opt.historySec * fs);
    this.filtered = new Float64Array(this.capacity);
    this.times = new Float64Array(this.capacity);
    this.rawRgb = null; // set by reset()

    this.reset();
  }

  reset() {
    const { fs } = this.opt;
    this.extractor.reset();
    this.bandpass.primed = false;
    this.filtered.fill(0);
    this.times.fill(0);
    this.n = 0;                 // uniform samples emitted

    this.gridT = null;          // next uniform grid time (s)
    this.prev = null;           // previous raw frame, for interpolation
    this.t0 = null;             // session start time (s)

    this.freqHz = 1.2;          // current HR estimate (Hz)
    this.snrDb = -Infinity;
    this.confidence = 0;
    this.state = 'idle';
    this._belowSince = null;

    this.rmsSlow = 0;
    this.artefactUntil = -Infinity;
    this.artefacts = 0;
    this.lo = { re: 0, im: 0 }; // quadrature tracker state
    this.psi = 0;               // local oscillator phase
    this.phase = 0;
    this.amplitude = 0;
    this.rms = 0;

    this.beats = [];            // {t, ibiMs, bpm, amplitude}
    this.lastBeatT = null;
    this.spectrum = null;
    this.bpmHistory = [];
    this.quality = { roiFill: 0, motion: 0, clipping: 0 };
    this.frameCount = 0;
    this.droppedFrames = 0;
    this.lastMetricsT = -Infinity;
    this.sampleRateActual = fs;
    this._metricsDue = false;
  }

  setMethod(method) {
    this.opt.method = method;
    this.extractor.setMethod(method);
    this.extractor.reset();
    this.bandpass.primed = false;
    this.n = 0;
    this.state = 'acquiring';
  }

  setBand(minBpm, maxBpm) {
    this.opt.minBpm = minBpm;
    this.opt.maxBpm = maxBpm;
    this.loHz = minBpm / 60;
    this.hiHz = maxBpm / 60;
    this.bandpass = new IIRFilter(
      designButterworthBandpass(2, this.loHz, this.hiHz, this.opt.fs),
    );
    this.freqHz = clamp(this.freqHz, this.loHz, this.hiHz);
  }

  /**
   * Ingest one camera frame.
   * @param {object} f
   * @param {number} f.t timestamp in seconds (any monotonic clock)
   * @param {number} f.r mean red in the ROI
   * @param {number} f.g
   * @param {number} f.b
   * @param {object} [f.quality] {roiFill, motion, clipping}
   * @returns {object|null} a metrics record when one is due, else null
   */
  pushFrame({ t, r, g, b, quality }) {
    if (this.t0 === null) this.t0 = t;
    const rel = t - this.t0;
    this.frameCount++;
    if (quality) this.quality = quality;

    if (!this.prev) {
      this.prev = { t: rel, r, g, b };
      this.gridT = rel;
      this.state = 'acquiring';
      return null;
    }

    const gap = rel - this.prev.t;
    if (gap <= 0) return null;                 // duplicate or out-of-order frame
    // A short hiccup (a backgrounded tab, a dropped frame) is interpolated
    // across: a second of poor samples costs far less than discarding the ten
    // seconds of history the spectral estimate is built on. Only a real stall
    // restarts the timeline.
    if (gap > this.opt.maxGapSec) {            // camera stalled: restart cleanly
      this.droppedFrames += Math.round(gap * this.opt.fs);
      this.prev = { t: rel, r, g, b };
      this.gridT = rel;
      this.extractor.reset();
      this.bandpass.primed = false;
      this.state = 'acquiring';
      return null;
    }

    // Linearly interpolate every uniform grid point covered by this frame.
    const step = 1 / this.opt.fs;
    let emitted = false;
    while (this.gridT <= rel + 1e-9) {
      const a = (this.gridT - this.prev.t) / gap;
      const w = clamp(a, 0, 1);
      this._pushUniform(
        this.gridT,
        this.prev.r + (r - this.prev.r) * w,
        this.prev.g + (g - this.prev.g) * w,
        this.prev.b + (b - this.prev.b) * w,
      );
      this.gridT += step;
      emitted = true;
    }
    this.prev = { t: rel, r, g, b };

    if (emitted && this._metricsDue) {
      this._metricsDue = false;
      return this.metrics();
    }
    return null;
  }

  // One sample on the uniform timeline.
  _pushUniform(t, r, g, b) {
    const { fs } = this.opt;
    const pulse = this.extractor.push(r, g, b);
    const y = this.bandpass.process(pulse);

    const idx = this.n % this.capacity;
    this.filtered[idx] = y;
    this.times[idx] = t;
    this.n++;

    // Running RMS, used to normalise the display signal and gate beat detection.
    const rmsAlpha = 1 - Math.exp(-1 / (3 * fs));
    this.rms = Math.sqrt((1 - rmsAlpha) * this.rms * this.rms + rmsAlpha * y * y);

    // A much slower baseline, so a single large excursion cannot inflate the
    // very threshold that is supposed to catch it.
    const slowAlpha = 1 - Math.exp(-1 / (20 * fs));
    this.rmsSlow = Math.sqrt((1 - slowAlpha) * this.rmsSlow * this.rmsSlow + slowAlpha * y * y);

    // A blink, a swallow, a head turn: energy orders of magnitude above the
    // pulse. It contaminates the whole analysis window, not just its own
    // samples, so the rate estimate is suspended until the window has moved
    // past it. Without this the estimator happily tracks the artefact - and
    // because a slew limit bounds speed but not distance, it will walk all the
    // way to the edge of the search band and sit there looking confident.
    if (this.n > 5 * fs && this.rmsSlow > 1e-12 && Math.abs(y) > this.opt.artefactSigma * this.rmsSlow) {
      this.artefactUntil = t + this.opt.analysisSec;
      this.artefacts++;
    }

    this._track(y);
    this._detectBeat(t);

    if (this.n % Math.max(1, Math.round(fs / 2)) === 0) this._estimateRate();

    const metricsEvery = Math.max(1, Math.round(fs / this.opt.metricsHz));
    if (this.n % metricsEvery === 0) this._metricsDue = true;
  }

  /**
   * Quadrature (complex) demodulation at the current HR estimate.
   *
   * Multiplying the pulse by a local oscillator at f_hr and low-passing leaves
   * the slowly-varying amplitude and phase offset of the cardiac component.
   * That gives a continuous, noise-free phase - which is exactly what an
   * external animation wants to lock onto, and is far smoother than driving
   * visuals from raw beat detections.
   */
  _track(y) {
    const { fs, trackerBandwidthHz } = this.opt;
    this.psi += (TWO_PI * this.freqHz) / fs;
    if (this.psi > TWO_PI) this.psi -= TWO_PI;

    const c = Math.cos(this.psi);
    const s = Math.sin(this.psi);
    const a = 1 - Math.exp((-TWO_PI * trackerBandwidthHz) / fs);
    this.lo.re += a * (y * c - this.lo.re);
    this.lo.im += a * (-y * s - this.lo.im);

    this.amplitude = 2 * Math.hypot(this.lo.re, this.lo.im);
    let ph = this.psi + Math.atan2(this.lo.im, this.lo.re);
    ph %= TWO_PI;
    if (ph < 0) ph += TWO_PI;
    this.phase = ph;
  }

  // Confirm a systolic peak a few samples after the fact, so noise spikes
  // do not fire a beat.
  _detectBeat(t) {
    const { fs } = this.opt;
    const d = Math.max(2, Math.round(0.06 * fs));
    if (this.n < 2 * d + 1) return;

    const at = (back) => this.filtered[(this.n - 1 - back + this.capacity * 2) % this.capacity];
    const centre = at(d);
    if (centre < 0.35 * this.rms) return;
    for (let k = 1; k <= d; k++) {
      if (at(d - k) >= centre || at(d + k) > centre) return;
    }

    const peakT = t - d / fs;
    const minIbi = 60 / this.opt.maxBpm;
    if (this.lastBeatT !== null && peakT - this.lastBeatT < minIbi) return;

    const ibiMs = this.lastBeatT === null ? null : (peakT - this.lastBeatT) * 1000;
    this.lastBeatT = peakT;
    const beat = {
      t: peakT,
      ibiMs: ibiMs && ibiMs < 60000 / this.opt.minBpm ? ibiMs : null,
      bpm: ibiMs ? 60000 / ibiMs : null,
      amplitude: centre,
      confidence: this.confidence,
    };
    this.beats.push(beat);
    if (this.beats.length > 600) this.beats.shift();
    this.newBeat = beat;
  }

  /** Spectral heart-rate estimate over the recent analysis window. */
  _estimateRate() {
    const { fs, analysisSec } = this.opt;
    const want = Math.round(analysisSec * fs);
    if (this.n < Math.round(4 * fs)) {
      this.state = 'acquiring';
      return;
    }
    const seg = detrend(this._recent(Math.min(want, this.n)));
    const { freqs, psd } = welch(seg, fs, {
      segment: Math.min(seg.length, Math.round(6 * fs)),
      overlap: 0.75,
    });
    const peak = bandPeak(freqs, psd, this.loHz, this.hiHz);
    this.spectrum = { freqs, psd };
    if (!peak) return;

    const t = this.elapsed;
    this.snrDb = peak.snrDb;

    // Confidence rises faster than it falls, so a one-off artefact costs a
    // little confidence rather than the whole lock.
    let target = snrToConfidence(peak.snrDb) * clamp(this.quality.roiFill || 1, 0, 1);

    // Head motion moves far more light than a heartbeat does; when it is
    // present the spectrum is measuring the motion.
    const motion = this.quality.motion ?? 0;
    target *= clamp(1 - motion / 0.05, 0.05, 1);

    // A peak pinned to the edge of the search band is nearly always energy
    // leaking in from outside it, not a heart rate that happens to sit exactly
    // at the limit.
    if (peak.freq <= this.loHz * 1.02 || peak.freq >= this.hiHz * 0.98) target *= 0.4;

    // A window still containing a large artefact cannot be trusted at all.
    const contaminated = t < this.artefactUntil;
    if (contaminated) target = Math.min(target, 0.15);

    const a = target > this.confidence ? this.opt.confRise : this.opt.confFall;
    this.confidence += a * (target - this.confidence);

    if (!contaminated) this.freqHz = this._trackFrequency(peak, freqs, psd);
    this._updateLock(t);

    this.bpmHistory.push({ t: this.times[(this.n - 1) % this.capacity], bpm: this.freqHz * 60, confidence: this.confidence });
    if (this.bpmHistory.length > 3600) this.bpmHistory.shift();
  }

  /**
   * Move the tracked rate toward the spectral peak, slew-limited, with an
   * octave guard.
   *
   * The guard matters because the second harmonic of a real pulse often rivals
   * the fundamental. Without it the estimate flips between f and 2f, and every
   * flip destroys the phase lock and the confidence with it.
   */
  _trackFrequency(peak, freqs, psd) {
    // Below the confidence floor there is nothing worth following; holding the
    // last good rate beats chasing whatever the noise happened to peak at.
    if (this.confidence < this.opt.freezeBelow && this.state !== 'acquiring') {
      return this.freqHz;
    }

    let target = clamp(peak.freq, this.loHz, this.hiHz);

    // Octave check. A pulse with a sharp systolic upstroke can put more power
    // in its second harmonic than in its fundamental, and reporting double
    // someone's heart rate is the worst failure this thing can have. If half
    // the peak frequency is in band and carries a real share of the power,
    // that is the fundamental.
    const half = target / 2;
    if (half >= this.loHz) {
      const cand = localPeakNear(freqs, psd, half, 0.1);
      if (cand) {
        const atHalf = bandPower(freqs, psd, cand.freq, 0.1);
        const atPeak = bandPower(freqs, psd, target, 0.1);
        if (atHalf > this.opt.subharmonicRatio * atPeak) target = cand.freq;
      }
    }

    if (this.state === 'locked') {
      const ratio = target / this.freqHz;
      const isOctave = Math.abs(ratio - 2) < 0.15 || Math.abs(ratio - 0.5) < 0.08;
      const here = bandPower(freqs, psd, this.freqHz, 0.1);
      const there = bandPower(freqs, psd, target, 0.1);
      if (isOctave && there < 3 * here) {
        target = this.freqHz;   // not decisively better: keep continuity
      }
    }

    // The slew limit keys off the lock state, not off raw confidence. Keying it
    // off confidence created a feedback loop: a dip let the rate jump, the jump
    // cost SNR, the lost SNR deepened the dip.
    const maxStep = this.state === 'locked' ? this.opt.slewLockedHz : this.opt.slewSearchHz;
    return this.freqHz + clamp(target - this.freqHz, -maxStep, maxStep);
  }

  /** Schmitt-triggered lock state with a dwell time on the way out. */
  _updateLock(t) {
    const { lockEnter, lockExit, lockDwellSec } = this.opt;
    if (this.state === 'locked') {
      if (this.confidence < lockExit) {
        if (this._belowSince == null) this._belowSince = t;
        if (t - this._belowSince >= lockDwellSec) {
          this.state = 'searching';
          this._belowSince = null;
        }
      } else {
        this._belowSince = null;
      }
    } else if (this.confidence >= lockEnter) {
      this.state = 'locked';
      this._belowSince = null;
    } else {
      this.state = 'searching';
    }
  }

  /** Most recent `n` filtered samples, oldest first. */
  _recent(n) {
    const len = Math.min(n, this.n, this.capacity);
    const out = new Float64Array(len);
    for (let i = 0; i < len; i++) out[i] = this.filtered[(this.n - len + i) % this.capacity];
    return out;
  }

  /** Most recent `n` samples as {t, value} pairs, for plotting. */
  recentSeries(n) {
    const len = Math.min(n, this.n, this.capacity);
    const t = new Float64Array(len);
    const v = new Float64Array(len);
    for (let i = 0; i < len; i++) {
      const k = (this.n - len + i) % this.capacity;
      t[i] = this.times[k];
      v[i] = this.filtered[k];
    }
    return { t, v };
  }

  /** Short-term HRV from detected inter-beat intervals. */
  hrv(windowCount = 60) {
    const ibis = this.beats
      .slice(-windowCount)
      .map((x) => x.ibiMs)
      .filter((x) => x != null);
    if (ibis.length < 5) return { rmssdMs: null, sdnnMs: null, meanIbiMs: null, n: ibis.length };
    let sq = 0;
    for (let i = 1; i < ibis.length; i++) {
      const d = ibis[i] - ibis[i - 1];
      sq += d * d;
    }
    return {
      rmssdMs: Math.sqrt(sq / (ibis.length - 1)),
      sdnnMs: stdOf(ibis),
      meanIbiMs: meanOf(ibis),
      n: ibis.length,
    };
  }

  get elapsed() {
    return this.n ? this.times[(this.n - 1) % this.capacity] : 0;
  }

  /**
   * The public data record. This is the exact shape that gets streamed and
   * recorded - see docs/DATA.md.
   */
  metrics() {
    const t = this.elapsed;
    const sig = this.rms > 1e-12 ? clamp(this.filtered[(this.n - 1 + this.capacity) % this.capacity] / (3 * this.rms), -1, 1) : 0;
    const hrv = this.hrv();
    const last = this.beats[this.beats.length - 1];
    return {
      type: 'rppg.metrics',
      v: 1,
      t: round(t, 4),
      wallClock: Date.now(),
      state: this.state,
      bpm: round(this.freqHz * 60, 2),
      bpmSource: 'spectral',
      confidence: round(this.confidence, 3),
      snrDb: Number.isFinite(this.snrDb) ? round(this.snrDb, 2) : null,
      // --- continuous drivers for external animation -----------------------
      phase: round(this.phase, 4),
      wave: round(Math.cos(this.phase), 4),
      signal: round(sig, 4),
      amplitude: round(this.amplitude, 6),
      // --- beat-derived ----------------------------------------------------
      lastBeatT: last ? round(last.t, 4) : null,
      ibiMs: last && last.ibiMs ? round(last.ibiMs, 1) : null,
      hrv: {
        rmssdMs: hrv.rmssdMs == null ? null : round(hrv.rmssdMs, 1),
        sdnnMs: hrv.sdnnMs == null ? null : round(hrv.sdnnMs, 1),
        beats: hrv.n,
      },
      quality: {
        roiFill: round(this.quality.roiFill ?? 0, 3),
        motion: round(this.quality.motion ?? 0, 4),
        clipping: round(this.quality.clipping ?? 0, 3),
        // True while a large artefact is still inside the analysis window. The
        // heart rate is held rather than re-estimated for as long as this is
        // set, so a consumer knows the reading is stale rather than wrong.
        contaminated: this.elapsed < this.artefactUntil,
        artefacts: this.artefacts,
      },
      method: this.opt.method,
      fs: this.opt.fs,
      frames: this.frameCount,
      samples: this.n,
    };
  }

  /** Static description of the current configuration, emitted at session start. */
  describe() {
    return {
      type: 'rppg.session',
      v: 1,
      wallClock: Date.now(),
      method: this.opt.method,
      methodInfo: METHOD_INFO[this.opt.method],
      fs: this.opt.fs,
      band: { minBpm: this.opt.minBpm, maxBpm: this.opt.maxBpm },
      windowSec: this.opt.windowSec,
      analysisSec: this.opt.analysisSec,
      metricsHz: this.opt.metricsHz,
    };
  }
}

function round(x, p) {
  if (x == null || !Number.isFinite(x)) return null;
  const m = 10 ** p;
  return Math.round(x * m) / m;
}

/**
 * Re-analyse a recorded raw RGB trace offline, with zero-phase filtering.
 * Use this on an exported session to get a cleaner result than the real-time
 * pass can produce (filtfilt has no phase lag, and the whole record is known).
 *
 * @param {Array<{t:number,r:number,g:number,b:number}>} frames
 * @returns {{fs:number, t:Float64Array, pulse:Float64Array, bpm:number, snrDb:number, beats:number[]}}
 */
export function reanalyse(frames, options = {}) {
  const opt = { ...DEFAULTS, ...options };
  const { fs } = opt;
  const loHz = opt.minBpm / 60;
  const hiHz = opt.maxBpm / 60;

  // Size the history to the actual recording, with a little slack.
  const t0 = frames[0].t;
  const durationSec = Math.max(1, frames.at(-1).t - t0) + 2;
  const ext = new WindowedExtractor({ fs, method: opt.method, windowSec: opt.windowSec, capacitySec: durationSec });
  const step = 1 / fs;
  const ts = [];
  let gridT = 0;
  for (let i = 1; i < frames.length; i++) {
    const p = frames[i - 1];
    const c = frames[i];
    const gap = c.t - p.t;
    if (gap <= 0) continue;
    while (gridT <= c.t - t0 + 1e-9) {
      const a = clamp((gridT - (p.t - t0)) / gap, 0, 1);
      ext.push(
        p.r + (c.r - p.r) * a,
        p.g + (c.g - p.g) * a,
        p.b + (c.b - p.b) * a,
      );
      ts.push(gridT);
      gridT += step;
    }
  }

  const raw = ext.history(ext.count);
  const pulse = filtfilt(designButterworthBandpass(2, loHz, hiHz, fs), detrend(raw));
  const { freqs, psd } = welch(pulse, fs, { segment: Math.min(pulse.length, Math.round(8 * fs)), overlap: 0.75 });
  const peak = bandPeak(freqs, psd, loHz, hiHz);

  const minDist = Math.round((60 / opt.maxBpm) * fs);
  const sd = stdOf(pulse);
  const peaks = findPeaks(pulse, { minDistance: minDist, minHeight: 0.3 * sd })
    .map((i) => refinePeak(pulse, i) / fs);

  return {
    fs,
    t: Float64Array.from(ts),
    pulse,
    spectrum: { freqs, psd },
    bpm: peak ? peak.freq * 60 : null,
    snrDb: peak ? peak.snrDb : null,
    beats: peaks,
  };
}
