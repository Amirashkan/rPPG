// Chrominance-based rPPG extraction methods.
//
// All of them take a short window of per-frame mean RGB values from a skin ROI
// and collapse it into a single pulse-bearing trace. They differ in how they
// cancel the specular/motion component that dominates raw camera colour.

import { meanOf, stdOf } from './dsp.js';

/**
 * POS - "Plane-Orthogonal-to-Skin" (Wang et al., 2017).
 * Projects temporally-normalised RGB onto a plane orthogonal to the skin-tone
 * direction, then tunes the two projections against each other. The most
 * robust of the classic methods under illumination change.
 *
 * @param {Float64Array} r window of red means
 * @param {Float64Array} g
 * @param {Float64Array} b
 * @returns {Float64Array} pulse window, zero-mean
 */
export function pos(r, g, b) {
  const n = r.length;
  const mr = meanOf(r) || 1e-9;
  const mg = meanOf(g) || 1e-9;
  const mb = meanOf(b) || 1e-9;

  // S1 = Gn - Bn ; S2 = Gn + Bn - 2*Rn   (P = [[0,1,-1],[-2,1,1]])
  const s1 = new Float64Array(n);
  const s2 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const rn = r[i] / mr;
    const gn = g[i] / mg;
    const bn = b[i] / mb;
    s1[i] = gn - bn;
    s2[i] = gn + bn - 2 * rn;
  }

  const sd2 = stdOf(s2);
  const alpha = sd2 > 1e-12 ? stdOf(s1) / sd2 : 0;

  const h = new Float64Array(n);
  for (let i = 0; i < n; i++) h[i] = s1[i] + alpha * s2[i];
  const mh = meanOf(h);
  for (let i = 0; i < n; i++) h[i] -= mh;
  return h;
}

/**
 * CHROM (de Haan & Jeanne, 2013). Fixed chrominance projection with an
 * adaptive mix; standardised skin-tone assumption baked into the coefficients.
 */
export function chrom(r, g, b) {
  const n = r.length;
  const mr = meanOf(r) || 1e-9;
  const mg = meanOf(g) || 1e-9;
  const mb = meanOf(b) || 1e-9;

  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const rn = r[i] / mr;
    const gn = g[i] / mg;
    const bn = b[i] / mb;
    xs[i] = 3 * rn - 2 * gn;
    ys[i] = 1.5 * rn + gn - 1.5 * bn;
  }

  const sdy = stdOf(ys);
  const alpha = sdy > 1e-12 ? stdOf(xs) / sdy : 0;

  const h = new Float64Array(n);
  for (let i = 0; i < n; i++) h[i] = xs[i] - alpha * ys[i];
  const mh = meanOf(h);
  for (let i = 0; i < n; i++) h[i] -= mh;
  return h;
}

/**
 * GREEN (Verkruysse et al., 2008). Inverted green channel, mean-removed.
 * Simplest possible baseline: haemoglobin absorbs green most strongly, so the
 * green mean dips on each systolic peak. Included for comparison - it is very
 * sensitive to motion and light flicker.
 */
export function green(r, g, b) {
  const n = g.length;
  const mg = meanOf(g) || 1e-9;
  const h = new Float64Array(n);
  for (let i = 0; i < n; i++) h[i] = -(g[i] / mg - 1);
  const mh = meanOf(h);
  for (let i = 0; i < n; i++) h[i] -= mh;
  return h;
}

export const METHODS = { pos, chrom, green };

export const METHOD_INFO = {
  pos: { label: 'POS', cite: 'Wang et al. 2017', note: 'Default. Best all-round robustness.' },
  chrom: { label: 'CHROM', cite: 'de Haan & Jeanne 2013', note: 'Strong under lighting change, assumes standard skin tone.' },
  green: { label: 'GREEN', cite: 'Verkruysse et al. 2008', note: 'Baseline. Motion sensitive.' },
};

/**
 * Sliding-window extractor with overlap-add, as specified by POS.
 *
 * Feed it uniformly-sampled RGB one frame at a time; it maintains the window,
 * runs the chosen method, and accumulates the (zero-meaned) window output into
 * a running pulse trace. Samples within the last window length are only
 * partially accumulated, which is expected and harmless downstream.
 */
export class WindowedExtractor {
  /**
   * @param {object} opts
   * @param {number} opts.fs uniform sample rate (Hz)
   * @param {string} [opts.method] key into METHODS
   * @param {number} [opts.windowSec] analysis window (POS specifies 1.6 s)
   * @param {number} [opts.capacitySec] length of the retained pulse history
   */
  constructor({ fs, method = 'pos', windowSec = 1.6, capacitySec = 60 }) {
    this.fs = fs;
    this.setMethod(method);
    this.win = Math.max(8, Math.round(windowSec * fs));
    this.capacity = Math.max(this.win * 4, Math.round(capacitySec * fs));

    this.r = new Float64Array(this.win);
    this.g = new Float64Array(this.win);
    this.b = new Float64Array(this.win);
    this.head = 0;          // next write index in the RGB ring
    this.filled = 0;        // samples seen since reset (capped at win)

    this.out = new Float64Array(this.capacity); // overlap-add accumulator
    this.count = 0;         // total uniform samples pushed
  }

  setMethod(method) {
    if (!METHODS[method]) throw new Error(`unknown rPPG method: ${method}`);
    this.method = method;
    this.fn = METHODS[method];
  }

  reset() {
    this.r.fill(0);
    this.g.fill(0);
    this.b.fill(0);
    this.out.fill(0);
    this.head = 0;
    this.filled = 0;
    this.count = 0;
  }

  /**
   * @returns {number} the current pulse value (accumulator at the newest index)
   */
  push(r, g, b) {
    this.r[this.head] = r;
    this.g[this.head] = g;
    this.b[this.head] = b;
    this.head = (this.head + 1) % this.win;
    if (this.filled < this.win) this.filled++;

    const idx = this.count % this.capacity;
    this.out[idx] = 0; // this slot is being reused; start its accumulation fresh
    this.count++;

    if (this.filled === this.win) {
      // Unroll the ring into chronological order for the method.
      const wr = new Float64Array(this.win);
      const wg = new Float64Array(this.win);
      const wb = new Float64Array(this.win);
      for (let i = 0; i < this.win; i++) {
        const j = (this.head + i) % this.win;
        wr[i] = this.r[j];
        wg[i] = this.g[j];
        wb[i] = this.b[j];
      }
      const h = this.fn(wr, wg, wb);
      // Overlap-add onto the tail of the output history.
      const first = this.count - this.win; // absolute index of h[0]
      for (let i = 0; i < this.win; i++) {
        const abs = first + i;
        if (abs < 0) continue;
        this.out[abs % this.capacity] += h[i];
      }
    }
    return this.out[idx];
  }

  /** Copy the most recent `n` accumulated pulse samples, oldest first. */
  history(n) {
    const len = Math.min(n, this.count, this.capacity);
    const res = new Float64Array(len);
    for (let i = 0; i < len; i++) {
      const abs = this.count - len + i;
      res[i] = this.out[abs % this.capacity];
    }
    return res;
  }
}
