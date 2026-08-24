// Synthetic camera-frame generator used by the tests.
//
// Models what a skin ROI mean actually looks like: a large DC skin colour, a
// slow multiplicative illumination drift shared by all channels (this is the
// term the chrominance methods must cancel), a small blood-volume-pulse term
// with the standard [0.33, 0.77, 0.53] channel signature, and sensor noise.

const SKIN = [178, 132, 112];
const BVP_SIGNATURE = [0.33, 0.77, 0.53];

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
 * @param {object} o
 * @param {number} o.bpm heart rate
 * @param {number} o.seconds duration
 * @param {number} [o.fps] nominal frame rate
 * @param {number} [o.jitter] timestamp jitter as a fraction of the frame period
 * @param {number} [o.pulseAmp] BVP amplitude in intensity units (~0.5-2 typical)
 * @param {number} [o.noise] per-channel gaussian-ish noise sigma
 * @param {number} [o.illum] amplitude of the shared illumination drift
 */
export function synthFrames({
  bpm = 72, seconds = 30, fps = 30, jitter = 0.15,
  pulseAmp = 1.0, noise = 0.4, illum = 6, seed = 12345, rrVariability = 0.02,
} = {}) {
  const rnd = mulberry32(seed);
  const gauss = () => (rnd() + rnd() + rnd() + rnd() - 2) * 1.2;

  const frames = [];
  const dt = 1 / fps;
  let t = 0;
  let phase = 0;
  const f0 = bpm / 60;

  while (t < seconds) {
    // Respiratory-ish rate modulation so the signal is not a pure tone.
    const f = f0 * (1 + rrVariability * Math.sin(2 * Math.PI * 0.25 * t));
    phase += 2 * Math.PI * f * dt;

    // A PPG beat is asymmetric: sharp systolic upstroke, dicrotic shoulder.
    const p = Math.sin(phase) + 0.35 * Math.sin(2 * phase - 0.6) + 0.12 * Math.sin(3 * phase);

    // Shared illumination drift + slow specular wobble (multiplicative).
    const light = 1 + (illum / 100) * (Math.sin(2 * Math.PI * 0.07 * t) + 0.5 * Math.sin(2 * Math.PI * 0.19 * t + 1));

    const rgb = [0, 1, 2].map((c) =>
      SKIN[c] * light + pulseAmp * BVP_SIGNATURE[c] * p + noise * gauss());

    frames.push({
      t: t + (rnd() - 0.5) * jitter * dt,
      r: rgb[0], g: rgb[1], b: rgb[2],
    });
    t += dt;
  }
  // Timestamp jitter can reorder neighbours; the pipeline expects monotonic time.
  frames.sort((a, b) => a.t - b.t);
  return frames;
}
