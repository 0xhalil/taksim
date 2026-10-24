// Named accounts per CLI ("work", "personal"). Each non-machine account has its own config directory, so
// several logins of the same CLI can be used side by side:
//   Claude Code  CLAUDE_CONFIG_DIR
//   Codex        CODEX_HOME
//   opencode     XDG_DATA_HOME (where auth.json and sessions live; the user's config stays shared)
//   Gemini CLI   GEMINI_CLI_HOME, with file storage instead of the shared OS keychain entry
//   Antigravity  the machine login only: the CLI keeps its Google login in the keychain and has no folder to point
//                elsewhere
// The "machine" account is the CLI's normal login on this computer (no env override).
// Logins run the CLI's own sign-in in a terminal; taksim never sees or stores passwords or tokens. It
// reads only who is signed in (email, plan) from the CLI's status output or its credential files.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, symlinkSync, rmSync, renameSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { HOME } from "./canvas/store.mjs";
import { Terminal } from "./term/pty.mjs";
import { CHAT_DIR, cfg, splitCmd } from "./config.mjs";
import { BACKENDS } from "./backends/index.mjs";
import { TAKSIM_SETTINGS as GEMINI_TAKSIM, googleLoginEnv } from "./backends/gemini.mjs";
import { signedInEmail } from "./backends/antigravity.mjs";
import { saveToken, readTokenSync, dropToken } from "./connectors.mjs";
import { startInstall, installState } from "./cli-install.mjs";

// an account's API key (Gemini): kept in the keychain under this name, never in accounts.json
const keyName = (a) => `account-${a.id}`;

const FILE = join(HOME, "accounts.json");
const ROOT_DIR = join(HOME, "accounts");

const mtime = (f) => { try { return statSync(f).mtimeMs; } catch { return null; } };
const jwtClaims = (t) => { try { return JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString()); } catch { return {}; } };
const OPENCODE_PROVIDERS = { "opencode-go": "OpenCode Go", opencode: "OpenCode Zen", anthropic: "Anthropic", openai: "OpenAI",
  "github-copilot": "GitHub Copilot", google: "Google", openrouter: "OpenRouter" };

// Per CLI: how an account is kept separate, what of the user's own setup is carried over (`sub`: the
// config's folder inside the account dir), how to read who is signed in, and how to sign in.
const KINDS = {
  claude: {
    label: "Claude Code",
    env: (dir) => ({ CLAUDE_CONFIG_DIR: dir }),
    home: () => join(homedir(), ".claude"),
    copy: ["settings.json", "CLAUDE.md"],
    link: ["skills", "agents", "commands"],
    status: async (a) => {
      const out = await runCli(a, ["auth", "status"]);
      try {
        const j = JSON.parse(out.slice(out.indexOf("{")));
        return { loggedIn: !!j.loggedIn, email: j.email || null, org: j.orgName || null, plan: j.subscriptionType || null };
      } catch { return { loggedIn: false }; }
    },
    login: ["auth", "login"],
  },
  codex: {
    label: "Codex (ChatGPT)",
    env: (dir) => ({ CODEX_HOME: dir }),
    home: () => process.env.CODEX_HOME || join(homedir(), ".codex"),
    copy: ["config.toml", "AGENTS.md"],
    link: [],
    // auth.json's id token names the account and plan; only those claims are read
    status: async (a) => {
      const file = join(a.dir || KINDS.codex.home(), "auth.json");
      let j;
      try { j = JSON.parse(readFileSync(file, "utf8")); } catch { return { loggedIn: false }; }
      const claims = jwtClaims(j.tokens?.id_token || "");
      const plan = claims["https://api.openai.com/auth"]?.chatgpt_plan_type;
      const loggedIn = !!(j.tokens?.refresh_token || j.OPENAI_API_KEY);
      return { loggedIn, email: claims.email || null, org: null, plan: plan ? `ChatGPT ${plan}` : j.OPENAI_API_KEY ? "API key" : null, stamp: mtime(file) };
    },
    login: ["login"],
  },
  opencode: {
    label: "opencode",
    env: (dir) => ({ XDG_DATA_HOME: join(dir, "data") }),
    home: () => join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode"),
    copy: [],
    link: [],
    // the providers in auth.json (OpenCode Go, Zen, ...): their names, never their keys
    status: async (a) => {
      const file = join(a.dir ? join(a.dir, "data", "opencode") : KINDS.opencode.home(), "auth.json");
      let providers = [];
      try { providers = Object.keys(JSON.parse(readFileSync(file, "utf8"))); } catch {}
      return { loggedIn: providers.length > 0, email: null, org: null,
        plan: providers.map((p) => OPENCODE_PROVIDERS[p] || p).join(", ") || null, stamp: mtime(file) };
    },
    login: ["auth", "login"],
  },
  copilot: {
    label: "GitHub Copilot",
    env: (dir) => ({ COPILOT_HOME: dir }),
    home: () => process.env.COPILOT_HOME || join(homedir(), ".copilot"),
    copy: ["settings.json", "mcp-config.json"],
    link: ["skills", "agents"],
    // config.json (with // comments) names the signed-in GitHub users; the token itself is in the keychain
    status: async (a) => {
      const file = join(a.dir || KINDS.copilot.home(), "config.json");
      let j = {};
      try { j = JSON.parse(readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "")); } catch {}
      const key = Object.keys(j).find((k) => /^last_?logged_?in_?user$/i.test(k));
      const users = j[Object.keys(j).find((k) => /^logged_?in_?users$/i.test(k))] || [];
      const user = j[key] || users[0];
      const token = !a.dir && (process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN);
      return { loggedIn: !!user || !!token, email: user?.login || null, org: user?.host && !/github\.com/.test(user.host) ? user.host : null,
        plan: user || token ? "Copilot" : null, stamp: mtime(file) };
    },
    login: ["login"],
  },
  gemini: {
    label: "Gemini CLI",
    env: (dir) => ({ GEMINI_CLI_HOME: dir, GEMINI_FORCE_FILE_STORAGE: "true", ...googleLoginEnv(dir) }),
    // the Google login signs in as the person, not as a service account the shell exports
    machineEnv: () => googleLoginEnv(),
    home: () => join(homedir(), ".gemini"),
    sub: ".gemini",
    copy: ["settings.json", "GEMINI.md"],
    link: ["extensions", "skills", "commands"],
    // signed in when a credential file exists (the machine login may keep it in the keychain instead,
    // so there the active Google account counts too)
    status: async (a) => {
      if (a.apiKey) return { loggedIn: !!readTokenSync(keyName(a)), email: null, org: null, plan: "API key", stamp: a.apiKeyAt || null };
      const base = a.dir ? join(a.dir, ".gemini") : KINDS.gemini.home();
      const creds = ["gemini-credentials.json", "oauth_creds.json"].map((f) => join(base, f)).find(existsSync);
      let active = null, type = null;
      try { active = JSON.parse(readFileSync(join(base, "google_accounts.json"), "utf8")).active || null; } catch {}
      try { type = JSON.parse(readFileSync(join(base, "settings.json"), "utf8")).security?.auth?.selectedType || null; } catch {}
      const plan = { "oauth-personal": "Google", "gemini-api-key": "API key", "vertex-ai": "Vertex AI" }[type] || null;
      return { loggedIn: !!creds || (!a.dir && !!active), email: active, org: null, plan, stamp: creds ? mtime(creds) : null };
    },
    login: ["--skip-trust"], // its TUI asks how to sign in; it keeps running after, so taksim closes it
    // the account's own settings: never self-update the shared install from an agent run; taksim's MCP server
    // and turn hooks (their urls come from each agent's environment)
    seed: (dir) => {
      const f = join(dir, ".gemini", "settings.json");
      const s = readJson(f);
      s.general = { ...s.general, disableAutoUpdate: true };
      s.mcpServers = { ...s.mcpServers, ...GEMINI_TAKSIM.mcpServers };
      s.hooks = { ...s.hooks, ...GEMINI_TAKSIM.hooks };
      mkdirSync(join(dir, ".gemini"), { recursive: true });
      writeJson(f, s);
    },
  },
  antigravity: {
    label: "Antigravity",
    machineOnly: true,
    env: () => ({}),
    home: () => join(homedir(), ".gemini", "antigravity-cli"),
    copy: [], link: [],
    // signed in when its model list came (it needs the login) or its log names who signed in
    status: async () => {
      const agy = BACKENDS.find((b) => b.name === "antigravity");
      const email = signedInEmail();
      return { loggedIn: !!agy?.details?.length || !!email, email, org: null, plan: email || agy?.details?.length ? "Google" : null, stamp: null };
    },
    login: [], // its TUI signs in with Google in the browser; it keeps running after, so taksim closes it
  },
};
// test backend: fake-cli reports FAKE_CONFIG_DIR, "fake-cli status" prints a status line. Its machine login
// lives in HOME/fake-home and starts signed out, so the sign-in flow can be tried end to end.
if (cfg.fake) {
  const fakeHome = join(HOME, "fake-home");
  if (!existsSync(fakeHome)) { mkdirSync(fakeHome, { recursive: true }); writeFileSync(join(fakeHome, "logged-out"), ""); }
  KINDS.fake = { label: "test", env: (dir) => ({ FAKE_CONFIG_DIR: dir }), home: () => fakeHome, machineEnv: () => ({ FAKE_CONFIG_DIR: fakeHome }), copy: [], link: [],
    status: async (a) => {
      try { const j = JSON.parse(await runCli(a, ["--model", "fake-status"])); return { loggedIn: !!j.loggedIn, email: j.email || null }; }
      catch { return { loggedIn: false }; }
    },
    login: ["--model", "fake-login"] };
}
export const ACCOUNT_BACKENDS = Object.keys(KINDS);
export const _KINDS = KINDS; // for tests of the status readers

let accounts = load();
const statusCache = new Map(); // id -> { loggedIn, email, org, plan, checkedAt }
const logins = new Map();      // id -> { term, url, done, before, timer }
const starting = new Map();    // id -> pending startLogin, so parallel POSTs share one login
const lastLogin = new Map();   // id -> how the latest login ended, for the UI

function load() {
  try { return JSON.parse(readFileSync(FILE, "utf8")).accounts || []; } catch { return []; }
}

function save() {
  mkdirSync(HOME, { recursive: true });
  writeFileSync(FILE + ".tmp", JSON.stringify({ accounts }, null, 2));
  renameSync(FILE + ".tmp", FILE);
}

const err = (status, message) => Object.assign(new Error(message), { status });

export function listAccounts() {
  return accounts.map((a) => ({ ...a, label: KINDS[a.backend]?.label || a.backend,
    status: statusCache.get(a.id) || null, loggingIn: logins.has(a.id) }));
}

// The CLIs accounts can be made for, and whether each is installed here. A CLI that is found is no longer
// installing: npm puts the command in place a moment before it exits, and the list showed both at once.
export function accountBackends() {
  return ACCOUNT_BACKENDS.map((name) => {
    const found = installed(name);
    return { name, label: KINDS[name].label, installed: found, ...(KINDS[name].machineOnly ? { named: false } : {}), ...(found ? { installing: false, installError: null } : installState(name)) };
  });
}

// Installs a CLI that isn't on this computer (see cli-install.mjs); the list above shows how it goes.
export function installBackend(backend) {
  if (typeof backend !== "string" || !Object.hasOwn(KINDS, backend)) throw err(400, `backend must be one of: ${ACCOUNT_BACKENDS.join(", ")}`);
  const out = startInstall(backend, installed);
  if (out.error) throw err(400, out.error);
  return out;
}

// By id or (case-insensitive) name; agents and people refer to accounts by name.
export function findAccount(ref) {
  if (!ref) return null;
  const r = String(ref).toLowerCase();
  return accounts.find((a) => a.id === ref) || accounts.find((a) => a.name.toLowerCase() === r) || null;
}

export function createAccount({ name, backend, machine = false, copy_settings = true, draft = false } = {}) {
  name = typeof name === "string" ? name.trim() : "";
  if (!name) throw err(400, "name is required");
  if (typeof backend !== "string" || !Object.hasOwn(KINDS, backend)) throw err(400, `backend must be one of: ${ACCOUNT_BACKENDS.join(", ")}`);
  if (findAccount(name)) throw err(409, `an account named "${name}" already exists`);
  if (!machine && KINDS[backend].machineOnly) throw err(400, `${KINDS[backend].label} signs in only as this computer's login`);
  if (machine && accounts.some((a) => a.backend === backend && !a.dir)) {
    throw err(409, `this machine's ${backend} login already has a name`);
  }
  const id = randomUUID().slice(0, 8);
  let dir = null;
  if (!machine) {
    dir = join(ROOT_DIR, backend, id);
    mkdirSync(dir, { recursive: true });
    if (copy_settings) carryOverSettings(KINDS[backend], dir);
    KINDS[backend].seed?.(dir);
  }
  // a draft is an account being added: kept once its first sign-in lands, gone if that sign-in doesn't (settleDraft)
  const account = { id, name, backend, dir, createdAt: Date.now(), ...(draft === true && !machine ? { draft: true } : {}) };
  prepareClaude(account);
  accounts.push(account);
  save();
  return account;
}

// The user's settings, instructions and skills, never credentials or session history. settings.json is
// merged so what the account already set (e.g. its theme) wins.
function carryOverSettings(kind, dir) {
  const home = kind.home();
  const to = kind.sub ? join(dir, kind.sub) : dir;
  mkdirSync(to, { recursive: true });
  for (const f of kind.copy) {
    const src = join(home, f), dst = join(to, f);
    if (!existsSync(src)) continue;
    if (f === "settings.json" && existsSync(dst)) {
      writeJson(dst, { ...readJson(src), ...readJson(dst) });
    } else if (!existsSync(dst)) {
      copyFileSync(src, dst);
    }
  }
  for (const d of kind.link) {
    if (existsSync(join(home, d)) && !existsSync(join(to, d))) symlinkSync(join(home, d), join(to, d));
  }
}

export function carryOver(ref) {
  const a = findAccount(ref);
  if (!a) throw err(404, `no account ${ref}`);
  if (!a.dir) throw err(400, "the machine login already uses your settings");
  const kind = KINDS[a.backend];
  if (!kind.copy.length && !kind.link.length) throw err(400, `${kind.label} accounts share your settings already`);
  carryOverSettings(kind, a.dir);
  kind.seed?.(a.dir);
  if (a.backend === "claude") prepareClaude(a);
}

function realpathOr(p) { try { return realpathSync(p); } catch { return p; } }

function readJson(f) { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return {}; } }
function writeJson(f, data) {
  writeFileSync(f + ".taksim-tmp", JSON.stringify(data, null, 2));
  renameSync(f + ".taksim-tmp", f);
}

// A separate Claude config dir starts with first-run onboarding (theme picker, then a login step) even
// after `claude auth login`. Mark onboarding done so the account's TUI opens straight to the prompt, and
// trust taksim's own workspace folders. Only touches config dirs taksim created, never ~/.claude.
function prepareClaude(account, trustDir) {
  if (!account?.dir || account.backend !== "claude") return;
  const stateFile = join(account.dir, ".claude.json");
  if (!existsSync(stateFile) && !existsSync(account.dir)) return;
  const state = existsSync(stateFile) ? readJson(stateFile) : {};
  if (existsSync(stateFile) && !Object.keys(state).length) return; // unreadable: leave it to Claude
  let changed = false;
  if (!state.hasCompletedOnboarding) { state.hasCompletedOnboarding = true; changed = true; }
  if (trustDir && trustDir.startsWith(HOME + "/")) {
    state.projects ||= {};
    // Claude keys projects by the real path (e.g. /private/var/... for /var/...)
    for (const key of new Set([trustDir, realpathOr(trustDir)])) {
      const p = (state.projects[key] ||= {});
      if (!p.hasTrustDialogAccepted) { p.hasTrustDialogAccepted = true; changed = true; }
    }
  }
  if (changed) writeJson(stateFile, state);
  // the theme picker is part of onboarding: carry the user's theme over
  const settingsFile = join(account.dir, "settings.json");
  const settings = readJson(settingsFile);
  if (!settings.theme) {
    settings.theme = readJson(join(homedir(), ".claude", "settings.json")).theme || "dark";
    writeJson(settingsFile, settings);
  }
}

// Called before an agent's terminal starts under this account.
export function prepareForTerminal(ref, cwd) {
  const a = findAccount(ref);
  if (a) prepareClaude(a, cwd);
}

// A new name for an account; agents and people refer to it by name, so names stay unique.
export function renameAccount(ref, name) {
  const a = findAccount(ref);
  if (!a) throw err(404, `no account ${ref}`);
  name = typeof name === "string" ? name.trim() : "";
  if (!name) throw err(400, "name is required");
  const other = findAccount(name);
  if (other && other !== a) throw err(409, `an account named "${name}" already exists`);
  a.name = name;
  save();
  return a;
}

export function removeAccount(ref) {
  const a = findAccount(ref);
  if (!a) throw err(404, `no account ${ref}`);
  stopLogin(a.id);
  if (a.apiKey) dropToken(keyName(a)).catch(() => {});
  accounts = accounts.filter((x) => x !== a);
  save();
  // its CLIs (the login, agents' terminals) were just stopped and may still write on their way out
  const drop = () => rmSync(a.dir, { recursive: true, force: true });
  if (a.dir && a.dir.startsWith(ROOT_DIR + "/")) { drop(); setTimeout(drop, 3000).unref?.(); }
  statusCache.delete(a.id);
  lastLogin.delete(a.id);
  return a;
}

// Environment that points a CLI at the account's config directory ({} for the machine login).
export function accountEnv(account) {
  if (!account?.dir || !KINDS[account.backend]) return {};
  const env = KINDS[account.backend].env(account.dir);
  // a Gemini account made before taksim wrote its part (or its permission hook) into the settings gets it now
  if (account.backend === "gemini" && existsSync(account.dir) && (s => !s.mcpServers?.taksim || !s.hooks?.BeforeTool)(readJson(join(account.dir, ".gemini", "settings.json")))) {
    try { KINDS.gemini.seed(account.dir); } catch { /* its CLI runs without taksim's tools */ }
  }
  // signed in with an API key: the CLI gets it from the environment, read from the keychain as it starts
  if (account.apiKey) { const k = readTokenSync(keyName(account)); if (k) env.GEMINI_API_KEY = k; }
  return env;
}

// Signs a Gemini account in with an API key (Google AI Studio) instead of a Google login: on a computer whose
// Google account can't be used, the key is all it needs. Checked with Google first, then kept in the keychain.
export async function setApiKey(ref, key) {
  const a = findAccount(ref);
  if (!a) throw err(404, `no account ${ref}`);
  if (a.backend !== "gemini") throw err(400, "only Gemini accounts take an API key");
  if (!a.dir) throw err(400, "add a named Gemini account for the key; this computer's own login stays as it is");
  key = typeof key === "string" ? key.trim() : "";
  if (!key || /\s/.test(key)) throw err(400, "paste the API key");
  if (!cfg.fake) {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(10000) })
      .catch((e) => ({ ok: false, status: 0, text: async () => e.message }));
    if (!r.ok) throw err(400, `Google didn't accept the key (${r.status || "no answer"})`);
  }
  await saveToken(keyName(a), key);
  a.apiKey = true; a.apiKeyAt = Date.now();
  delete a.draft; // signed in with its key: the account being added is kept
  save();
  // the account's CLI signs in with the key from now on
  const f = join(a.dir, ".gemini", "settings.json");
  const s = readJson(f);
  s.security = { ...s.security, auth: { ...s.security?.auth, selectedType: "gemini-api-key" } };
  mkdirSync(join(a.dir, ".gemini"), { recursive: true });
  writeJson(f, s);
  return accountStatus(a.id);
}
// For reading a login's status and signing it in: the machine login's own env where a CLI needs one (Gemini's
// Google login, the test CLI's folder).
function loginEnv(account) {
  return account?.dir ? accountEnv(account) : KINDS[account?.backend]?.machineEnv?.() || {};
}

// The CLI's command: its backend's (which honors TAKSIM_*_BIN), else its usual name.
function cliCommand(backend) {
  const cmd = BACKENDS.find((b) => b.name === backend)?.cmd
    || splitCmd(process.env[`TAKSIM_${backend.toUpperCase()}_BIN`] || backend);
  const [file, ...pre] = cmd;
  return { file, pre };
}

function installed(backend) {
  const { file } = cliCommand(backend);
  if (file.includes("/")) return existsSync(file);
  return (process.env.PATH || "").split(delimiter).some((d) => d && existsSync(join(d, file)));
}

function runCli(a, args) {
  const { file, pre } = cliCommand(a.backend);
  return new Promise((resolve) => {
    const child = spawn(file, [...pre, ...args], {
      cwd: CHAT_DIR, env: { ...process.env, ...loginEnv(a) }, stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    child.stdout.on("data", (c) => (buf += c));
    child.stderr.on("data", (c) => (buf += c));
    child.on("close", () => resolve(buf));
    child.on("error", () => resolve(""));
    setTimeout(() => child.kill(), 20000).unref();
  });
}

export async function accountStatus(ref) {
  const a = findAccount(ref);
  if (!a) throw err(404, `no account ${ref}`);
  if (!installed(a.backend)) {
    const status = { loggedIn: false, missing: true, checkedAt: Date.now() };
    statusCache.set(a.id, status);
    return status;
  }
  const status = { email: null, org: null, plan: null, ...(await KINDS[a.backend].status(a)), checkedAt: Date.now() };
  statusCache.set(a.id, status);
  return status;
}

// This computer's own login of a CLI (no account dir), whether or not an account names it.
export async function machineStatus(backend) {
  if (!KINDS[backend]) throw err(404, `no CLI ${backend}`);
  if (!installed(backend)) return { loggedIn: false, missing: true };
  return { email: null, org: null, plan: null, ...(await KINDS[backend].status({ id: "machine", backend, dir: null })), checkedAt: Date.now() };
}

// The sign-in page of a login, for an "open it" button when the browser didn't open by itself: what the
// CLI asked the browser to open (see openShim), else a link it printed. Links inside TUI boxes are
// skipped: they're cut at the box edge.
function signInUrl(session) {
  try {
    const opened = readFileSync(session.openedFile, "utf8").trim().split("\n").filter((u) => /^https?:\/\//.test(u));
    if (opened.length) return opened.at(-1);
  } catch {}
  const lines = session.term.tail.split(/\r?\n/).filter((l) => !l.includes("│"));
  const urls = (lines.join(" ").match(/https?:\/\/[^\s"'<>]+/g) || []).filter((u) => !/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(u));
  return urls.reverse().find((u) => /oauth|authorize|login|signin|auth\?/i.test(u)) || null;
}

// A login's `open` / `xdg-open`: notes the page in $TAKSIM_OPENED, then opens it with the real command.
function openShim() {
  const dir = join(HOME, "login-bin");
  mkdirSync(dir, { recursive: true });
  for (const name of ["open", "xdg-open"]) {
    const f = join(dir, name);
    const script = `#!/bin/sh\n# taksim: remember the sign-in page for the login window, then open it as usual\n`
      + `for a in "$@"; do case "$a" in http://*|https://*) printf '%s\\n' "$a" >> "$TAKSIM_OPENED";; esac; done\n`
      + `[ -n "$TAKSIM_REAL_${name === "open" ? "OPEN" : "XDG_OPEN"}" ] && exec "$TAKSIM_REAL_${name === "open" ? "OPEN" : "XDG_OPEN"}" "$@"\nexit 0\n`;
    if (!existsSync(f) || readFileSync(f, "utf8") !== script) writeFileSync(f, script, { mode: 0o755 });
  }
  const real = (name) => (process.env.PATH || "").split(delimiter).filter((d) => d && d !== dir)
    .map((d) => join(d, name)).find(existsSync) || "";
  return { PATH: `${dir}${delimiter}${process.env.PATH || ""}`, TAKSIM_REAL_OPEN: real("open"), TAKSIM_REAL_XDG_OPEN: real("xdg-open") };
}

// Runs the CLI's own sign-in in a PTY the UI shows in a terminal; it opens the browser. While it runs the
// account's status is polled: once it turns signed-in the login counts as done, and a CLI that stays
// open afterwards (Gemini's TUI) is closed.
export async function startLogin(ref, { private: privately = false } = {}) {
  const a = findAccount(ref);
  if (!a) throw err(404, `no account ${ref}`);
  if (logins.has(a.id)) return logins.get(a.id);
  if (starting.has(a.id)) return starting.get(a.id);
  if (!installed(a.backend)) throw err(400, `${KINDS[a.backend].label} is not installed on this computer`);
  // reserve synchronously: two parallel POSTs share one login instead of opening two PTYs.
  const pending = (async () => {
    const before = await accountStatus(a.id).catch(() => ({ loggedIn: false }));
    if (logins.has(a.id)) return logins.get(a.id);
  const { file, pre } = cliCommand(a.backend);
  const session = { term: null, url: null, done: false, before, startedAt: Date.now(), openedFile: join(HOME, "login-bin", `${a.id}-${Date.now()}.opened`) };
  const shim = openShim();
  if (privately) { shim.TAKSIM_REAL_OPEN = ""; shim.TAKSIM_REAL_XDG_OPEN = ""; } // noted, not opened: the app opens it privately
  session.private = privately;
  rmSync(session.openedFile, { force: true });
  session.term = new Terminal({
    file, args: [...pre, ...KINDS[a.backend].login], cwd: CHAT_DIR, cols: 100, rows: 28,
    env: { ...loginEnv(a), ...shim, TAKSIM_OPENED: session.openedFile },
    // it stays the running login until its status is read, so nobody sees it ended without a result
    onExit: async () => {
      clearInterval(session.timer);
      prepareClaude(a);
      const st = session.stopped ? null : await accountStatus(a.id).catch(() => null);
      if (!session.stopped && st?.loggedIn && signedInNow(st, before, true)) session.done = true;
      const current = logins.get(a.id) === session;
      if (current) {
        logins.delete(a.id);
        lastLogin.set(a.id, { done: session.done, url: session.url, endedAt: Date.now() });
      }
      rmSync(session.openedFile, { force: true });
      if (current || session.done) settleDraft(a, session.done);
    },
  });
  session.timer = setInterval(async () => {
    session.url = signInUrl(session) || session.url;
    if (session.done || session.checking) return;
    session.checking = true;
    const st = await accountStatus(a.id).catch(() => null);
    session.checking = false;
    if (st?.loggedIn && signedInNow(st, before, false) && logins.get(a.id) === session) {
      session.done = true;
      lastLogin.set(a.id, { done: true, url: session.url, endedAt: Date.now() });
      settleDraft(a, true);
      setTimeout(() => session.term.kill(), 1500); // let the CLI print its own confirmation first
    }
  }, a.backend === "claude" ? 2500 : 1200);
  session.timer.unref?.();
  logins.set(a.id, session);
  lastLogin.delete(a.id);
  return session;
  })();
  starting.set(a.id, pending);
  try { return await pending; } finally { starting.delete(a.id); }
}

// Signed in by this login: it wasn't before, or its credentials were rewritten (a re-login). Claude's
// status has no such stamp; its login exits by itself when done, which `exited` reports.
function signedInNow(st, before, exited) {
  if (!before?.loggedIn) return true;
  if (st.stamp && st.stamp !== before.stamp) return true;
  return exited;
}

export function loginState(ref) {
  const a = findAccount(ref);
  if (!a) throw err(404, `no account ${ref}`);
  const s = logins.get(a.id);
  if (s) s.url = signInUrl(s) || s.url;
  const last = lastLogin.get(a.id);
  return { running: !!s, done: s ? s.done : !!last?.done, url: s?.url || last?.url || null, private: !!s?.private, status: statusCache.get(a.id) || null };
}

export function loginTerminal(id) { return logins.get(id)?.term || null; }

export function stopLogin(ref) {
  const a = findAccount(ref);
  const s = a && logins.get(a.id);
  if (!s) return;
  // gone at once: a new login can start while this one's CLI is still exiting
  s.stopped = !s.done;
  clearInterval(s.timer);
  logins.delete(a.id);
  lastLogin.set(a.id, { done: s.done, url: s.url, endedAt: Date.now() });
  s.term.kill();
  settleDraft(a, s.done);
}

// An account being added (draft) whose first sign-in ended: kept when it signed in, removed when it didn't, so a
// cancelled, failed or abandoned add leaves no signed-out "Claude Code 2" behind. A Gemini draft stays when its
// browser sign-in is cancelled: it can still be signed in with an API key (setApiKey settles it then).
function settleDraft(a, signedIn) {
  if (!a.draft || !accounts.includes(a)) return;
  if (signedIn) { delete a.draft; save(); return; }
  if (a.backend === "gemini") return;
  try { removeAccount(a.id); } catch { /* removed meanwhile */ }
}

/** at start: drafts an earlier run left (the app quit mid sign-in) are kept if they did sign in, else removed */
export async function cleanDrafts() {
  for (const a of accounts.filter((x) => x.draft)) {
    const st = await accountStatus(a.id).catch(() => null);
    if (st?.loggedIn) { delete a.draft; save(); } else { try { removeAccount(a.id); } catch { /* gone */ } }
  }
}

export function stopAllLogins() {
  for (const [id, s] of logins) {
    clearInterval(s.timer);
    try { s.term.kill(); } catch {}
    lastLogin.set(id, { done: s.done, url: s.url, endedAt: Date.now() });
  }
  logins.clear();
}

// re-read accounts.json (tests point TAKSIM_HOME elsewhere before importing)
export function reloadAccounts() { accounts = load(); }
