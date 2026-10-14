#!/usr/bin/env node
// taksim CLI. P0 has one command; run/validate/ls/mcp arrive with the workflow engine.

import { serve } from "../src/server.mjs";

const [cmd = "serve"] = process.argv.slice(2);

if (cmd === "serve") {
  serve().catch((e) => { console.error(e.message); process.exit(1); });
} else {
  console.error(`unknown command: ${cmd}\nusage: taksim serve`);
  process.exit(2);
}
