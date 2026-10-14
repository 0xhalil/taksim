#!/usr/bin/env node
// Codex `notify` program: Codex calls it with a JSON payload as the last argument after each turn.
// Usage (set by taksim): notify.mjs <hook-url>  ->  POST <hook-url> with the payload.

const [url, payload] = [process.argv[2], process.argv.at(-1)];
if (url && payload && payload !== url) {
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: payload, signal: AbortSignal.timeout(5000) })
    .catch(() => {});
}
