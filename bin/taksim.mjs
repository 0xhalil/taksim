#!/usr/bin/env node
// taksim CLI. P0 has one command; run/validate/ls/mcp arrive with the workflow engine.

import { serve } from "../src/server.mjs";

const [cmd = "serve"] = process.argv.slice(2);

// The engine serves the app and every agent; one stray error must not take it down.
process.on("uncaughtException", (e) => console.error("uncaught:", e?.stack || e));
process.on("unhandledRejection", (e) => console.error("unhandled:", e?.stack || e));

if (cmd === "serve") {
  serve().catch((e) => { console.error(e.message); process.exit(1); });
} else {
  console.error(`unknown command: ${cmd}\nusage: taksim serve`);
  process.exit(2);
}
