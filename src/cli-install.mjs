// Installs a coding CLI that isn't on this computer, so signing in to it can start from one click.
// They go to their own folder (HOME/cli: no sudo, no changes to the user's system) from the official npm
// packages; that folder's bin joins PATH after the user's own directories, so an install they already have wins.
// npm is the computer's own when there is one; otherwise npm itself is fetched once and run with the Node
// taksim ships. The CLIs that are Node scripts need `node` on PATH when they run: a link to that Node is
// placed beside them only when the computer has none.

import { spawn } from "./platform.mjs";
import { existsSync, mkdirSync, symlinkSync, rmSync, readdirSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { HOME } from "./canvas/store.mjs";

export const PACKAGES = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
  gemini: "@google/gemini-cli",
  copilot: "@github/copilot",
  opencode: "opencode-ai",
  // not on npm: Google's own build, as its install.sh fetches it (antigravity.google/cli/install.sh)
  antigravity: "agy",
};
const AGY_UPDATES = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app";

export const CLI_DIR = join(HOME, "cli");
export const CLI_BIN = join(CLI_DIR, "bin");
const NPM_DIR = join(CLI_DIR, "npm-tool");
const TIMEOUT_MS = 10 * 60 * 1000;

/** this folder's bin on PATH (after the user's own directories) */
export function useCliDir(env = process.env) {
  const dirs = (env.PATH || "").split(delimiter).filter(Boolean);
  if (!dirs.includes(CLI_BIN)) env.PATH = [...dirs, CLI_BIN].join(delimiter);
}
useCliDir();

const onPath = (file, env = process.env) => (env.PATH || "").split(delimiter).some((d) => d && existsSync(join(d, file)));

const jobs = new Map(); // backend -> { running, error, startedAt }
export const installState = (backend) => {
  const j = jobs.get(backend);
  return j ? { installing: !!j.running, installError: j.error || null } : { installing: false, installError: null };
};

function run(file, args, { env, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const keep = (c) => { tail = (tail + c).slice(-4000); };
    child.stdout.on("data", keep); child.stderr.on("data", keep);
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.on("error", (e) => { clearTimeout(timer); reject(new Error(e.message)); });
    child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve(tail) : reject(new Error(lastLines(tail) || `exit ${code}`)); });
  });
}
const lastLines = (s) => s.trim().split("\n").filter(Boolean).slice(-4).join("\n").slice(-600);

/** npm: the computer's own, else the one fetched into HOME/cli and run with taksim's Node */
async function npmCommand() {
  if (onPath("npm")) return { file: "npm", args: [], env: {} };
  const cli = join(NPM_DIR, "package", "bin", "npm-cli.js");
  if (!existsSync(cli)) {
    mkdirSync(NPM_DIR, { recursive: true });
    const meta = await (await fetch("https://registry.npmjs.org/npm/latest", { signal: AbortSignal.timeout(30000) })).json();
    const url = meta?.dist?.tarball;
    if (typeof url !== "string" || !url.startsWith("https://registry.npmjs.org/")) throw new Error("npm's registry did not name a download");
    const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`npm download failed (${res.status})`);
    const tgz = join(NPM_DIR, "npm.tgz");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(tgz, Buffer.from(await res.arrayBuffer()));
    await run("/usr/bin/tar", ["-xzf", tgz, "-C", NPM_DIR]);
    rmSync(tgz, { force: true });
    if (!existsSync(cli)) throw new Error("npm did not unpack");
  }
  // npm's own scripts and the packages' install steps find this Node first
  return { file: process.execPath, args: [cli], env: { PATH: [dirname(process.execPath), process.env.PATH || ""].join(delimiter) } };
}

/** Antigravity CLI: the platform's build from Google's release server, checked against its SHA-512, into HOME/cli/bin.
 *  install.sh would also add ~/.local/bin to the shell profiles; this leaves them as they are. */
async function installAgy() {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : null;
  if (!os || !arch) throw new Error(`Antigravity CLI has no build for ${process.platform}/${process.arch}`);
  const manifest = await (await fetch(`${AGY_UPDATES}/manifests/${os}_${arch}.json`, { signal: AbortSignal.timeout(30000) })).json();
  if (typeof manifest?.url !== "string" || !/^https:\/\//.test(manifest.url) || !/^[0-9a-f]{128}$/i.test(manifest.sha512 || "")) throw new Error("Antigravity's release server did not name a download");
  const res = await fetch(manifest.url, { signal: AbortSignal.timeout(300000) });
  if (!res.ok) throw new Error(`Antigravity download failed (${res.status})`);
  const data = Buffer.from(await res.arrayBuffer());
  const { createHash } = await import("node:crypto");
  if (createHash("sha512").update(data).digest("hex") !== manifest.sha512.toLowerCase()) throw new Error("the Antigravity download did not match its checksum");
  const { writeFile, rename, chmod, mkdtemp } = await import("node:fs/promises");
  mkdirSync(CLI_BIN, { recursive: true });
  const tmp = await mkdtemp(join(CLI_DIR, "agy-"));
  try {
    const target = join(tmp, "antigravity");
    if (/\.tar\.gz(\?|$)/.test(manifest.url)) {
      await writeFile(join(tmp, "agy.tar.gz"), data);
      await run("/usr/bin/tar", ["-xzf", join(tmp, "agy.tar.gz"), "-C", tmp, "antigravity"]);
    } else await writeFile(target, data);
    await chmod(target, 0o755);
    await rename(target, join(CLI_BIN, "agy"));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  useCliDir();
}

async function install(backend) {
  if (backend === "antigravity") return installAgy();
  const pkg = PACKAGES[backend];
  mkdirSync(CLI_BIN, { recursive: true });
  const npm = await npmCommand();
  await run(npm.file, [...npm.args, "install", "-g", "--prefix", CLI_DIR, "--no-fund", "--no-audit", "--loglevel=error", pkg],
    { env: { ...npm.env, npm_config_update_notifier: "false" }, cwd: CLI_DIR });
  // a Node-script CLI on a computer without Node: it runs with the one taksim ships
  if (!onPath("node") && !existsSync(join(CLI_BIN, "node"))) symlinkSync(process.execPath, join(CLI_BIN, "node"));
  useCliDir();
}

/** starts installing a CLI (once at a time per CLI); progress is `installState`, the end is `installed(backend)` turning true */
export function startInstall(backend, installed) {
  if (!Object.hasOwn(PACKAGES, backend)) return { error: `no install for ${backend}` };
  if (installed(backend)) return { installing: false, installError: null };
  const running = jobs.get(backend);
  if (running?.running) return installState(backend);
  const job = { running: true, error: null, startedAt: Date.now() };
  jobs.set(backend, job);
  install(backend).then(
    () => { job.running = false; if (!installed(backend)) job.error = "installed, but the command was not found"; },
    (e) => { job.running = false; job.error = String(e.message || e).slice(0, 600); },
  );
  return installState(backend);
}
