// Session recording and export.
//
// Two things get recorded, and the distinction matters:
//
//   raw     - per-frame ROI mean RGB with timestamps. This is the *source*
//             measurement. Keeping it means a recorded session can be
//             re-analysed later with a different method, band, or a better
//             algorithm entirely, without filming the subject again.
//   metrics - the derived record (bpm, phase, HRV, quality) at metricsHz.
//
// Exports are plain CSV and JSON so anything can read them - pandas, a
// spreadsheet, a shader, whatever the feedback loop ends up being built in.

export class Recorder {
  constructor({ maxFrames = 200000 } = {}) {
    this.maxFrames = maxFrames;
    this.clear();
  }

  clear() {
    this.raw = [];
    this.metrics = [];
    this.beats = [];
    this.startedAt = null;
    this.stoppedAt = null;
    this.session = null;
    this.recording = false;
    this.truncated = false;
  }

  start(sessionInfo) {
    this.clear();
    this.recording = true;
    this.startedAt = new Date().toISOString();
    this.session = sessionInfo;
  }

  stop() {
    this.recording = false;
    this.stoppedAt = new Date().toISOString();
  }

  frame(f) {
    if (!this.recording) return;
    if (this.raw.length >= this.maxFrames) { this.truncated = true; return; }
    this.raw.push({
      t: +f.t.toFixed(5),
      r: +f.r.toFixed(4),
      g: +f.g.toFixed(4),
      b: +f.b.toFixed(4),
      roiFill: +(f.quality?.roiFill ?? 0).toFixed(4),
      motion: +(f.quality?.motion ?? 0).toFixed(5),
      clipping: +(f.quality?.clipping ?? 0).toFixed(4),
    });
  }

  metric(m) {
    if (this.recording) this.metrics.push(m);
  }

  beat(b) {
    if (this.recording) this.beats.push(b);
  }

  get durationSec() {
    if (!this.raw.length) return 0;
    return this.raw.at(-1).t - this.raw[0].t;
  }

  get summary() {
    const bpms = this.metrics.filter((m) => m.state === 'locked').map((m) => m.bpm);
    const mean = bpms.length ? bpms.reduce((a, b) => a + b, 0) / bpms.length : null;
    return {
      frames: this.raw.length,
      metrics: this.metrics.length,
      beats: this.beats.length,
      durationSec: +this.durationSec.toFixed(2),
      meanBpmLocked: mean == null ? null : +mean.toFixed(1),
      lockedFraction: this.metrics.length
        ? +(this.metrics.filter((m) => m.state === 'locked').length / this.metrics.length).toFixed(3)
        : 0,
      truncated: this.truncated,
    };
  }

  /** The complete session as one self-describing object. */
  toJSON() {
    return {
      format: 'rppg-session',
      v: 1,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt ?? new Date().toISOString(),
      session: this.session,
      summary: this.summary,
      raw: this.raw,
      metrics: this.metrics,
      beats: this.beats,
    };
  }

  static csv(rows, columns) {
    const head = columns.join(',');
    const body = rows.map((r) => columns.map((c) => {
      const v = c.split('.').reduce((o, k) => (o == null ? o : o[k]), r);
      return v == null ? '' : v;
    }).join(','));
    return `${head}\n${body.join('\n')}\n`;
  }

  rawCsv() {
    return Recorder.csv(this.raw, ['t', 'r', 'g', 'b', 'roiFill', 'motion', 'clipping']);
  }

  metricsCsv() {
    return Recorder.csv(this.metrics, [
      't', 'wallClock', 'state', 'bpm', 'confidence', 'snrDb',
      'phase', 'wave', 'signal', 'amplitude',
      'ibiMs', 'hrv.rmssdMs', 'hrv.sdnnMs',
      'quality.roiFill', 'quality.motion', 'quality.clipping',
    ]);
  }

  beatsCsv() {
    return Recorder.csv(this.beats, ['t', 'ibiMs', 'bpm', 'amplitude', 'confidence']);
  }

  files(stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)) {
    return [
      { name: `rppg-${stamp}-session.json`, type: 'application/json', body: JSON.stringify(this.toJSON(), null, 1) },
      { name: `rppg-${stamp}-raw.csv`, type: 'text/csv', body: this.rawCsv() },
      { name: `rppg-${stamp}-metrics.csv`, type: 'text/csv', body: this.metricsCsv() },
      { name: `rppg-${stamp}-beats.csv`, type: 'text/csv', body: this.beatsCsv() },
    ];
  }
}

/** Trigger a browser download for a text payload. */
export function download(name, type, body) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
