#!/usr/bin/env python3
"""Consume the rPPG stream from outside the browser, with no dependencies.

Connects to the relay (``node server/relay.mjs``) and yields each envelope as a
dict. Everything here is stdlib, so this drops into any Python 3.8+ program:
a light controller, a serial link to an Arduino, a projector visual, a logger.

    python3 examples/consume.py                     # print metrics
    python3 examples/consume.py --url ws://box:8787 # another machine
    python3 examples/consume.py --raw > out.jsonl   # capture everything

To drive your own feedback loop, import ``stream`` and animate from ``phase``
(a continuous 0..2*pi cardiac phase) gated on ``confidence``:

    from consume import stream
    for msg in stream():
        if msg["type"] == "rppg.metrics" and msg["confidence"] > 0.55:
            brightness = 0.5 + 0.5 * math.cos(msg["phase"])
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import socket
import struct
import sys
from urllib.parse import urlparse

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class WebSocket:
    """Just enough of RFC 6455 to read a text stream from the relay."""

    def __init__(self, url: str, timeout: float = 30.0):
        u = urlparse(url)
        if u.scheme not in ("ws", "http"):
            raise ValueError(f"only ws:// is supported, got {url!r}")
        host = u.hostname or "localhost"
        port = u.port or 80
        path = u.path or "/"

        self.sock = socket.create_connection((host, port), timeout=timeout)
        self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall(
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n".encode()
        )

        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("server closed during handshake")
            buf += chunk
        head, _, rest = buf.partition(b"\r\n\r\n")
        if b"101" not in head.split(b"\r\n")[0]:
            raise ConnectionError(f"handshake failed: {head.splitlines()[0]!r}")

        expected = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
        for line in head.decode("latin1").split("\r\n")[1:]:
            name, _, value = line.partition(":")
            if name.strip().lower() == "sec-websocket-accept" and value.strip() != expected:
                raise ConnectionError("bad Sec-WebSocket-Accept")

        self.buf = rest

    def _recv_exact(self, n: int) -> bytes:
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("connection closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _send_frame(self, opcode: int, payload: bytes = b"") -> None:
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        header = bytes([0x80 | opcode])
        n = len(payload)
        if n < 126:
            header += bytes([0x80 | n])
        elif n < 65536:
            header += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            header += bytes([0x80 | 127]) + struct.pack(">Q", n)
        self.sock.sendall(header + mask + masked)

    def send(self, text: str) -> None:
        self._send_frame(0x1, text.encode())

    def recv(self) -> str | None:
        """Next complete text message, or None once the peer closes."""
        fragments: list[bytes] = []
        while True:
            b0, b1 = self._recv_exact(2)
            opcode = b0 & 0x0F
            fin = bool(b0 & 0x80)
            length = b1 & 0x7F
            if length == 126:
                length = struct.unpack(">H", self._recv_exact(2))[0]
            elif length == 127:
                length = struct.unpack(">Q", self._recv_exact(8))[0]
            if b1 & 0x80:                       # a server must not mask, but be lenient
                mask = self._recv_exact(4)
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(self._recv_exact(length)))
            else:
                payload = self._recv_exact(length)

            if opcode == 0x8:                   # close
                self._send_frame(0x8)
                return None
            if opcode == 0x9:                   # ping -> pong
                self._send_frame(0xA, payload)
                continue
            if opcode == 0xA:                   # pong
                continue
            fragments.append(payload)
            if fin:
                return b"".join(fragments).decode("utf-8", "replace")

    def close(self) -> None:
        try:
            self._send_frame(0x8)
        except OSError:
            pass
        self.sock.close()


def stream(url: str = "ws://localhost:8787", reconnect: bool = True):
    """Yield rPPG envelopes as dicts, reconnecting if the relay restarts."""
    import time

    delay = 0.5
    while True:
        try:
            ws = WebSocket(url)
            delay = 0.5
            while True:
                text = ws.recv()
                if text is None:
                    break
                try:
                    yield json.loads(text)
                except json.JSONDecodeError:
                    continue
        except (OSError, ConnectionError) as exc:
            if not reconnect:
                raise
            print(f"[rppg] {exc}; retrying in {delay:.1f}s", file=sys.stderr)
        finally:
            try:
                ws.close()
            except (NameError, OSError):
                pass
        if not reconnect:
            return
        time.sleep(delay)
        delay = min(10.0, delay * 2)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default="ws://localhost:8787", help="relay URL (default: %(default)s)")
    ap.add_argument("--raw", action="store_true", help="print every envelope as JSON Lines")
    ap.add_argument("--type", default=None, help="only show this message type, e.g. rppg.beat")
    args = ap.parse_args()

    try:
        for msg in stream(args.url):
            if args.type and msg.get("type") != args.type:
                continue
            if args.raw:
                print(json.dumps(msg), flush=True)
            elif msg.get("type") == "rppg.metrics":
                print(
                    f"{msg['t']:8.2f}s  {msg['bpm']:6.1f} bpm  "
                    f"conf {msg['confidence']:.2f}  snr {str(msg['snrDb']):>6}dB  "
                    f"phase {msg['phase']:.2f}  {msg['state']}",
                    flush=True,
                )
            elif msg.get("type") == "rppg.beat":
                ibi = msg.get("ibiMs")
                print(f"{msg['t']:8.2f}s  beat #{msg.get('index')}  ibi {ibi} ms", flush=True)
            elif msg.get("type") == "rppg.session":
                print(f"# session: {json.dumps(msg)}", flush=True)
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
