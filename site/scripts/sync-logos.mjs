// Copies the CLI marks from the native app (native/Sources/Taksim/Logos.swift) into site/index.html, so the
// site draws the same logos as the canvas: the one-colour marks (white on the brand colour), the products' own
// full-colour icons (drawn as they are) and the brand colours. Run after the app's logos change: npm run site:logos
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const swift = readFileSync(root + "native/Sources/Taksim/Logos.swift", "utf8");
const page = root + "site/index.html";
const html = readFileSync(page, "utf8");

const NAMES = ["claude", "codex", "gemini", "opencode", "copilot"];
const section = (name) => swift.slice(swift.indexOf(`static let ${name}:`), swift.indexOf("]\n", swift.indexOf(`static let ${name}:`)));
const paths = Object.fromEntries([...section("paths").matchAll(/"(\w+)":\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]));
const icons = Object.fromEntries([...section("icons").matchAll(/"(\w+)":\s*##"([\s\S]*?)"##/g)].map((m) => [m[1], m[2]]));
const tiles = Object.fromEntries([...section("tiles").matchAll(/"(\w+)":\s*0x([0-9A-Fa-f]{6})/g)].map((m) => [m[1], m[2]]));
const missing = NAMES.filter((n) => !paths[n] && !icons[n]);
if (missing.length) throw new Error(`Logos.swift has no mark for: ${missing.join(", ")}`);

const block = /(\/\/ logos:start[^\n]*\n)[\s\S]*?(\n\s*\/\/ logos:end)/;
if (!block.test(html)) throw new Error("site/index.html has no logos:start / logos:end markers");
const esc = (s) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const body = "  var LOGO = {\n" + NAMES.filter((n) => paths[n] && !icons[n]).map((n) => `    ${n}: '${paths[n]}'`).join(",\n") + "\n  };\n"
  + "  var ICON = {\n" + NAMES.filter((n) => icons[n]).map((n) => `    ${n}: '${esc(icons[n])}'`).join(",\n") + "\n  };";
let next = html.replace(block, (_, a, b) => a + body + b);
// the brand colours under the one-colour marks
next = next.replace(/--b-(\w+): #[0-9A-Fa-f]{6};/g, (m, n) => tiles[n] ? `--b-${n}: #${tiles[n]};` : m);

writeFileSync(page, next);
console.log(next === html ? "logos: already in sync" : `logos: updated ${NAMES.join(", ")}`);
