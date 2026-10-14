#!/bin/sh
# Shows a message in every installed app (the header; important ones as a macOS notification too):
#   native/scripts/announce.sh "New: canvases sync" [--tr "Yeni: tuvaller eşitleniyor"] [--important]
#                              [--url https://…] [--until 2026-12-31] [--below 0.4.0] [--min 0.3.0]
#   native/scripts/announce.sh --remove <id>
# Appends to announcements.json in the releases repository (TAKSIM_RELEASE_REPO, default 0xhalil/taksim-releases).
# Apps look every few hours and on launch; each message shows once per app.
set -e
REPO="${TAKSIM_RELEASE_REPO:-0xhalil/taksim-releases}"
exec node --input-type=module - "$REPO" "$@" <<'JS'
import { execFileSync } from "node:child_process";
const [repo, ...args] = process.argv.slice(2);
const gh = (...a) => execFileSync("gh", a, { encoding: "utf8" });
let list = [], sha;
try {
  const f = JSON.parse(gh("api", `repos/${repo}/contents/announcements.json`));
  sha = f.sha; list = JSON.parse(Buffer.from(f.content, "base64").toString("utf8"));
} catch {}
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const removeId = opt("--remove");
let message;
if (removeId) { list = list.filter((a) => a.id !== removeId); message = `remove announcement ${removeId}`; }
else {
  const important = args.includes("--important") ? (args.splice(args.indexOf("--important"), 1), "important") : undefined;
  const a = { id: new Date().toISOString().replace(/\D/g, "").slice(0, 14), text: undefined, tr: opt("--tr"), level: important,
    url: opt("--url"), until: opt("--until"), below: opt("--below"), minVersion: opt("--min") };
  a.text = args.join(" ").trim();
  if (!a.text) { console.error("usage: announce.sh \"message\" [--tr …] [--important] [--url …] [--until YYYY-MM-DD] [--below v] [--min v]"); process.exit(2); }
  list.push(Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)));
  message = `announce ${a.id}`;
}
const body = JSON.stringify(list, null, 2) + "\n";
gh("api", "-X", "PUT", `repos/${repo}/contents/announcements.json`, "-f", `message=${message}`,
  "-f", `content=${Buffer.from(body).toString("base64")}`, ...(sha ? ["-f", `sha=${sha}`] : []));
console.log(body);
JS
