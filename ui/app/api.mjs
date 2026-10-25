// The engine's REST API and event streams (src/routes/*.mjs), as TaksimKit/APIClient.swift and
// EventStream.swift read them. Errors come back as { error: { message } }.
import { lang } from './theme.mjs';

export class APIError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function send(method, path, body) {
  if (method === 'POST' && path === '/v1/pick-folder' && window.taksimDesktop) return window.taksimDesktop.pickFolder(body?.start ?? null);
  const headers = { 'Accept-Language': lang === 'tr' ? 'tr' : 'en' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { text }; }
  if (!r.ok) throw new APIError(r.status, data?.error?.message || `HTTP ${r.status}`);
  return data;
}

export const api = {
  get: (path) => send('GET', path),
  post: (path, body = {}) => send('POST', path, body),
  patch: (path, body) => send('PATCH', path, body),
  put: (path, body) => send('PUT', path, body),
  delete: (path) => send('DELETE', path),
};

/** Reads an SSE endpoint, reconnecting a second after it drops; `url()` is asked again on each connect.
 *  Read by hand rather than with EventSource, which only hands over the event names it was told of. */
export function stream(url, { onEvent, onState = () => {} }) {
  let closed = false, abort = null;
  (async () => {
    while (!closed) {
      abort = new AbortController();
      try {
        const r = await fetch(url(), { signal: abort.signal, headers: { Accept: 'text/event-stream' } });
        if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
        onState(true);
        const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = '', type = null, data = [];
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).replace(/\r$/, '');
            buf = buf.slice(i + 1);
            if (line === '') { if (data.length) onEvent(type, data.join('\n')); type = null; data = []; continue; }
            if (line.startsWith(':')) continue;
            const c = line.indexOf(':'), field = c < 0 ? line : line.slice(0, c), v = c < 0 ? '' : line.slice(c + 1).replace(/^ /, '');
            if (field === 'event') type = v; else if (field === 'data') data.push(v);
          }
        }
      } catch {}
      if (closed) break;
      onState(false);
      await new Promise((r) => setTimeout(r, 1000));
    }
  })();
  return { close() { closed = true; abort?.abort(); } };
}
