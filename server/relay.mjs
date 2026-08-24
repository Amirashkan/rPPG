// Dependency-free WebSocket relay + recorder.
//
// The browser publishes rPPG envelopes here; every other connected client
// receives them. That is the bridge out of the browser: point a Python script,
// TouchDesigner, Unity, a Pi, or a second machine at ws://<host>:8787 and read
// newline-free JSON messages.
//
//   node server/relay.mjs [port] [--log out.jsonl] [--quiet]
//
// It also serves a tiny HTTP status page on the same port, and appends every
// message to a JSON Lines file when --log is given.

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';

const args = process.argv.slice(2);
const PORT = Number(args.find((a) => /^\d+$/.test(a)) ?? process.env.PORT ?? 8787);
const LOG = args.includes('--log') ? args[args.indexOf('--log') + 1] : null;
const QUIET = args.includes('--quiet');

const logStream = LOG ? createWriteStream(LOG, { flags: 'a' }) : null;
const clients = new Set();
const stats = { connected: 0, messages: 0, started: new Date().toISOString(), lastBpm: null };

// ------------------------------------------------------------ RFC 6455 ----

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function controlFrame(opcode, payload = Buffer.alloc(0)) {
  return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
}

/** Pull as many complete frames as `buf` holds. Returns [frames, remainder]. */
function decodeFrames(buf) {
  const out = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;

    if (len === 126) {
      if (buf.length < p + 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buf.length < p + 8) break;
      const big = buf.readBigUInt64BE(p);
      if (big > 0x7fffffffn) throw new Error('frame too large');
      len = Number(big);
      p += 8;
    }

    let mask = null;
    if (masked) {
      if (buf.length < p + 4) break;
      mask = buf.subarray(p, p + 4);
      p += 4;
    }
    if (buf.length < p + len) break;

    const payload = Buffer.from(buf.subarray(p, p + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];

    out.push({ fin, opcode, payload });
    off = p + len;
  }
  return [out, buf.subarray(off)];
}

// --------------------------------------------------------------- server ---

const http = createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ ok: true, clients: clients.size, ...stats }, null, 2));
    return;
  }
  res.writeHead(404).end();
});

http.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key) {
    socket.destroy();
    return;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay(true);

  const client = { socket, id: ++stats.connected, buffer: Buffer.alloc(0), alive: true };
  clients.add(client);
  if (!QUIET) console.log(`+ client ${client.id} (${clients.size} connected)`);

  const drop = () => {
    if (!clients.delete(client)) return;
    if (!QUIET) console.log(`- client ${client.id} (${clients.size} connected)`);
    socket.destroy();
  };

  socket.on('data', (chunk) => {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    let frames;
    try {
      [frames, client.buffer] = decodeFrames(client.buffer);
    } catch (e) {
      drop();
      return;
    }
    for (const f of frames) {
      if (f.opcode === 0x8) { drop(); return; }
      if (f.opcode === 0x9) { socket.write(controlFrame(0xa, f.payload)); continue; }
      if (f.opcode !== 0x1 && f.opcode !== 0x0) continue;
      onMessage(client, f.payload.toString('utf8'));
    }
  });

  socket.on('error', drop);
  socket.on('close', drop);
});

function onMessage(from, text) {
  stats.messages++;
  logStream?.write(`${text}\n`);

  if (!QUIET) {
    try {
      const m = JSON.parse(text);
      if (m.type === 'rppg.metrics') {
        stats.lastBpm = m.bpm;
        if (stats.messages % 25 === 0) {
          process.stdout.write(
            `\r  ${String(m.bpm ?? '--').padStart(6)} bpm  conf ${String(m.confidence ?? 0).padEnd(5)}  ${String(m.state ?? '').padEnd(9)}  ${stats.messages} msgs   `,
          );
        }
      } else if (m.type === 'rppg.session') {
        console.log(`\n  session: ${m.method ?? ''} @ ${m.fs ?? '?'} Hz`);
      }
    } catch { /* not our JSON; relay it anyway */ }
  }

  // Fan out to everyone else.
  const frame = encodeFrame(text);
  for (const c of clients) {
    if (c === from) continue;
    if (c.socket.writableLength > 1 << 20) continue;   // drop for a stalled peer
    c.socket.write(frame);
  }
}

// Keep NAT/proxies from silently dropping idle sockets.
setInterval(() => {
  for (const c of clients) {
    try { c.socket.write(controlFrame(0x9)); } catch { clients.delete(c); }
  }
}, 20000).unref();

http.listen(PORT, () => {
  console.log(`rPPG relay listening on ws://localhost:${PORT}`);
  console.log(`status: http://localhost:${PORT}/health`);
  if (LOG) console.log(`logging every message to ${LOG}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\nshutting down');
    logStream?.end();
    http.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
