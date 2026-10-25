// Packs the engine a desktop release carries, as native/scripts/release.sh does for the Mac app: bin, src, ui,
// toolbox, the runtime modules it loads (ws, node-pty's binaries, Monaco's built files) and a Node runtime, into
// dist/engine/<platform>-<arch>, where electron-builder takes it (desktop/electron-builder.yml, extraResources).
//   node desktop/scripts/stage-engine.mjs [--platform linux|win32|darwin] [--arch x64|arm64]
// The Node runtime is this one when the target is this machine, else the same version from nodejs.org, checked
// against its SHASUMS256. node-pty ships binaries for macOS and Windows; on Linux it is built by `npm ci`, so a
// Linux engine is staged on a Linux machine of the same architecture.
import { cpSync, rmSync, mkdirSync, existsSync, chmodSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const platform = arg('platform', process.platform), arch = arg('arch', process.arch);
const native = platform === process.platform && arch === process.arch;
const out = join(root, 'dist', 'engine', `${platform}-${arch}`);
const exe = platform === 'win32' ? 'node.exe' : 'node';

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'node_modules'), { recursive: true });
for (const p of ['bin', 'src', 'ui', 'toolbox', 'package.json', 'LICENSE']) if (existsSync(join(root, p))) cpSync(join(root, p), join(out, p), { recursive: true });

const mod = (p) => join(root, 'node_modules', p), to = (p) => join(out, 'node_modules', p);
cpSync(mod('ws'), to('ws'), { recursive: true });
for (const p of ['package.json', 'lib', 'LICENSE']) if (existsSync(mod(`node-pty/${p}`))) cpSync(mod(`node-pty/${p}`), to(`node-pty/${p}`), { recursive: true });
const prebuilt = mod(`node-pty/prebuilds/${platform}-${arch}`);
if (existsSync(prebuilt)) cpSync(prebuilt, to(`node-pty/prebuilds/${platform}-${arch}`), { recursive: true });
else if (native && existsSync(mod('node-pty/build/Release'))) {
  // only the binaries: the build directory also holds the compiler's objects
  mkdirSync(to('node-pty/build/Release'), { recursive: true });
  for (const f of ['pty.node', 'spawn-helper']) if (existsSync(mod(`node-pty/build/Release/${f}`))) copyFileSync(mod(`node-pty/build/Release/${f}`), to(`node-pty/build/Release/${f}`));
} else throw new Error(`node-pty has no binary for ${platform}-${arch}: stage it on that system after npm ci`);
// node-pty's helper arrives without its exec bit; without it no terminal opens ("posix_spawnp failed")
for (const helper of [to(`node-pty/prebuilds/${platform}-${arch}/spawn-helper`), to('node-pty/build/Release/spawn-helper')]) if (existsSync(helper)) chmodSync(helper, 0o755);
for (const p of ['package.json', 'min', 'LICENSE']) if (existsSync(mod(`monaco-editor/${p}`))) cpSync(mod(`monaco-editor/${p}`), to(`monaco-editor/${p}`), { recursive: true });

mkdirSync(join(out, 'runtime'), { recursive: true });
if (native) copyFileSync(process.execPath, join(out, 'runtime', exe));
else await download(join(out, 'runtime', exe));
if (platform !== 'win32') chmodSync(join(out, 'runtime', exe), 0o755);

// the runtime and node-pty work together, as release.sh checks before signing
if (native) {
  execFileSync(join(out, 'runtime', exe), ['--input-type=module', '-e', `
    import pty from "node-pty";
    const p = pty.spawn(process.platform === "win32" ? "cmd.exe" : "/bin/sh", process.platform === "win32" ? ["/c", "echo ok"] : ["-c", "echo ok"], {});
    let out = ""; p.onData((d) => { out += d; });
    p.onExit(() => { if (!out.includes("ok")) { console.error("no output from the terminal"); process.exit(1); } process.exit(0); });
    setTimeout(() => { console.error("the terminal did not finish"); process.exit(1); }, 10000);
  `], { cwd: out, stdio: 'inherit' });
}
console.log(`engine staged for ${platform}-${arch} in ${out}`);

/** this Node's version for the target from nodejs.org, its checksum verified, cached in dist/cache */
async function download(dest) {
  const v = process.version, os = platform === 'win32' ? 'win' : platform;
  const name = `node-${v}-${os}-${arch}.${platform === 'win32' ? 'zip' : platform === 'linux' ? 'tar.xz' : 'tar.gz'}`;
  const cache = join(root, 'dist', 'cache'), file = join(cache, name);
  mkdirSync(cache, { recursive: true });
  const sums = await (await fetch(`https://nodejs.org/dist/${v}/SHASUMS256.txt`)).text();
  const want = sums.split('\n').find((l) => l.endsWith(`  ${name}`))?.split(' ')[0];
  if (!want) throw new Error(`nodejs.org has no ${name}`);
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  if (!existsSync(file) || sha(readFileSync(file)) !== want) {
    const r = await fetch(`https://nodejs.org/dist/${v}/${name}`);
    if (!r.ok) throw new Error(`could not download ${name}: ${r.status}`);
    const body = Buffer.from(await r.arrayBuffer());
    if (sha(body) !== want) throw new Error(`${name} does not match its checksum`);
    writeFileSync(file, body);
  }
  const unpack = join(cache, name.replace(/\.(zip|tar\.xz|tar\.gz)$/, ''));
  rmSync(unpack, { recursive: true, force: true });
  // bsdtar (macOS, Windows 10+) reads zip and xz alike; GNU tar reads the tarballs. On Windows it is the system's
  // own tar.exe: Git's GNU tar on PATH there reads D:\… as a remote host
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-xf', file, '-C', cache]);
  copyFileSync(join(unpack, platform === 'win32' ? 'node.exe' : 'bin/node'), dest);
  if (existsSync(join(unpack, 'LICENSE'))) copyFileSync(join(unpack, 'LICENSE'), join(dirname(dest), 'LICENSE'));
}
