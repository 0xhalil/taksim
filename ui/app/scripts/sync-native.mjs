// Copies what the web client shares with the native app and the engine: the app icon, the CLI logos (Logos.swift), the
// Turkish strings (TaksimKit/Tr*.swift) and the scene brick's model (src/bricks). Run after any of them changes: node ui/app/scripts/sync-native.mjs
import { readFileSync, readdirSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";

const native = new URL('../../../native/Sources/', import.meta.url);
const out = (name) => new URL('../' + name, import.meta.url);

const swift = readFileSync(new URL('Taksim/Logos.swift', native), 'utf8');
const section = (name) => swift.slice(swift.indexOf(`static let ${name}:`), swift.indexOf(']\n', swift.indexOf(`static let ${name}:`)));
const paths = Object.fromEntries([...section('paths').matchAll(/"(\w+)":\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]));
const icons = Object.fromEntries([...section('icons').matchAll(/"(\w+)":\s*##"([\s\S]*?)"##/g)].map((m) => [m[1], m[2]]));
const tiles = Object.fromEntries([...section('tiles').matchAll(/"(\w+)":\s*0x([0-9A-Fa-f]{6})/g)].map((m) => [m[1], '#' + m[2]]));
writeFileSync(out('logos.mjs'), '// Generated from native/Sources/Taksim/Logos.swift by scripts/sync-native.mjs.\nexport const logos = ' + JSON.stringify({ paths, icons, tiles }) + ';\n');

// "English": "Türkçe" pairs, Swift string escapes undone
const unescape = (s) => JSON.parse('"' + s.replace(/\\u\{([0-9A-Fa-f]+)\}/g, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/\\'/g, "'") + '"');
const tr = {};
const kit = new URL('TaksimKit/', native);
for (const f of readdirSync(kit).filter((f) => /^Tr.*\.swift$/.test(f)).sort()) {
  for (const m of readFileSync(new URL(f, kit), 'utf8').matchAll(/^\s*"((?:[^"\\]|\\.)*)":\s*"((?:[^"\\]|\\.)*)",?\s*$/gm)) tr[unescape(m[1])] = unescape(m[2]);
}
writeFileSync(out('tr.mjs'), '// Generated from native/Sources/TaksimKit/Tr*.swift by scripts/sync-native.mjs.\nexport const tr = ' + JSON.stringify(tr, null, 0) + ';\n');

// the scene brick's meaning, shared with the engine as it is (pure modules, no Node imports)
mkdirSync(out('shared'), { recursive: true });
for (const f of ['data.mjs', 'scene.mjs']) {
  const src = new URL(`../../../src/bricks/${f}`, import.meta.url);
  writeFileSync(out(`shared/${f}`), `// Copied from src/bricks/${f} by scripts/sync-native.mjs; edit that file, then run the script.\n` + readFileSync(src, 'utf8'));
}

// the app icon (native/scripts/make-icon.swift): the Electron window and dock, and the page's favicon
copyFileSync(new URL('../../../native/Resources/AppIcon.png', import.meta.url), out('icon.png'));

console.log(`logos: ${Object.keys(tiles).length} tiles; tr: ${Object.keys(tr).length} strings`);
