// Outbound data layer.
//
// Everything the pipeline produces is published as a small JSON envelope to
// any number of sinks at once. The point of this file is that an external
// visualiser never has to know anything about rPPG - it subscribes to one of
// these transports and animates from `phase` / `wave` / `bpm`.
//
// Transports, cheapest first:
//   in-process   window.rppg.subscribe(fn)      same page
//   BroadcastChannel('rppg')                    another tab on the same origin
//   postMessage                                 an iframe or an opened window
//   WebSocket                                   anything else: Python, TouchDesigner, Unity, ...
//
// See docs/DATA.md for the message schema.

export const CHANNEL = 'rppg';

export class Sink {
  /** @param {object} msg */
  send(msg) {}      // eslint-disable-line no-unused-vars
  close() {}
  get status() { return 'ready'; }
}

export class CallbackSink extends Sink {
  constructor() {
    super();
    this.subs = new Set();
  }
  subscribe(fn) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
  send(msg) {
    for (const fn of this.subs) {
      try { fn(msg); } catch (e) { console.error('[rppg] subscriber threw', e); }
    }
  }
}

export class BroadcastSink extends Sink {
  constructor(name = CHANNEL) {
    super();
    this.ch = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(name);
  }
  send(msg) { this.ch?.postMessage(msg); }
  close() { this.ch?.close(); this.ch = null; }
  get status() { return this.ch ? 'open' : 'unsupported'; }
}

/** Posts to window.opener and window.parent, so an embedding page can listen. */
export class PostMessageSink extends Sink {
  constructor(targetOrigin = '*') {
    super();
    this.targetOrigin = targetOrigin;
  }
  send(msg) {
    try { window.opener?.postMessage(msg, this.targetOrigin); } catch {}
    try { if (window.parent !== window) window.parent.postMessage(msg, this.targetOrigin); } catch {}
  }
}

/** WebSocket client with automatic reconnection and backpressure dropping. */
export class WebSocketSink extends Sink {
  constructor(url, { onStatus } = {}) {
    super();
    this.url = url;
    this.onStatus = onStatus;
    this.ws = null;
    this.closed = false;
    this.retry = 0;
    this.sent = 0;
    this.dropped = 0;
    this._connect();
  }

  _connect() {
    if (this.closed) return;
    this._set('connecting');
    try {
      this.ws = new WebSocket(this.url);
    } catch (e) {
      this._set('error');
      this._scheduleRetry();
      return;
    }
    this.ws.onopen = () => { this.retry = 0; this._set('open'); };
    this.ws.onclose = () => { this._set('closed'); this._scheduleRetry(); };
    this.ws.onerror = () => this._set('error');
  }

  _scheduleRetry() {
    if (this.closed) return;
    const delay = Math.min(10000, 500 * 2 ** this.retry++);
    setTimeout(() => this._connect(), delay);
  }

  _set(s) {
    this._status = s;
    this.onStatus?.(s);
  }

  send(msg) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    // Never let a slow consumer build an unbounded queue in the browser.
    if (this.ws.bufferedAmount > 1 << 20) { this.dropped++; return; }
    this.ws.send(JSON.stringify(msg));
    this.sent++;
  }

  close() {
    this.closed = true;
    this.ws?.close();
    this._set('closed');
  }

  get status() { return this._status ?? 'idle'; }
}

/**
 * Fan-out hub. Owns the sinks and applies per-message-type rate limits so a
 * remote consumer is not flooded with 30 full metric records a second.
 */
export class StreamHub {
  constructor() {
    this.sinks = new Map();
    this.callbacks = new CallbackSink();
    this.sinks.set('callback', this.callbacks);
    this.rates = new Map();      // type -> minimum interval (ms)
    this.last = new Map();
    this.counts = { sent: 0, byType: {} };
    this.enabled = true;
  }

  add(name, sink) {
    this.remove(name);
    this.sinks.set(name, sink);
    return sink;
  }

  remove(name) {
    const s = this.sinks.get(name);
    if (s && name !== 'callback') {
      s.close();
      this.sinks.delete(name);
    }
  }

  has(name) { return this.sinks.has(name); }

  /** @param {string} type e.g. 'rppg.metrics' @param {number} hz 0 = unlimited */
  limit(type, hz) {
    if (!hz) this.rates.delete(type);
    else this.rates.set(type, 1000 / hz);
  }

  publish(msg) {
    if (!this.enabled) return false;
    const min = this.rates.get(msg.type);
    if (min) {
      const now = performance.now();
      const prev = this.last.get(msg.type) ?? -Infinity;
      if (now - prev < min) return false;
      this.last.set(msg.type, now);
    }
    for (const sink of this.sinks.values()) sink.send(msg);
    this.counts.sent++;
    this.counts.byType[msg.type] = (this.counts.byType[msg.type] ?? 0) + 1;
    return true;
  }

  status() {
    const out = {};
    for (const [name, sink] of this.sinks) out[name] = sink.status;
    return out;
  }

  closeAll() {
    for (const [name, sink] of this.sinks) if (name !== 'callback') sink.close();
    this.sinks.clear();
    this.sinks.set('callback', this.callbacks);
  }
}

/**
 * Install `window.rppg`, the in-page API. Anything running on the same page -
 * a console snippet, a bundled shader, a canvas overlay - can drive itself
 * from this without any transport at all.
 */
export function installGlobal(hub, controls = {}) {
  const api = {
    subscribe: (fn) => hub.callbacks.subscribe(fn),
    latest: null,
    status: () => hub.status(),
    ...controls,
  };
  hub.callbacks.subscribe((msg) => {
    if (msg.type === 'rppg.metrics' || msg.type === 'rppg.frame') api.latest = msg;
  });
  window.rppg = api;
  return api;
}
