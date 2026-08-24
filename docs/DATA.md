# Data contract

Everything the interface measures is published as small JSON envelopes and can
be recorded to disk. This document is the contract: build against it and your
feedback loop will keep working as the internals change.

Every message has `type` (namespaced `rppg.*`) and `v` (schema version, currently `1`).
Unknown fields may be added within a version; fields are never removed or
repurposed without bumping `v`.

---

## Message types

### `rppg.metrics` — the main record

Emitted at the configured stream rate (1–30 Hz, default 15 Hz).

```json
{
  "type": "rppg.metrics",
  "v": 1,
  "t": 42.6667,
  "wallClock": 1755000000123,
  "state": "locked",
  "bpm": 68.42,
  "bpmSource": "spectral",
  "confidence": 0.83,
  "snrDb": 6.1,
  "phase": 1.8342,
  "wave": -0.2601,
  "signal": 0.4212,
  "amplitude": 0.000412,
  "lastBeatT": 42.2,
  "ibiMs": 878.0,
  "hrv": { "rmssdMs": 42.1, "sdnnMs": 51.0, "beats": 47 },
  "quality": { "roiFill": 0.712, "motion": 0.0031, "clipping": 0.0 },
  "method": "pos",
  "fs": 30,
  "frames": 1280,
  "samples": 1279
}
```

| field | meaning |
|---|---|
| `t` | seconds since capture started (monotonic, gap-free on the analysis timeline) |
| `wallClock` | `Date.now()` when the record was built — use for cross-machine alignment |
| `state` | `idle` → `acquiring` → `searching` ⇄ `locked` |
| `bpm` | heart rate from the spectral peak, slew-limited |
| `confidence` | 0–1, from SNR and ROI coverage. **Gate your visuals on this.** |
| `snrDb` | power near the fundamental + first harmonic vs. the rest of the band |
| `phase` | **0 to 2π, cardiac phase.** 0 = systolic peak. Continuous, monotonically increasing modulo 2π |
| `wave` | `cos(phase)` — a clean unit-amplitude pulse, precomputed for convenience |
| `signal` | the actual band-passed measurement, normalised to about ±1. Noisier than `wave`, but real |
| `amplitude` | tracked pulse amplitude in raw intensity units — a relative perfusion indicator, not calibrated |
| `ibiMs` | most recent inter-beat interval, `null` until two beats are seen |
| `hrv.rmssdMs` / `hrv.sdnnMs` | over the last ≤60 intervals. Indicative only — see the caveat below |
| `quality.roiFill` | fraction of ROI pixels passing the skin gate. Below ~0.3 means the ROI is off-face |
| `quality.motion` | frame-to-frame ROI luma change. Above ~0.02 the estimate degrades |
| `quality.clipping` | fraction of blown-out or crushed pixels. Anything above 0 hurts |

### `rppg.frame` — per-frame, low latency

Off by default. One per camera frame (~30 Hz), deliberately minimal:

```json
{ "type": "rppg.frame", "v": 1, "t": 42.7, "phase": 1.9, "wave": -0.32, "bpm": 68.4, "confidence": 0.83 }
```

Use it when you want the tightest coupling between pulse and animation and you
are on a cheap transport (same page, BroadcastChannel). Over a WebSocket, prefer
`rppg.metrics` at 15 Hz and interpolate — see *Driving an animation* below.

### `rppg.beat` — discrete beat events

Fired the moment a systolic peak is confirmed (about 60 ms after it occurs).

```json
{ "type": "rppg.beat", "v": 1, "t": 42.2, "wallClock": 1755000000000,
  "ibiMs": 878.0, "bpm": 68.3, "amplitude": 0.0004, "confidence": 0.83, "index": 47 }
```

`bpm` here is the *instantaneous* rate from one interval, so it is far jumpier
than the spectral `bpm` in `rppg.metrics`. Use beats for discrete triggers
(a flash, a sound, a haptic); use `phase` for anything continuous.

### `rppg.session` — configuration

Sent once when capture starts, and again with `"event": "stopped"` at the end.
Carries method, sample rate, search band, and camera settings.

---

## Transports

All four carry the identical envelopes; pick by where your consumer lives.

| transport | reach | how |
|---|---|---|
| `window.rppg.subscribe(fn)` | same page | `const off = window.rppg.subscribe(m => …)` |
| `BroadcastChannel('rppg')` | another tab, same origin | `new BroadcastChannel('rppg').onmessage = e => …` |
| `postMessage` | iframe / opener | `window.addEventListener('message', e => …)` |
| WebSocket | anything, any machine | run `node server/relay.mjs`, tick the WebSocket box |

The relay rebroadcasts each message to every other connected client, so several
consumers can share one capture. `examples/consume.py` is a stdlib-only Python
client; `examples/consumer.html` is a browser one.

```bash
node server/relay.mjs                      # ws://localhost:8787
node server/relay.mjs --log session.jsonl  # also append every message to disk
curl localhost:8787/health                 # status
```

---

## Recorded files

**Record** buffers a session; **Export session** writes four files.

### `*-raw.csv` — the source measurement

```csv
t,r,g,b,roiFill,motion,clipping
0.03337,171.2043,128.9912,109.4471,0.7104,0.0012,0
```

Per-frame mean RGB of the skin pixels in the ROI, on the original irregular
camera timeline. **This is the only irreplaceable file.** Everything else is
derived from it, so keeping it means a session can be re-analysed later with a
different method, a different band, or a better algorithm — without filming
anyone again.

Re-analyse a recording offline (zero-phase filtering, whole-record spectrum,
so it is more accurate than the live pass):

```js
import { reanalyse } from './src/pipeline.js';
const { raw } = JSON.parse(await fs.readFile('rppg-…-session.json', 'utf8'));
const out = reanalyse(raw, { method: 'chrom' });
console.log(out.bpm, out.beats.length);
```

### `*-metrics.csv`

Flattened `rppg.metrics` records — one row per emission, nested fields as
`hrv.rmssdMs`, `quality.roiFill`, and so on. Loads straight into pandas.

### `*-beats.csv`

`t, ibiMs, bpm, amplitude, confidence` — one row per detected beat.

### `*-session.json`

`{ format: "rppg-session", v: 1, startedAt, stoppedAt, session, summary, raw[], metrics[], beats[] }`
— the complete record including camera and configuration metadata.

---

## Driving an animation

`phase` is the field to build on. It advances continuously at the heart rate
rather than jumping between beats, so an animation locked to it stays smooth
even when a beat detection is missed.

Do not sample `phase` at your frame rate directly — messages arrive at 15 Hz and
your display runs at 60+. Run a local oscillator and ease it toward the reported
phase:

```js
let local = 0, bpm = 60, conf = 0;
new BroadcastChannel('rppg').onmessage = ({ data }) => {
  if (data.type !== 'rppg.metrics') return;
  bpm = data.bpm; conf = data.confidence; target = data.phase;
};

function frame(dt) {
  local += 2 * Math.PI * (bpm / 60) * dt;        // advance at the heart rate
  let err = target - local;
  err = Math.atan2(Math.sin(err), Math.cos(err)); // shortest way round the circle
  local += err * Math.min(1, 3 * dt);             // ease, do not snap
  const pulse = Math.max(0, Math.cos(local)) ** 2;
  draw(pulse * conf);                             // fade out when unsure
}
```

Three rules that make the difference between a convincing loop and a twitchy one:

1. **Multiply by `confidence`.** When the signal is poor the visual should
   visibly weaken, not animate noise with full conviction.
2. **Never snap the phase.** Ease toward it; a snap reads as a glitch.
3. **Ignore `bpm` while `state !== 'locked'`.** During `acquiring` and
   `searching` the estimate is still sweeping the band.

---

## Caveats worth respecting

- **Not a medical device.** No calibration, no validation against a reference
  monitor. It is a signal source.
- **Accuracy varies by subject and setting.** Motion, low or flickering light,
  camera auto-exposure, and darker skin tones (less reflected signal, and most
  published methods were tuned on lighter tones) all reduce SNR. The honest
  reading is `confidence`.
- **HRV needs better timing than this.** At 30 fps one sample is 33 ms, and
  RMSSD values are often in that range. Treat `hrv.*` as a trend indicator, and
  do not use it for anything clinical or high-stakes.
- **A ~10 s window means ~10 s of lag** in the heart-rate estimate after a real
  change. `phase` and `wave` track much faster; `bpm` deliberately does not.
