// Per-canvas event bus: sequence-numbered events, a replay buffer and SSE subscribers.

import { SSE_HEADERS } from "../http.mjs";

const BUFFER = 2000;

export class EventBus {
  constructor() {
    this.seq = 0;
    this.buffer = [];
    this.subs = new Set();
  }

  emit(type, data) {
    const ev = { seq: ++this.seq, ts: Date.now(), type, data };
    this.buffer.push(ev);
    if (this.buffer.length > BUFFER) this.buffer.shift();
    // one dead/slow subscriber must not break the turn that emitted: drop writers that throw.
    for (const fn of [...this.subs]) {
      try { fn(ev); } catch { this.subs.delete(fn); try { fn.close?.(); } catch {} }
    }
    return ev;
  }

  // Streams events to an SSE response, replaying anything after lastId first.
  stream(req, res) {
    res.writeHead(200, SSE_HEADERS);
    const send = (ev) => res.write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    const lastId = Number(req.headers["last-event-id"] || new URL(req.url, "http://x").searchParams.get("since") || 0);
    if (lastId) for (const ev of this.buffer) if (ev.seq > lastId) send(ev);
    res.write(`: connected seq=${this.seq}\n\n`);
    this.subs.add(send);
    const ping = setInterval(() => res.write(": ping\n\n"), 15000);
    req.on("close", () => { clearInterval(ping); this.subs.delete(send); });
  }

  close() {
    this.subs.clear();
  }
}
