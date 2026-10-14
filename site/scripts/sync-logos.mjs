// Copies the CLI marks from the native app (native/Sources/Taksim/Logos.swift) into site/index.html, so the
// site draws the same logos as the canvas. Run after the app's logos change: npm run site:logos
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const swift = readFileSync(root + "native/Sources/Taksim/Logos.swift", "utf8");
const page = root + "site/index.html";
const html = readFileSync(page, "utf8");

// codex has no mark in the app either: it draws the terminal symbol, and so does the site
const NAMES = ["claude", "gemini", "opencode", "copilot"];
const paths = Object.fromEntries([...swift.matchAll(/"(\w+)":\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]));
const missing = NAMES.filter((n) => !paths[n]);
if (missing.length) throw new Error(`Logos.swift has no path for: ${missing.join(", ")}`);

const block = /(\/\/ logos:start[^\n]*\n)[\s\S]*?(\n\s*\/\/ logos:end)/;
if (!block.test(html)) throw new Error("site/index.html has no logos:start / logos:end markers");
const body = "  var LOGO = {\n" + NAMES.map((n) => `    ${n}: '${paths[n]}'`).join(",\n") + "\n  };";
const next = html.replace(block, (_, a, b) => a + body + b);

writeFileSync(page, next);
console.log(next === html ? "logos: already in sync" : `logos: updated ${NAMES.join(", ")}`);
