// ROI sampling: turning the pixels inside the box into one RGB triple.
//
// The subtlety here is not which pixels are skin. It is that *the same* pixels
// must stay in the average from frame to frame.
//
// A hard threshold recomputed per frame silently modulates the pixel set:
// boundary pixels flip in and out, and because those pixels sit tens of
// intensity units away from the ROI mean, a handful of them entering the
// average moves it by around a whole unit. A blood volume pulse moves it by a
// tenth of that. Worse, the flipping is coherent - a threshold that shifts
// moves a whole band of pixels at once - so it does not average away and it is
// broadband in time, which smears it across the entire search band.
//
// So: soft membership weights instead of in/out decisions, and thresholds
// carried by a slow EMA instead of recomputed from each frame. A pixel drifting
// near the boundary then changes the average by a sliver of a pixel's worth,
// not by its full value.

const WEIGHT_EPS = 1e-6;

/** Hermite ramp from 0 at `a` to 1 at `b`. */
function smoothstep(a, b, x) {
  if (b <= a) return x < a ? 0 : 1;
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// Luminance bounds as a fraction of the ROI's own median, which is what keeps
// this working across skin tones: hair, brows and shadow are a fraction of the
// brightness of the face they sit on, whatever that face's brightness is, and
// specular glints are well above it.
const LUMA_FLOOR = 0.6;
const LUMA_CEIL = 1.5;
const LUMA_SOFT = 9;     // ramp width in intensity units
const CHROMA_SOFT = 7;   // ramp width in Cb/Cr units

export class RoiSampler {
  /**
   * @param {object} [o]
   * @param {number} [o.thresholdAlpha] EMA rate for the luma thresholds. The
   *   default is about a 1.5 s time constant at 25 fps: slow enough that the
   *   threshold does not follow the pulse, fast enough to track a lighting change.
   */
  constructor({ thresholdAlpha = 0.025 } = {}) {
    this.thresholdAlpha = thresholdAlpha;
    this.hist = new Uint32Array(256);
    this.reset();
  }

  reset() {
    this.medEma = null;
    this.prevWeights = null;
    this.prevLuma = null;
    this.maskChurn = 0;
  }

  /**
   * @param {Uint8ClampedArray} data RGBA pixels of the ROI, row-major
   * @param {number} count number of pixels (data.length / 4)
   * @param {boolean} useSkinMask
   * @returns {{r,g,b,roiFill,clipping,motion,maskChurn}}
   */
  sample(data, count, useSkinMask = true) {
    const hist = this.hist;
    hist.fill(0);
    let lumaSum = 0;
    let clipped = 0;

    for (let i = 0, p = 0; p < count; i += 4, p++) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      lumaSum += y;
      hist[y | 0]++;
      if (r >= 253 || g >= 253 || b >= 253 || (r < 12 && g < 12 && b < 12)) clipped++;
    }

    // The median is robust to whatever fraction of the box is hair, but it is
    // still a per-frame quantity, so it feeds an EMA rather than the threshold
    // directly. This is the part that stops the threshold from jittering the
    // pixel set.
    const med = this._median(count);
    this.medEma = this.medEma === null ? med : this.medEma + this.thresholdAlpha * (med - this.medEma);
    const floor = this.medEma * LUMA_FLOOR;
    const ceil = Math.min(250, this.medEma * LUMA_CEIL);

    if (!this.prevWeights || this.prevWeights.length !== count) {
      this.prevWeights = new Float32Array(count);
      this.prevWeights.fill(useSkinMask ? -1 : 1);
    }

    let sr = 0;
    let sg = 0;
    let sb = 0;
    let wsum = 0;
    let churn = 0;
    const prev = this.prevWeights;

    for (let i = 0, p = 0; p < count; i += 4, p++) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      let w = 1;

      if (useSkinMask) {
        const y = 0.299 * r + 0.587 * g + 0.114 * b;
        w = smoothstep(floor - LUMA_SOFT, floor + LUMA_SOFT, y)
          * (1 - smoothstep(ceil - LUMA_SOFT, ceil + LUMA_SOFT, y));
        if (w > WEIGHT_EPS) w *= skinChromaWeight(r, g, b);
      }

      if (prev[p] >= 0) churn += Math.abs(w - prev[p]);
      prev[p] = w;

      if (w > WEIGHT_EPS) {
        sr += r * w;
        sg += g * w;
        sb += b * w;
        wsum += w;
      }
    }

    // How much of the frame-to-frame change comes from the mask rather than
    // from the scene. This is the number that exposes the failure above: if it
    // is not far below the pulse amplitude, the mask is the signal.
    this.maskChurn = count ? churn / count : 0;

    const roiFill = count ? wsum / count : 0;

    // If the gate finds almost nothing (bad light, box off the face) fall back
    // to the plain average rather than emit nothing. The low roiFill is what
    // tells the user why their confidence is poor.
    if (wsum < count * 0.08) {
      sr = sg = sb = 0;
      for (let i = 0, p = 0; p < count; i += 4, p++) {
        sr += data[i];
        sg += data[i + 1];
        sb += data[i + 2];
      }
      wsum = count;
    }

    const luma = count ? lumaSum / count : 0;
    const motion = this.prevLuma === null ? 0 : Math.abs(luma - this.prevLuma) / (luma || 1);
    this.prevLuma = luma;

    return {
      r: sr / wsum,
      g: sg / wsum,
      b: sb / wsum,
      roiFill,
      clipping: count ? clipped / count : 0,
      motion,
      maskChurn: this.maskChurn,
    };
  }

  _median(count) {
    let seen = 0;
    for (let i = 0; i < 256; i++) {
      seen += this.hist[i];
      if (seen >= count / 2) return i;
    }
    return 128;
  }
}

/**
 * Soft version of the YCbCr skin gate (Chai & Ngan). Ramps rather than steps,
 * for the same reason as the luminance gate: a pixel wandering across a
 * boundary should nudge the average, not jump it.
 *
 * The chrominance test is largely independent of skin tone because it looks at
 * hue rather than brightness. On its own it is not enough - under warm indoor
 * light dark hair and eyebrows land inside these bounds too - which is why the
 * caller pairs it with the luminance gate.
 */
export function skinChromaWeight(r, g, b) {
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  const m = CHROMA_SOFT;
  let w = smoothstep(77 - m, 77 + m, cb) * (1 - smoothstep(133 - m, 133 + m, cb));
  if (w <= WEIGHT_EPS) return 0;
  w *= smoothstep(133 - m, 133 + m, cr) * (1 - smoothstep(180 - m, 180 + m, cr));
  if (w <= WEIGHT_EPS) return 0;
  return w * smoothstep(8 - m, 8 + m, cr - cb) * (r > b ? 1 : 0);
}
