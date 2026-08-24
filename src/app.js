// UI wiring: camera -> pipeline -> charts, stream sinks, and the recorder.

import { Capture, DEFAULT_ROI } from './capture.js';
import { RppgPipeline } from './pipeline.js';
import { WaveformChart, SpectrumChart, TrendChart } from './charts.js';
import { StreamHub, BroadcastSink, PostMessageSink, WebSocketSink, installGlobal } from './stream.js';
import { Recorder, download } from './recorder.js';

const $ = (id) => document.getElementById(id);

const capture = new Capture({ video: $('video') });
const hub = new StreamHub();
const recorder = new Recorder();
let pipeline = new RppgPipeline();

const charts = {
  wave: new WaveformChart($('c-wave')),
  spectrum: new SpectrumChart($('c-spectrum')),
  trend: new TrendChart($('c-trend')),
};

let latest = null;
let running = false;
let beatCount = 0;

// ------------------------------------------------------------- lifecycle ---

async function start() {
  $('btn-start').disabled = true;
  try {
    const info = await capture.start({ deviceId: $('sel-device').value || undefined });
    running = true;
    pipeline.reset();
    beatCount = 0;

    $('stage-hint').classList.add('hidden');
    $('dot').classList.add('live');
    $('btn-stop').disabled = false;
    $('fd-note').textContent = info.faceDetector ? '' : '(not supported by this browser)';
    $('chk-autoroi').disabled = !info.faceDetector;

    await populateDevices();
    hub.publish({ ...pipeline.describe(), camera: info });
    setState('acquiring');
  } catch (err) {
    console.error(err);
    setState('error');
    $('stage-hint').classList.remove('hidden');
    $('stage-hint').innerHTML = `<div><b>Camera unavailable</b><br>${escapeHtml(err.message || String(err))}</div>`;
    $('btn-start').disabled = false;
  }
}

function stop() {
  running = false;
  capture.stop();
  capture.video.srcObject = null;
  $('dot').classList.remove('live');
  $('btn-start').disabled = false;
  $('btn-stop').disabled = true;
  $('stage-hint').classList.remove('hidden');
  setState('idle');
  latest = null;
  pipeline.state = 'idle';
  clearOverlay();
  for (const c of Object.values(charts)) c.clear();
  updateReadout();
  if (recorder.recording) toggleRecord();
  hub.publish({ type: 'rppg.session', v: 1, event: 'stopped', wallClock: Date.now() });
}

async function populateDevices() {
  const sel = $('sel-device');
  const current = sel.value;
  const devices = await capture.listDevices();
  sel.innerHTML = '';
  devices.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || `Camera ${i + 1}`;
    sel.appendChild(o);
  });
  const active = capture.settings().deviceId;
  sel.value = current || active || (devices[0]?.deviceId ?? '');
}

// ------------------------------------------------------------- data flow ---

capture.onFrame = (frame) => {
  if (!running) return;
  recorder.frame(frame);

  const metrics = pipeline.pushFrame(frame);

  // A newly detected beat is published the moment it is found, so an external
  // visual can respond on the beat rather than on the next metrics tick.
  if (pipeline.newBeat) {
    const b = pipeline.newBeat;
    pipeline.newBeat = null;
    beatCount++;
    const msg = {
      type: 'rppg.beat', v: 1,
      t: round(b.t, 4), wallClock: Date.now(),
      ibiMs: b.ibiMs == null ? null : round(b.ibiMs, 1),
      bpm: b.bpm == null ? null : round(b.bpm, 1),
      amplitude: round(b.amplitude, 6),
      confidence: round(b.confidence, 3),
      index: beatCount,
    };
    hub.publish(msg);
    recorder.beat(msg);
  }

  if ($('chk-frames').checked) {
    // Compact per-frame envelope: the lowest-latency driver available.
    hub.publish({
      type: 'rppg.frame', v: 1,
      t: round(pipeline.elapsed, 4),
      phase: round(pipeline.phase, 4),
      wave: round(Math.cos(pipeline.phase), 4),
      bpm: round(pipeline.freqHz * 60, 2),
      confidence: round(pipeline.confidence, 3),
    });
  }

  if (metrics) {
    latest = metrics;
    hub.publish(metrics);
    recorder.metric(metrics);
  }
};

// --------------------------------------------------------------- render ---

function render() {
  requestAnimationFrame(render);
  if (!running) return;

  drawOverlay();
  charts.wave.draw(pipeline.recentSeries(pipeline.opt.fs * 10), pipeline.beats, {
    seconds: 10,
    phase: pipeline.phase,
    freqHz: pipeline.freqHz,
    confidence: pipeline.confidence,
  });
  charts.spectrum.draw(pipeline.spectrum, {
    minBpm: pipeline.opt.minBpm, maxBpm: pipeline.opt.maxBpm,
    bpm: pipeline.state === 'idle' ? null : pipeline.freqHz * 60,
    confidence: pipeline.confidence,
  });
  charts.trend.draw(pipeline.bpmHistory, {
    seconds: 180, minBpm: pipeline.opt.minBpm, maxBpm: pipeline.opt.maxBpm,
  });

  // The heart preview is driven by the same `phase` an external consumer gets:
  // it is a live demonstration of the feedback signal, not a separate animation.
  const conf = pipeline.confidence;
  const scale = 1 + 0.16 * Math.max(0, Math.cos(pipeline.phase)) ** 2 * conf;
  const heart = $('heart');
  heart.style.transform = `scale(${scale.toFixed(3)})`;
  heart.style.opacity = (0.25 + 0.75 * conf).toFixed(2);

  updateReadout();
}

function clearOverlay() {
  const cv = $('overlay');
  cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
}

function drawOverlay() {
  const cv = $('overlay');
  const stage = $('stage').getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(stage.width * dpr) || cv.height !== Math.round(stage.height * dpr)) {
    cv.width = Math.round(stage.width * dpr);
    cv.height = Math.round(stage.height * dpr);
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, stage.width, stage.height);

  const mirrored = $('chk-mirror').checked;
  const r = capture.roi;
  const x = (mirrored ? 1 - r.x - r.w : r.x) * stage.width;
  const y = r.y * stage.height;
  const w = r.w * stage.width;
  const h = r.h * stage.height;

  const locked = pipeline.state === 'locked';
  ctx.strokeStyle = locked ? '#4ade80' : '#fbbf24';
  ctx.lineWidth = 2;
  ctx.setLineDash(locked ? [] : [6, 4]);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);

  // Resize grip.
  ctx.fillStyle = ctx.strokeStyle;
  ctx.fillRect(x + w - 9, y + h - 9, 9, 9);

  const fill = latest?.quality.roiFill ?? 0;
  ctx.fillStyle = 'rgba(11,15,23,.7)';
  ctx.fillRect(x, y - 20, 104, 18);
  ctx.fillStyle = fill < 0.35 ? '#f0537d' : '#e6edf7';
  ctx.font = '11px ui-monospace, monospace';
  ctx.fillText(`skin ${(fill * 100).toFixed(0)}%`, x + 6, y - 7);

  // Say what is wrong, rather than leaving a low confidence unexplained.
  const warn = roiWarning();
  if (warn) {
    ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
    const tw = ctx.measureText(warn).width + 16;
    const bx = Math.max(4, Math.min(stage.width - tw - 4, x + w / 2 - tw / 2));
    const by = Math.min(stage.height - 26, y + h + 8);
    ctx.fillStyle = 'rgba(240,83,125,.9)';
    ctx.fillRect(bx, by, tw, 20);
    ctx.fillStyle = '#2a0512';
    ctx.fillText(warn, bx + 8, by + 14);
  }
}

/** The most useful single thing to tell the user about signal quality. */
function roiWarning() {
  if (!latest) return null;
  const q = latest.quality;
  if (q.contaminated) return 'movement detected — hold still';
  if (q.roiFill < 0.35) return 'ROI is mostly not skin — move it onto bare forehead';
  if (q.clipping > 0.05) return 'overexposed — reduce light or move away from the window';
  if (q.motion > 0.03) return 'too much motion';
  return null;
}

function updateReadout() {
  const m = latest;
  $('bpm').textContent = m && m.state !== 'acquiring' ? m.bpm.toFixed(1) : '--';
  $('v-state').textContent = pipeline.state;
  $('v-conf').textContent = m ? m.confidence.toFixed(2) : '–';
  $('v-snr').textContent = m && m.snrDb != null ? `${m.snrDb.toFixed(1)} dB` : '–';
  $('v-ibi').textContent = m && m.ibiMs ? `${m.ibiMs.toFixed(0)} ms` : '–';
  $('v-rmssd').textContent = m && m.hrv.rmssdMs ? `${m.hrv.rmssdMs.toFixed(0)} ms` : '–';
  $('v-fill').textContent = m ? `${(m.quality.roiFill * 100).toFixed(0)}%` : '–';
  const el = pipeline.elapsed;
  $('v-fps').textContent = running && el > 2 ? `${(pipeline.frameCount / el).toFixed(1)} fps` : '–';

  const c = running ? pipeline.confidence : 0;
  const bar = $('conf-fill');
  bar.style.width = `${(c * 100).toFixed(0)}%`;
  bar.style.background = c > 0.55 ? 'var(--accent)' : c > 0.3 ? 'var(--warn)' : 'var(--beat)';

  setState(pipeline.state);
  if (m) $('feed').textContent = JSON.stringify(m, null, 1);
  $('msg-count').textContent = `${hub.counts.sent.toLocaleString()} sent`;
  if (recorder.recording) {
    const s = recorder.summary;
    $('rec-status').textContent = `recording · ${s.durationSec.toFixed(0)}s · ${s.frames} frames · ${s.beats} beats`;
  }
}

function setState(s) {
  const pill = $('state-pill');
  pill.textContent = s;
  pill.className = `pill ${s}`;
}

// ------------------------------------------------------------------ ROI ---

(function roiInteraction() {
  const cv = $('overlay');
  let mode = null;
  let grab = null;

  const toNorm = (ev) => {
    const rect = cv.getBoundingClientRect();
    let nx = (ev.clientX - rect.left) / rect.width;
    const ny = (ev.clientY - rect.top) / rect.height;
    if ($('chk-mirror').checked) nx = 1 - nx;
    return { nx, ny };
  };

  cv.addEventListener('pointerdown', (ev) => {
    const { nx, ny } = toNorm(ev);
    const r = capture.roi;
    const nearCorner = Math.abs(nx - (r.x + r.w)) < 0.04 && Math.abs(ny - (r.y + r.h)) < 0.05;
    const inside = nx > r.x && nx < r.x + r.w && ny > r.y && ny < r.y + r.h;
    if (!nearCorner && !inside) return;
    mode = nearCorner ? 'resize' : 'move';
    grab = { nx, ny, roi: { ...r } };
    cv.setPointerCapture(ev.pointerId);
    cv.classList.add('dragging');
    $('chk-autoroi').checked = false;
    capture.autoRoi = false;
  });

  cv.addEventListener('pointermove', (ev) => {
    if (!mode) return;
    const { nx, ny } = toNorm(ev);
    const r = capture.roi;
    const g = grab;
    if (mode === 'move') {
      r.x = clamp(g.roi.x + (nx - g.nx), 0, 1 - g.roi.w);
      r.y = clamp(g.roi.y + (ny - g.ny), 0, 1 - g.roi.h);
    } else {
      r.w = clamp(g.roi.w + (nx - g.nx), 0.06, 1 - r.x);
      r.h = clamp(g.roi.h + (ny - g.ny), 0.06, 1 - r.y);
    }
  });

  const end = (ev) => {
    mode = null;
    cv.classList.remove('dragging');
    try { cv.releasePointerCapture(ev.pointerId); } catch {}
  };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
})();

// -------------------------------------------------------------- controls ---

$('btn-start').addEventListener('click', start);
$('btn-stop').addEventListener('click', stop);
$('btn-roi-reset').addEventListener('click', () => Object.assign(capture.roi, DEFAULT_ROI));

$('sel-device').addEventListener('change', () => { if (running) start(); });
$('sel-method').addEventListener('change', (e) => pipeline.setMethod(e.target.value));
$('chk-skin').addEventListener('change', (e) => { capture.useSkinMask = e.target.checked; });
$('chk-autoroi').addEventListener('change', (e) => { capture.autoRoi = e.target.checked; });
$('chk-mirror').addEventListener('change', (e) => $('stage').classList.toggle('mirror', e.target.checked));
$('stage').classList.toggle('mirror', $('chk-mirror').checked);

for (const id of ['in-minbpm', 'in-maxbpm']) {
  $(id).addEventListener('change', () => {
    const lo = clamp(+$('in-minbpm').value, 30, 120);
    const hi = clamp(+$('in-maxbpm').value, lo + 20, 240);
    $('in-minbpm').value = lo;
    $('in-maxbpm').value = hi;
    pipeline.setBand(lo, hi);
  });
}

// ----------------------------------------------------------------- sinks ---

function syncSinks() {
  if ($('chk-bc').checked) { if (!hub.has('broadcast')) hub.add('broadcast', new BroadcastSink()); }
  else hub.remove('broadcast');

  if ($('chk-pm').checked) { if (!hub.has('postmessage')) hub.add('postmessage', new PostMessageSink()); }
  else hub.remove('postmessage');

  if ($('chk-ws').checked) {
    const url = $('in-ws').value.trim();
    if (!hub.has('websocket') || hub.sinks.get('websocket').url !== url) {
      hub.add('websocket', new WebSocketSink(url, {
        onStatus: (s) => { $('ws-status').textContent = s; },
      }));
    }
  } else {
    hub.remove('websocket');
    $('ws-status').textContent = 'off';
  }
}

for (const id of ['chk-bc', 'chk-pm', 'chk-ws']) $(id).addEventListener('change', syncSinks);
$('in-ws').addEventListener('change', () => { if ($('chk-ws').checked) syncSinks(); });

$('in-rate').addEventListener('input', (e) => {
  const hz = +e.target.value;
  $('rate-label').textContent = hz;
  hub.limit('rppg.metrics', hz);
});
hub.limit('rppg.metrics', +$('in-rate').value);
syncSinks();

// -------------------------------------------------------------- recorder ---

function toggleRecord() {
  if (recorder.recording) {
    recorder.stop();
    $('btn-record').textContent = '● Record';
    $('btn-record').classList.remove('rec');
    $('btn-export').disabled = false;
    $('btn-clear').disabled = false;
    const s = recorder.summary;
    $('rec-status').textContent =
      `stopped · ${s.durationSec.toFixed(1)}s · ${s.frames} frames · ${s.beats} beats` +
      (s.meanBpmLocked ? ` · mean ${s.meanBpmLocked} bpm` : '');
  } else {
    recorder.start({ ...pipeline.describe(), camera: capture.settings(), userAgent: navigator.userAgent });
    $('btn-record').textContent = '■ Stop recording';
    $('btn-record').classList.add('rec');
    $('btn-export').disabled = true;
    $('btn-clear').disabled = true;
  }
}

$('btn-record').addEventListener('click', toggleRecord);
$('btn-export').addEventListener('click', () => {
  for (const f of recorder.files()) download(f.name, f.type, f.body);
});
$('btn-clear').addEventListener('click', () => {
  recorder.clear();
  $('btn-export').disabled = true;
  $('btn-clear').disabled = true;
  $('rec-status').textContent = 'not recording';
});

// ------------------------------------------------------------ public API ---

installGlobal(hub, {
  start, stop,
  pipeline: () => pipeline,
  capture: () => capture,
  recorder: () => recorder,
  session: () => recorder.toJSON(),
  setMethod: (m) => { $('sel-method').value = m; pipeline.setMethod(m); },
  setRoi: (roi) => Object.assign(capture.roi, roi),
});

window.addEventListener('beforeunload', () => capture.stop());
navigator.mediaDevices?.addEventListener?.('devicechange', () => populateDevices().catch(() => {}));

// ------------------------------------------------------------------ util ---

function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
function round(x, p) {
  if (x == null || !Number.isFinite(x)) return null;
  const m = 10 ** p;
  return Math.round(x * m) / m;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

populateDevices().catch(() => {});
render();
