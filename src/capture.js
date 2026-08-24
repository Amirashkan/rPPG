// Camera capture and ROI colour extraction.
//
// Per frame we downscale the video into a small offscreen canvas, average the
// skin-coloured pixels inside the ROI, and report a few quality figures. The
// downscale is the whole performance story: averaging 160x120 pixels costs
// nothing, and the mean is identical to averaging the full-resolution frame.

const WORK_W = 192;
const WORK_H = 144;

/** Default ROI as a fraction of the frame: forehead + upper cheeks. */
export const DEFAULT_ROI = { x: 0.34, y: 0.18, w: 0.32, h: 0.30 };

/**
 * Chrominance half of the skin gate (Chai & Ngan). Illumination-tolerant and
 * largely independent of skin tone, because it looks at hue rather than
 * brightness.
 *
 * On its own it is not enough: under warm indoor light dark hair and eyebrows
 * land inside these bounds too, which is why the caller pairs it with the
 * luminance gate below.
 */
function skinChroma(r, g, b) {
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  return cb >= 77 && cb <= 133 && cr >= 133 && cr <= 180 && cr - cb > 8 && r > b;
}

// Luminance bounds as a fraction of the ROI's median, which is what makes this
// work across skin tones: hair, eyebrows and shadow are a fraction of the
// brightness of the face they sit on, whatever that face's brightness is, and
// specular glints off skin or glasses are well above it.
const LUMA_FLOOR = 0.6;
const LUMA_CEIL = 1.5;

/** Median luminance of the ROI, via a 256-bin histogram. */
function medianLuma(hist, count) {
  let seen = 0;
  for (let i = 0; i < 256; i++) {
    seen += hist[i];
    if (seen >= count / 2) return i;
  }
  return 128;
}

export class Capture {
  /** @param {object} [o] @param {HTMLVideoElement} [o.video] element to render into */
  constructor({ video } = {}) {
    this.video = video ?? document.createElement('video');
    this.video.playsInline = true;
    this.video.muted = true;

    this.canvas = document.createElement('canvas');
    this.canvas.width = WORK_W;
    this.canvas.height = WORK_H;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });

    this.roi = { ...DEFAULT_ROI };
    this.useSkinMask = true;
    this.stream = null;
    this.prevLuma = null;
    this.running = false;
    this.onFrame = null;
    this._handle = null;
    this.detector = null;
    this.autoRoi = false;
    this._lastDetect = 0;
    this.faceBox = null;
    this.devices = [];
  }

  async listDevices() {
    const all = await navigator.mediaDevices.enumerateDevices();
    this.devices = all.filter((d) => d.kind === 'videoinput');
    return this.devices;
  }

  /**
   * @param {object} [o]
   * @param {string} [o.deviceId]
   * @param {number} [o.fps] requested camera frame rate
   */
  async start({ deviceId, fps = 30, width = 640, height = 480 } = {}) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser exposes no camera API. Use a recent Chrome, Edge, Firefox or Safari over https:// or localhost.');
    }
    this.stop();

    // Auto-exposure and auto-white-balance actively fight rPPG: they modulate
    // the very signal we measure. Ask the camera to hold them still where the
    // browser allows it.
    const constraints = {
      audio: false,
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: width },
        height: { ideal: height },
        frameRate: { ideal: fps },
        resizeMode: 'none',
        // Non-standard but widely honoured; ignored when unsupported.
        exposureMode: 'manual',
        whiteBalanceMode: 'manual',
        focusMode: 'manual',
      },
    };

    try {
      this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      if (err.name === 'OverconstrainedError') {
        // Retry without the advisory constraints.
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: width }, height: { ideal: height } },
        });
      } else {
        throw err;
      }
    }

    this.video.srcObject = this.stream;
    await this.video.play();
    await this.listDevices();

    if ('FaceDetector' in window) {
      try {
        this.detector = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 1 });
      } catch { this.detector = null; }
    }

    this.running = true;
    this.prevLuma = null;
    this._loop();
    return this.settings();
  }

  settings() {
    const track = this.stream?.getVideoTracks()[0];
    const s = track?.getSettings?.() ?? {};
    return {
      label: track?.label ?? null,
      width: s.width ?? this.video.videoWidth,
      height: s.height ?? this.video.videoHeight,
      frameRate: s.frameRate ?? null,
      deviceId: s.deviceId ?? null,
      faceDetector: !!this.detector,
    };
  }

  stop() {
    this.running = false;
    if (this._handle) {
      if (this.video.cancelVideoFrameCallback && this._handleKind === 'rvfc') {
        this.video.cancelVideoFrameCallback(this._handle);
      } else {
        cancelAnimationFrame(this._handle);
      }
      this._handle = null;
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  // requestVideoFrameCallback gives one callback per *decoded* frame with an
  // accurate presentation timestamp. rAF is the fallback and can double-sample
  // a frame, which the pipeline's monotonic-time guard then discards.
  _loop() {
    if (!this.running) return;
    if (this.video.requestVideoFrameCallback) {
      this._handleKind = 'rvfc';
      this._handle = this.video.requestVideoFrameCallback((now, meta) => {
        this._grab(meta.mediaTime ?? now / 1000);
        this._loop();
      });
    } else {
      this._handleKind = 'raf';
      this._handle = requestAnimationFrame((now) => {
        this._grab(now / 1000);
        this._loop();
      });
    }
  }

  async _maybeDetectFace(tSec) {
    if (!this.autoRoi || !this.detector || tSec - this._lastDetect < 0.5) return;
    this._lastDetect = tSec;
    try {
      const faces = await this.detector.detect(this.video);
      const f = faces[0];
      if (!f) return;
      const vw = this.video.videoWidth || 1;
      const vh = this.video.videoHeight || 1;
      const bb = f.boundingBox;
      this.faceBox = { x: bb.x / vw, y: bb.y / vh, w: bb.width / vw, h: bb.height / vh };
      // Forehead + upper cheeks: the least motion-contaminated skin available.
      const target = {
        x: this.faceBox.x + this.faceBox.w * 0.22,
        y: this.faceBox.y + this.faceBox.h * 0.12,
        w: this.faceBox.w * 0.56,
        h: this.faceBox.h * 0.38,
      };
      // Smooth the box so ROI jitter does not inject motion into the signal.
      const k = 0.25;
      for (const key of ['x', 'y', 'w', 'h']) this.roi[key] += k * (target[key] - this.roi[key]);
    } catch { /* detection is best-effort */ }
  }

  _grab(tSec) {
    const vw = this.video.videoWidth;
    if (!vw) return;

    this.ctx.drawImage(this.video, 0, 0, WORK_W, WORK_H);
    const x0 = Math.max(0, Math.round(this.roi.x * WORK_W));
    const y0 = Math.max(0, Math.round(this.roi.y * WORK_H));
    const w = Math.max(1, Math.min(WORK_W - x0, Math.round(this.roi.w * WORK_W)));
    const h = Math.max(1, Math.min(WORK_H - y0, Math.round(this.roi.h * WORK_H)));
    const img = this.ctx.getImageData(x0, y0, w, h);
    const d = img.data;
    const total = w * h;

    // Pass 1: luminance distribution and exposure problems.
    const hist = this._hist ?? (this._hist = new Uint32Array(256));
    hist.fill(0);
    let lumaSum = 0;
    let clipped = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      lumaSum += y;
      hist[y | 0]++;
      if (r >= 253 || g >= 253 || b >= 253 || (r < 12 && g < 12 && b < 12)) clipped++;
    }

    // Pass 2: average the pixels that are actually perfused skin.
    const med = medianLuma(hist, total);
    const floor = med * LUMA_FLOOR;
    const ceil = Math.min(250, med * LUMA_CEIL);

    let sr = 0;
    let sg = 0;
    let sb = 0;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];
      if (this.useSkinMask) {
        const y = 0.299 * r + 0.587 * g + 0.114 * b;
        if (y < floor || y > ceil) continue;      // hair, brows, shadow, glints
        if (!skinChroma(r, g, b)) continue;
      }
      sr += r;
      sg += g;
      sb += b;
      n++;
    }

    // If the gate rejects nearly everything (bad lighting, the ROI off the
    // face) fall back to the plain box average rather than emit nothing. The
    // low roiFill is what tells the user why their confidence is poor.
    const roiFill = n / total;
    if (n < total * 0.08) {
      sr = sg = sb = 0;
      n = 0;
      for (let i = 0; i < d.length; i += 4) {
        sr += d[i];
        sg += d[i + 1];
        sb += d[i + 2];
        n++;
      }
    }

    // Frame-to-frame luma change inside the ROI: a proxy for head motion.
    const luma = lumaSum / total;
    const motion = this.prevLuma === null ? 0 : Math.abs(luma - this.prevLuma) / (luma || 1);
    this.prevLuma = luma;

    this._maybeDetectFace(tSec);

    this.onFrame?.({
      t: tSec,
      r: sr / n,
      g: sg / n,
      b: sb / n,
      quality: { roiFill, motion, clipping: clipped / total },
      roi: { ...this.roi },
    });
  }
}
