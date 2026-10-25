// OS choices shared by the engine's terminal surfaces. Keep UI code out of this module.
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

export function terminalShell(env = process.env, platform = process.platform) {
  if (platform === "win32") return env.ComSpec || env.COMSPEC || "cmd.exe";
  return env.SHELL || (platform === "darwin" ? "/bin/zsh" : "/bin/sh");
}

/**
 * The OS's own choose-folder dialog for the folder picker outside a desktop shell: [command, args], or null when
 * none is available. `has(name)` says whether a program is on PATH (Linux offers zenity on GNOME, kdialog on KDE).
 */
export function folderDialog(start, prompt, { platform = process.platform, has = () => false } = {}) {
  if (platform === "darwin") {
    const from = typeof start === "string" && start.startsWith("/") ? start : null;
    const script = `POSIX path of (choose folder with prompt ${JSON.stringify(prompt)}${from ? ` default location (POSIX file ${JSON.stringify(from)})` : ""})`;
    return ["osascript", ["-e", 'tell application "System Events" to activate', "-e", script]];
  }
  if (platform === "win32") {
    const quote = (s) => "'" + String(s).replace(/'/g, "''") + "'";
    const script = "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; "
      + `$d.Description = ${quote(prompt)}; $d.UseDescriptionForTitle = $true; `
      + (start ? `$d.SelectedPath = ${quote(start)}; ` : "")
      + "if ($d.ShowDialog() -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }";
    return ["powershell.exe", ["-NoProfile", "-STA", "-Command", script]];
  }
  if (has("zenity")) return ["zenity", ["--file-selection", "--directory", `--title=${prompt}`, ...(start ? [`--filename=${start.replace(/\/?$/, "/")}`] : [])]];
  if (has("kdialog")) return ["kdialog", ["--getexistingdirectory", start || ".", "--title", prompt]];
  return null;
}

// ---------- starting programs (Windows: PATHEXT, npm's .cmd shims, no console windows, no process groups) ----------

/** a program on PATH: its full path (on Windows with one of PATHEXT's extensions), or null */
export function findProgram(name, { env = process.env, platform = process.platform, exists = existsSync } = {}) {
  const sep = platform === "win32" ? ";" : ":";
  const exts = platform === "win32" ? ["", ...(env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  const join = (d, n) => (platform === "win32" ? `${d.replace(/[\\/]+$/, "")}\\${n}` : `${d.replace(/\/+$/, "")}/${n}`);
  // on Windows a bare name with no extension is never the program (npm puts a sh script beside the .cmd)
  for (const dir of (env.PATH || env.Path || "").split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      if (platform === "win32" && !ext && !/\.[a-z0-9]+$/i.test(name)) continue;
      const p = join(dir, name + ext.toLowerCase());
      if (exists(p)) return p;
    }
  }
  return null;
}

/** the script an npm .cmd shim runs with node (`"%dp0%\node_modules\…\cli.js" %*`), or null */
export function shimScript(cmdFile, read = (f) => readFileSync(f, "utf8")) {
  let text;
  try { text = read(cmdFile); } catch { return null; }
  const m = /"%(?:~?dp0)%\\?([^"%]+\.(?:c?js|mjs))"\s+%\*/i.exec(text);
  if (!m) return null;
  return cmdFile.replace(/[\\/][^\\/]*$/, "") + "\\" + m[1].replace(/^[\\/]+/, "");
}

// cmd.exe's quoting, as cross-spawn does it: an argument quoted and its metacharacters escaped twice (a batch file
// reads %* once more), the program's path escaped once
const META = /([()\][%!^"`<>&|;, *?])/g;
const cmdArg = (arg) => `"${`${arg}`.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, "$1$1")}"`.replace(META, "^$1").replace(META, "^$1");
const cmdPath = (p) => p.replace(META, "^$1");

/**
 * What to start for `file args` on this OS: elsewhere as given; on Windows the program found through PATHEXT, an
 * npm shim's script run by this Node directly, any other .cmd or .bat through cmd.exe.
 */
export function resolveCommand(file, args = [], { env = process.env, platform = process.platform, exists = existsSync, read } = {}) {
  if (platform !== "win32") return { file, args };
  const found = /[\\/]/.test(file) ? (exists(file) ? file : findProgram(file.replace(/^.*[\\/]/, ""), { env, platform, exists }) ?? file) : findProgram(file, { env, platform, exists });
  if (!found) return { file, args };
  if (!/\.(cmd|bat)$/i.test(found)) return { file: found, args };
  const script = shimScript(found, read);
  if (script && exists(script)) return { file: process.execPath, args: [script, ...args] };
  const line = [cmdPath(found), ...args.map(cmdArg)].join(" ");
  return { file: env.ComSpec || env.COMSPEC || "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}

/** Windows names are case-blind: `{ ...process.env, PATH }` there holds Path and PATH; the later one is kept */
export function normalizeEnv(env, platform = process.platform) {
  if (platform !== "win32" || !env) return env;
  const out = {}, names = new Map();
  for (const [k, v] of Object.entries(env)) {
    const was = names.get(k.toUpperCase());
    if (was !== undefined) delete out[was];
    names.set(k.toUpperCase(), k);
    out[k] = v;
  }
  return out;
}

/** child_process.spawn that starts the same programs on Windows as elsewhere, without flashing console windows */
export function spawn(file, args = [], opts = {}) {
  if (process.platform !== "win32") return nodeSpawn(file, args, opts);
  const env = normalizeEnv(opts.env || process.env);
  const r = resolveCommand(file, args, { env });
  return nodeSpawn(r.file, r.args, { ...opts, env, windowsHide: true, ...(r.verbatim ? { windowsVerbatimArguments: true } : {}) });
}

/** a command line run by the OS's shell: /bin/sh -c elsewhere, cmd.exe /d /s /c on Windows */
export function shellSpawn(command, opts = {}) {
  if (process.platform !== "win32") return nodeSpawn("/bin/sh", ["-c", command], opts);
  return nodeSpawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${command}"`], { ...opts, env: normalizeEnv(opts.env), windowsHide: true, windowsVerbatimArguments: true });
}

/** stops a program and what it started: its process group elsewhere, its process tree on Windows (no groups there) */
export function killTree(child, signal = "SIGTERM") {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    try { nodeSpawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {}); } catch { /* gone */ }
    return;
  }
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* gone */ } }
}
