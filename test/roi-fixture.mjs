// Fixtures for the ROI sampling tests: a synthetic patch of forehead, and the
// previous masking implementation to compare against.

import { welch, bandPeak, detrend } from '../src/dsp.js';

const W = 64;
const H = 48;
export const N = W * H;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A synthetic ROI matching the conditions of the recording that exposed this:
 * a side-lit face in a dim room, so illumination falls off sharply across the
 * forehead, with a soft hairline rather than a hard edge.
 *
 * The shading gradient is the point. It puts a large population of pixels at
 * luminances close to the mask's threshold, which is exactly where a per-frame
 * threshold does its damage - a threshold that moves by a fraction of a unit
 * sweeps a whole band of those pixels in or out of the average at once.
 *
 * The pulse is 0.35 intensity units: realistic, and far smaller than the step
 * a flipping mask produces.
 */
export function makeFrames({ bpm = 72, seconds = 40, fps = 25, pulseAmp = 0.35, noise = 0.8, seed = 5 } = {}) {
  const rnd = mulberry32(seed);
  const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) * 1.2;
  const SKIN = [166, 124, 102];
  const HAIR = [58, 44, 38];
  const SIG = [0.33, 0.77, 0.53];

  // Fixed per-pixel offsets: real skin is not uniform.
  // `hair` is fractional so the hairline blends over several pixels, as it does
  // once a frame has been downscaled to the work canvas.
  const offs = new Float64Array(N);
  const hair = new Float64Array(N);
  const shade = new Float64Array(N);
  for (let p = 0; p < N; p++) {
    const x = p % W;
    const y = (p / W) | 0;
    offs[p] = gauss() * 4;
    // Soft hairline sweeping down the left, and brows blending in at the bottom.
    const dHair = (x / W) * 1.6 + (y / H) * 0.5 - 0.42;
    const dBrow = (y / H - 0.84) * 6;
    hair[p] = Math.max(
      Math.min(1, Math.max(0, -dHair * 3)),
      Math.min(1, Math.max(0, dBrow)),
    );
    // Light from one side: the far edge of the forehead falls to about half
    // brightness, so plenty of skin sits near the luminance floor.
    shade[p] = 0.42 + 0.58 * Math.min(1, Math.max(0, 1.25 - (x / W) * 0.55 - (y / H) * 0.75));
  }

  const frames = [];
  for (let f = 0; f < seconds * fps; f++) {
    const t = f / fps;
    const pulse = Math.sin(2 * Math.PI * (bpm / 60) * t) + 0.3 * Math.sin(4 * Math.PI * (bpm / 60) * t);
    const light = 1 + 0.02 * Math.sin(2 * Math.PI * 0.09 * t);
    const data = new Uint8ClampedArray(N * 4);
    for (let p = 0; p < N; p++) {
      const k = hair[p];
      for (let c = 0; c < 3; c++) {
        const base = (SKIN[c] * (1 - k) + HAIR[c] * k) * shade[p];
        const bvp = (1 - k) * pulseAmp * SIG[c] * pulse;
        data[p * 4 + c] = base * light + offs[p] + bvp + noise * gauss();
      }
      data[p * 4 + 3] = 255;
    }
    frames.push({ t, data });
  }
  return frames;
}

/** The previous implementation: hard in/out, threshold recomputed every frame. */
export function legacySample(data, count) {
  const hist = new Uint32Array(256);
  for (let i = 0, p = 0; p < count; i += 4, p++) {
    hist[(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) | 0]++;
  }
  let seen = 0;
  let med = 128;
  for (let i = 0; i < 256; i++) {
    seen += hist[i];
    if (seen >= count / 2) { med = i; break; }
  }
  const floor = med * 0.6;
  const ceil = Math.min(250, med * 1.5);
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let n = 0;
  for (let i = 0, p = 0; p < count; i += 4, p++) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    if (y < floor || y > ceil) continue;
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    if (!(cb >= 77 && cb <= 133 && cr >= 133 && cr <= 180 && cr - cb > 8 && r > b)) continue;
    sr += r; sg += g; sb += b; n++;
  }
  return { r: sr / n, g: sg / n, b: sb / n, roiFill: n / count };
}

/** Pulse-band SNR of a green-channel trace. */
export function traceSnr(green, fps, bpm) {
  const x = detrend(Float64Array.from(green));
  const { freqs, psd } = welch(x, fps, { segment: Math.round(10 * fps), overlap: 0.75 });
  const peak = bandPeak(freqs, psd, 0.7, 3.5);
  return { snrDb: peak.snrDb, bpm: peak.freq * 60 };
}

