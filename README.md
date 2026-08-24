# rPPG

A browser interface that reads your pulse from a webcam, and a documented data
layer for feeding that signal into something else.

No build step, no dependencies, no npm install. The camera stream never leaves
the machine — the only thing that goes anywhere is the numbers, and only to the
transports you switch on.

```bash
node server/serve.mjs          # http://localhost:8080
```

Then press **Start camera**, sit still under even light, and give it about ten
seconds to lock.

> Camera access requires `https://` or `localhost`. Opening `index.html` as a
> `file://` URL will not work.

## What it does

Remote photoplethysmography: each heartbeat pushes blood into the skin of your
face, which changes how much light it absorbs. The change is far too small to
see, but it survives averaging thousands of pixels per frame. The pipeline is:

```
camera frames
   -> ROI mean RGB (skin-masked)          capture.js
   -> uniform resampling                  pipeline.js
   -> chrominance extraction              methods.js   POS / CHROM / GREEN
   -> Butterworth band-pass               dsp.js
   -> spectral HR + phase tracking        pipeline.js
   -> beats, HRV, quality
   -> JSON envelopes                      stream.js
```

The heart rate comes from the Welch spectrum over a 10 s window with sub-bin
interpolation, with an octave guard so a strong second harmonic cannot double
the reported rate, and artefact rejection that holds the last good rate while a
large excursion is still inside the analysis window. The cardiac **phase** comes from quadrature demodulation at the
tracked rate — a continuous 0..2π angle that keeps advancing smoothly even when
an individual beat detection is missed. That phase is what makes a good external
animation possible.

Three extraction methods are selectable: **POS** (Wang et al. 2017, the default
and most robust), **CHROM** (de Haan & Jeanne 2013), and **GREEN** (Verkruysse
et al. 2008, a baseline).

## Getting the data out

Four transports, all carrying identical JSON envelopes — see
**[docs/DATA.md](docs/DATA.md)** for the full schema.

| where your consumer lives | transport |
|---|---|
| the same page | `window.rppg.subscribe(fn)` |
| another tab | `BroadcastChannel('rppg')` |
| an iframe or opener | `postMessage` |
| anywhere else | WebSocket, via `server/relay.mjs` |

```js
// another tab on the same origin
new BroadcastChannel('rppg').onmessage = ({ data }) => {
  if (data.type === 'rppg.metrics' && data.confidence > 0.55) {
    render(Math.cos(data.phase), data.bpm);
  }
};
```

```bash
# outside the browser
node server/relay.mjs             # ws://localhost:8787, tick the WebSocket box in the UI
python3 examples/consume.py       # stdlib only, no pip install
```

Message types: `rppg.metrics` (the main record, 1–30 Hz), `rppg.frame` (compact,
per camera frame), `rppg.beat` (discrete beat events), `rppg.session` (config).

### Recording

**Record** then **Export session** writes four files: `session.json`,
`metrics.csv`, `beats.csv`, and `raw.csv`. The last one holds the per-frame ROI
mean RGB — the actual measurement, before any analysis. Keep it: a recorded
session can be re-run through `reanalyse()` later with a different method or a
better algorithm, without filming anyone again.

## Examples

- `examples/consumer.html` — a second tab that animates purely from the stream.
  Open it alongside the interface to watch the loop close; it has no camera
  access and no rPPG code in it at all.
- `examples/consume.py` — dependency-free Python client. Import `stream()` and
  drive lights, serial devices, a projector, whatever the loop turns out to be.

## Layout

```
index.html          the interface
styles.css
src/dsp.js          FFT, Welch PSD, Butterworth design, filtfilt, peak finding
src/methods.js      POS / CHROM / GREEN + the sliding-window extractor
src/pipeline.js     frames -> metrics; also reanalyse() for offline passes
src/capture.js      getUserMedia, ROI, skin mask, quality figures
src/stream.js       transports and the fan-out hub
src/recorder.js     session buffering and CSV/JSON export
src/charts.js       canvas plots
src/app.js          UI wiring
server/serve.mjs    static host
server/relay.mjs    zero-dependency WebSocket relay (RFC 6455 by hand)
examples/           browser and Python consumers
docs/DATA.md        the data contract
test/               22 tests, node --test, no dependencies
```

`src/dsp.js`, `src/methods.js` and `src/pipeline.js` have no DOM dependencies, so
they run in Node — which is how the tests drive the whole pipeline with a
synthetic pulse and check that the recovered rate is right.

```bash
npm test
```

The suite verifies heart-rate recovery within 3 bpm from 52 to 130 bpm, that
POS rejects a shared illumination drift, that the filter is −3.01 dB at both
band edges, that phase advances at the heart rate, that the pipeline reacquires
after a dropped-camera gap, that confidence stays low when there is no pulse at
all, and that the relay's hand-rolled WebSocket framing round-trips.

## Getting a good signal

- Even, steady, diffuse light on your face. Daylight from a window is ideal.
- No screen glow behind you, and nothing flickering — cheap LEDs modulate at
  rates that fold straight into the pulse band.
- Sit still. `quality.motion` above ~0.02 will show in the confidence.
- Keep the ROI on your forehead. Drag it to move, drag the corner to resize.
- Watch `roiFill`: below ~35% the skin mask is not finding skin, so move the box.
  The mask gates on hue *and* on brightness relative to the ROI median, so hair,
  eyebrows, glasses frames and lens glints are excluded — which is why a box
  that overlaps them reports a low percentage even though it looks full of face.
- **Forehead only.** A box that catches eyebrows, glasses or the eyes will pick
  up blinks and frame glints, and those are far larger than a heartbeat.

## Limits

Not a medical device: no calibration and no validation against a reference
monitor. Accuracy depends on motion, lighting, camera behaviour and skin tone —
darker skin reflects less signal, and most published rPPG methods were developed
on lighter-toned datasets, so expect lower SNR. Webcam HRV in particular is
indicative only; at 30 fps one sample is 33 ms, which is the same order as the
RMSSD values being reported.

`confidence` is the honest summary of all of that. Gate on it.
