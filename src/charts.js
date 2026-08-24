// Small canvas plotting helpers. No dependencies, DPR-aware, theme-aware.

function css(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

class Chart {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.w = Math.max(1, Math.round(rect.width));
    this.h = Math.max(1, Math.round(rect.height));
    this.canvas.width = this.w * dpr;
    this.canvas.height = this.h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  clear() {
    this.ctx.clearRect(0, 0, this.w, this.h);
  }

  grid(rows = 4, cols = 6) {
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = css('--grid', '#1e2637');
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < rows; i++) {
      const y = Math.round((this.h * i) / rows) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(this.w, y);
    }
    for (let i = 1; i < cols; i++) {
      const x = Math.round((this.w * i) / cols) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.h);
    }
    ctx.stroke();
    ctx.restore();
  }

  label(text, x, y, { align = 'left', color = css('--muted', '#7c8aa5'), size = 10 } = {}) {
    const { ctx } = this;
    ctx.save();
    ctx.fillStyle = color;
    ctx.font = `${size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textAlign = align;
    ctx.textBaseline = 'top';
    ctx.fillText(text, x, y);
    ctx.restore();
  }
}

/** Scrolling pulse waveform with beat markers. */
export class WaveformChart extends Chart {
  draw({ t, v }, beats = [], { seconds = 10, phase = null, freqHz = 1.2, confidence = 0 } = {}) {
    this.clear();
    this.grid(4, seconds);
    const { ctx } = this;
    if (!t.length) {
      this.label('waiting for camera…', 8, 8);
      return;
    }

    const tEnd = t[t.length - 1];
    const tStart = tEnd - seconds;
    let max = 1e-9;
    for (let i = 0; i < v.length; i++) if (t[i] >= tStart) max = Math.max(max, Math.abs(v[i]));
    const x = (tt) => ((tt - tStart) / seconds) * this.w;
    const y = (vv) => this.h / 2 - (vv / (max * 1.15)) * (this.h / 2 - 6);

    // Beat markers behind the trace.
    ctx.save();
    ctx.strokeStyle = css('--beat', '#f0537d');
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const b of beats) {
      if (b.t < tStart) continue;
      ctx.moveTo(x(b.t), 4);
      ctx.lineTo(x(b.t), this.h - 4);
    }
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = css('--accent', '#4ade80');
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < t.length; i++) {
      if (t[i] < tStart) continue;
      const px = x(t[i]);
      const py = y(v[i]);
      if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.restore();

    if (phase != null && confidence > 0.55) {
      // The tracked phase, drawn as a faint reference oscillation.
      ctx.save();
      ctx.strokeStyle = css('--accent2', '#60a5fa');
      ctx.globalAlpha = 0.22;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let px = 0; px <= this.w; px += 2) {
        const tt = tStart + (px / this.w) * seconds;
        const ph = phase - (tEnd - tt) * 2 * Math.PI * freqHz;
        const py = this.h / 2 - Math.cos(ph) * (this.h / 2 - 6) * 0.55;
        px === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.restore();
    }

    this.label(`${seconds}s window`, 6, 6);
    this.label('pulse (band-passed)', this.w - 6, 6, { align: 'right', color: css('--accent', '#4ade80') });
  }
}

/** Power spectrum with the search band highlighted and the peak marked. */
export class SpectrumChart extends Chart {
  draw(spectrum, { minBpm, maxBpm, bpm, confidence = 0 } = {}) {
    this.clear();
    const { ctx } = this;
    const loBpm = 30;
    const hiBpm = 240;
    const x = (bpmv) => ((bpmv - loBpm) / (hiBpm - loBpm)) * this.w;

    // Search band.
    ctx.save();
    ctx.fillStyle = css('--band', 'rgba(96,165,250,0.08)');
    ctx.fillRect(x(minBpm), 0, x(maxBpm) - x(minBpm), this.h);
    ctx.restore();
    this.grid(3, 7);

    for (let b = 60; b <= 240; b += 60) {
      // Keep the last label inside the canvas rather than half off the edge.
      const px = Math.min(x(b), this.w - 12);
      this.label(String(b), px, this.h - 14, { align: 'center' });
    }

    if (!spectrum) {
      this.label('spectrum: collecting…', 6, 6);
      return;
    }

    const { freqs, psd } = spectrum;
    let max = 1e-30;
    for (let i = 0; i < freqs.length; i++) {
      const bpmv = freqs[i] * 60;
      if (bpmv >= loBpm && bpmv <= hiBpm) max = Math.max(max, psd[i]);
    }

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(0, this.h);
    for (let i = 0; i < freqs.length; i++) {
      const bpmv = freqs[i] * 60;
      if (bpmv < loBpm || bpmv > hiBpm) continue;
      ctx.lineTo(x(bpmv), this.h - (psd[i] / max) * (this.h - 20));
    }
    ctx.lineTo(this.w, this.h);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, this.h);
    grad.addColorStop(0, css('--accent2', '#60a5fa'));
    grad.addColorStop(1, 'transparent');
    ctx.fillStyle = grad;
    ctx.globalAlpha = 0.5;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = css('--accent2', '#60a5fa');
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();

    if (bpm) {
      ctx.save();
      ctx.strokeStyle = css('--beat', '#f0537d');
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x(bpm), 0);
      ctx.lineTo(x(bpm), this.h);
      ctx.stroke();
      ctx.restore();
      this.label(`${bpm.toFixed(1)} bpm`, Math.min(this.w - 6, x(bpm) + 5), 6, { color: css('--beat', '#f0537d') });
    }
    this.label('spectrum (bpm)', 6, 6);
  }
}

/** Heart-rate trend, opacity encoding confidence. */
export class TrendChart extends Chart {
  draw(history, { seconds = 120, minBpm, maxBpm } = {}) {
    this.clear();
    this.grid(4, 6);
    if (!history.length) {
      this.label('trend: collecting…', 6, 6);
      return;
    }
    const { ctx } = this;
    const tEnd = history.at(-1).t;
    const tStart = Math.max(history[0].t, tEnd - seconds);
    const span = Math.max(1, tEnd - tStart);

    const vals = history.filter((p) => p.confidence > 0.4).map((p) => p.bpm);
    let lo = Math.min(...(vals.length ? vals : [minBpm]));
    let hi = Math.max(...(vals.length ? vals : [maxBpm]));
    const pad = Math.max(6, (hi - lo) * 0.3);
    lo = Math.max(minBpm, lo - pad);
    hi = Math.min(maxBpm, hi + pad);
    if (hi - lo < 10) { hi += 5; lo -= 5; }

    const x = (t) => ((t - tStart) / span) * this.w;
    const y = (b) => this.h - ((b - lo) / (hi - lo)) * (this.h - 18) - 9;

    ctx.save();
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    for (let i = 1; i < history.length; i++) {
      const a = history[i - 1];
      const b = history[i];
      ctx.globalAlpha = 0.15 + 0.85 * Math.min(a.confidence, b.confidence);
      ctx.strokeStyle = css('--accent', '#4ade80');
      ctx.beginPath();
      ctx.moveTo(x(a.t), y(a.bpm));
      ctx.lineTo(x(b.t), y(b.bpm));
      ctx.stroke();
    }
    ctx.restore();

    this.label(`${hi.toFixed(0)}`, 6, 4);
    this.label(`${lo.toFixed(0)}`, 6, this.h - 14);
    this.label('heart rate trend', this.w - 6, 4, { align: 'right' });
  }
}
