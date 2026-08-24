// Signal-processing primitives for rPPG.
// Dependency-free, runs identically in the browser and in Node (used by the tests).

// ---------------------------------------------------------------- windows ---

export function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

export function nextPow2(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

// -------------------------------------------------------------------- fft ---

// In-place iterative radix-2 FFT. `re`/`im` must have a power-of-two length.
export function fft(re, im) {
  const n = re.length;
  if (n !== im.length) throw new Error('fft: re/im length mismatch');
  if ((n & (n - 1)) !== 0) throw new Error('fft: length must be a power of two');

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

// Inverse FFT (in place).
export function ifft(re, im) {
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fft(re, im);
  for (let i = 0; i < n; i++) {
    re[i] /= n;
    im[i] = -im[i] / n;
  }
}

// -------------------------------------------------------------- spectrum ---

/**
 * One-sided power spectral density of `x` via a windowed periodogram.
 * @returns {{freqs: Float64Array, psd: Float64Array, df: number}}
 */
export function periodogram(x, fs, { nfft = nextPow2(x.length * 4) } = {}) {
  const n = x.length;
  const w = hann(n);
  let wss = 0;
  for (let i = 0; i < n; i++) wss += w[i] * w[i];

  const re = new Float64Array(nfft);
  const im = new Float64Array(nfft);
  const mean = meanOf(x);
  for (let i = 0; i < n; i++) re[i] = (x[i] - mean) * w[i];
  fft(re, im);

  const half = nfft / 2 + 1;
  const psd = new Float64Array(half);
  const freqs = new Float64Array(half);
  const scale = 1 / (fs * wss);
  for (let k = 0; k < half; k++) {
    const p = (re[k] * re[k] + im[k] * im[k]) * scale;
    psd[k] = k === 0 || k === half - 1 ? p : 2 * p;
    freqs[k] = (k * fs) / nfft;
  }
  return { freqs, psd, df: fs / nfft };
}

/** Welch PSD: averaged periodograms over overlapping segments. */
export function welch(x, fs, { segment = Math.min(x.length, Math.round(fs * 6)), overlap = 0.5, nfft } = {}) {
  const seg = Math.min(segment, x.length);
  const step = Math.max(1, Math.round(seg * (1 - overlap)));
  const nf = nfft ?? nextPow2(seg * 4);
  let acc = null;
  let freqs = null;
  let count = 0;
  for (let start = 0; start + seg <= x.length; start += step) {
    const { freqs: f, psd } = periodogram(x.subarray ? x.subarray(start, start + seg) : x.slice(start, start + seg), fs, { nfft: nf });
    if (!acc) {
      acc = new Float64Array(psd.length);
      freqs = f;
    }
    for (let i = 0; i < psd.length; i++) acc[i] += psd[i];
    count++;
  }
  if (!count) return periodogram(x, fs, { nfft: nf });
  for (let i = 0; i < acc.length; i++) acc[i] /= count;
  return { freqs, psd: acc, df: fs / nf };
}

/**
 * Locate the dominant spectral peak inside [loHz, hiHz] with parabolic
 * sub-bin interpolation, and score it against the rest of the band.
 * @returns {{freq:number, power:number, snrDb:number, bandPower:number}|null}
 */
export function bandPeak(freqs, psd, loHz, hiHz, { harmonicHalfWidth = 0.15 } = {}) {
  let best = -1;
  let bestP = -Infinity;
  for (let k = 1; k < psd.length - 1; k++) {
    if (freqs[k] < loHz || freqs[k] > hiHz) continue;
    if (psd[k] > bestP) {
      bestP = psd[k];
      best = k;
    }
  }
  if (best < 1) return null;

  // Parabolic interpolation in log-magnitude for sub-bin resolution.
  const l = Math.log(psd[best - 1] + 1e-30);
  const c = Math.log(psd[best] + 1e-30);
  const r = Math.log(psd[best + 1] + 1e-30);
  let delta = (0.5 * (l - r)) / (l - 2 * c + r || 1e-30);
  if (!Number.isFinite(delta) || Math.abs(delta) > 0.5) delta = 0;
  const df = freqs[1] - freqs[0];
  const freq = freqs[best] + delta * df;

  // SNR: power near the fundamental and its first harmonic vs. the rest of the band.
  let sig = 0;
  let noise = 0;
  for (let k = 0; k < psd.length; k++) {
    const f = freqs[k];
    if (f < loHz || f > hiHz * 2 + harmonicHalfWidth) continue;
    const nearF0 = Math.abs(f - freq) <= harmonicHalfWidth;
    const nearH1 = Math.abs(f - 2 * freq) <= harmonicHalfWidth;
    if (nearF0 || nearH1) sig += psd[k];
    else noise += psd[k];
  }
  const snrDb = 10 * Math.log10((sig + 1e-30) / (noise + 1e-30));

  let bandPower = 0;
  for (let k = 0; k < psd.length; k++) if (freqs[k] >= loHz && freqs[k] <= hiHz) bandPower += psd[k];

  return { freq, power: psd[best], snrDb, bandPower };
}

// --------------------------------------------------------------- filters ---

// A biquad section in transposed direct form II.
export class Biquad {
  constructor(b0, b1, b2, a1, a2) {
    Object.assign(this, { b0, b1, b2, a1, a2 });
    this.z1 = 0;
    this.z2 = 0;
  }
  reset(x = 0) {
    // Steady-state initial conditions for a constant input `x`, so the filter
    // does not ring on startup.
    const gain = (this.b0 + this.b1 + this.b2) / (1 + this.a1 + this.a2);
    const y = gain * x;
    this.z1 = this.b1 * x - this.a1 * y + (this.b2 * x - this.a2 * y);
    this.z2 = this.b2 * x - this.a2 * y;
  }
  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
}

// Minimal complex helpers for the pole/zero design below.
const cAdd = (a, b) => [a[0] + b[0], a[1] + b[1]];
const cSub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const cMul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const cDiv = (a, b) => {
  const d = b[0] * b[0] + b[1] * b[1];
  return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d];
};
const cSqrt = (a) => {
  const m = Math.hypot(a[0], a[1]);
  const r = Math.sqrt((m + a[0]) / 2);
  let i = Math.sqrt((m - a[0]) / 2);
  if (a[1] < 0) i = -i;
  return [r, i];
};

/**
 * Digital Butterworth band-pass as a cascade of biquads (bilinear transform of
 * the analog prototype, with frequency pre-warping).
 * @param {number} order analog prototype order; the band-pass is twice that.
 */
export function designButterworthBandpass(order, loHz, hiHz, fs) {
  const k = 2 * fs;
  const wLo = k * Math.tan((Math.PI * loHz) / fs);
  const wHi = k * Math.tan((Math.PI * hiHz) / fs);
  const bw = wHi - wLo;
  const w0sq = wLo * wHi;

  // Every analog prototype pole maps to *two* band-pass poles, the roots of
  // s^2 - p*bw*s + w0^2, so an order-N prototype yields 2N poles.
  const sPoles = [];
  for (let i = 0; i < order; i++) {
    const theta = (Math.PI * (2 * i + order + 1)) / (2 * order);
    const p = [Math.cos(theta), Math.sin(theta)];
    const pbw = [p[0] * bw, p[1] * bw];
    const disc = cSqrt(cSub(cMul(pbw, pbw), [4 * w0sq, 0]));
    sPoles.push([(pbw[0] + disc[0]) / 2, (pbw[1] + disc[1]) / 2]);
    sPoles.push([(pbw[0] - disc[0]) / 2, (pbw[1] - disc[1]) / 2]);
  }

  // Bilinear transform: z = (k + s) / (k - s).
  const zPoles = sPoles.map((s) => cDiv(cAdd([k, 0], s), cSub([k, 0], s)));

  // Group the (conjugate-symmetric) pole set into real second-order sections.
  // Zeros of a band-pass land at z = +1 and z = -1, one of each per section.
  const used = new Array(zPoles.length).fill(false);
  const sections = [];
  for (let i = 0; i < zPoles.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const zi = zPoles[i];
    let best = -1;
    let bestD = Infinity;
    for (let j = 0; j < zPoles.length; j++) {
      if (used[j]) continue;
      const d = Math.hypot(zPoles[j][0] - zi[0], zPoles[j][1] + zi[1]);
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
    if (best < 0) throw new Error('designButterworthBandpass: unpaired pole');
    used[best] = true;
    const zj = zPoles[best];
    const prod = cMul(zi, zj);
    sections.push(new Biquad(1, 0, -1, -(zi[0] + zj[0]), prod[0]));
  }

  // Normalise the cascade to unit gain at the geometric centre frequency.
  const fc = Math.sqrt(loHz * hiHz);
  const g = cascadeGain(sections, fc, fs);
  if (g > 0) {
    const s0 = sections[0];
    sections[0] = new Biquad(s0.b0 / g, s0.b1 / g, s0.b2 / g, s0.a1, s0.a2);
  }
  return sections;
}

/** |H(f)| of a biquad cascade. */
export function cascadeGain(sections, f, fs) {
  const w = (2 * Math.PI * f) / fs;
  const z = [Math.cos(-w), Math.sin(-w)];       // z^-1
  const z2 = cMul(z, z);                        // z^-2
  let acc = [1, 0];
  for (const s of sections) {
    const num = cAdd(cAdd([s.b0, 0], [s.b1 * z[0], s.b1 * z[1]]), [s.b2 * z2[0], s.b2 * z2[1]]);
    const den = cAdd(cAdd([1, 0], [s.a1 * z[0], s.a1 * z[1]]), [s.a2 * z2[0], s.a2 * z2[1]]);
    acc = cMul(acc, cDiv(num, den));
  }
  return Math.hypot(acc[0], acc[1]);
}

/** Streaming filter over a biquad cascade. */
export class IIRFilter {
  constructor(sections) {
    this.sections = sections;
    this.primed = false;
  }
  reset(x = 0) {
    for (const s of this.sections) s.reset(x);
    this.primed = true;
  }
  process(x) {
    if (!this.primed) this.reset(x);
    let y = x;
    for (const s of this.sections) y = s.process(y);
    return y;
  }
}

/** Zero-phase offline filtering (forward + reverse), for exported records. */
export function filtfilt(sections, x) {
  const clone = () => sections.map((s) => new Biquad(s.b0, s.b1, s.b2, s.a1, s.a2));
  const pad = Math.min(x.length - 1, 3 * sections.length * 2);
  const ext = new Float64Array(x.length + 2 * pad);
  for (let i = 0; i < pad; i++) {
    ext[i] = 2 * x[0] - x[pad - i];
    ext[ext.length - 1 - i] = 2 * x[x.length - 1] - x[x.length - 1 - (pad - i)];
  }
  ext.set(x, pad);

  const fwd = new IIRFilter(clone());
  fwd.reset(ext[0]);
  const y = new Float64Array(ext.length);
  for (let i = 0; i < ext.length; i++) y[i] = fwd.process(ext[i]);

  const rev = new IIRFilter(clone());
  rev.reset(y[y.length - 1]);
  const z = new Float64Array(ext.length);
  for (let i = ext.length - 1; i >= 0; i--) z[i] = rev.process(y[i]);

  return z.slice(pad, pad + x.length);
}

// ------------------------------------------------------------ statistics ---

export function meanOf(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i];
  return x.length ? s / x.length : 0;
}

export function stdOf(x, mean = meanOf(x)) {
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    const d = x[i] - mean;
    s += d * d;
  }
  return x.length > 1 ? Math.sqrt(s / (x.length - 1)) : 0;
}

/** Remove the least-squares straight line from `x` (in place on a copy). */
export function detrend(x) {
  const n = x.length;
  const out = new Float64Array(n);
  if (n < 2) return out;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += x[i];
    sxx += i * i;
    sxy += i * x[i];
  }
  const denom = n * sxx - sx * sx;
  const slope = denom ? (n * sxy - sx * sy) / denom : 0;
  const icept = (sy - slope * sx) / n;
  for (let i = 0; i < n; i++) out[i] = x[i] - (slope * i + icept);
  return out;
}

// ----------------------------------------------------------- resampling ----

/**
 * Resample irregularly-timed samples onto a uniform grid by linear
 * interpolation. Webcam frame timestamps jitter enough to smear the spectrum,
 * so everything downstream works on this uniform timeline.
 * @param {number[]|Float64Array} t monotonically increasing timestamps (s)
 * @param {number[]|Float64Array} v values
 * @param {number} fs target rate (Hz)
 * @param {number} [t0] grid start; defaults to t[0]
 */
export function resampleUniform(t, v, fs, t0 = t[0]) {
  const n = t.length;
  if (n === 0) return { t0, values: new Float64Array(0) };
  const dur = t[n - 1] - t0;
  const count = Math.max(0, Math.floor(dur * fs) + 1);
  const out = new Float64Array(count);
  let j = 0;
  for (let i = 0; i < count; i++) {
    const tt = t0 + i / fs;
    while (j < n - 2 && t[j + 1] < tt) j++;
    const t1 = t[j];
    const t2 = t[j + 1] ?? t1;
    const a = t2 === t1 ? 0 : (tt - t1) / (t2 - t1);
    out[i] = v[j] + (( v[j + 1] ?? v[j]) - v[j]) * Math.max(0, Math.min(1, a));
  }
  return { t0, values: out };
}

// -------------------------------------------------------- peak detection ---

/**
 * Local maxima of `x` separated by at least `minDistance` samples, keeping the
 * tallest peak in each contested neighbourhood.
 * @returns {number[]} indices, ascending
 */
export function findPeaks(x, { minDistance = 1, minHeight = -Infinity } = {}) {
  const cand = [];
  for (let i = 1; i < x.length - 1; i++) {
    if (x[i] >= x[i - 1] && x[i] > x[i + 1] && x[i] >= minHeight) cand.push(i);
  }
  cand.sort((a, b) => x[b] - x[a]);
  const taken = [];
  for (const i of cand) {
    if (taken.every((j) => Math.abs(i - j) >= minDistance)) taken.push(i);
  }
  return taken.sort((a, b) => a - b);
}

/** Sub-sample peak location refined by fitting a parabola to its neighbours. */
export function refinePeak(x, i) {
  if (i <= 0 || i >= x.length - 1) return i;
  const d = (0.5 * (x[i - 1] - x[i + 1])) / (x[i - 1] - 2 * x[i] + x[i + 1] || 1e-30);
  return Number.isFinite(d) && Math.abs(d) <= 0.5 ? i + d : i;
}
