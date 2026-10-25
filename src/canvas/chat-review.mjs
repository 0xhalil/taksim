// A turn's immutable diff and reversible review decisions. Writes never touch the real Git index.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, chmodSync, lstatSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fromGit } from '../platform.mjs';
import { join, dirname, isAbsolute } from 'node:path';
import { snapshot } from './checkpoint.mjs';
import { inside } from '../ide/fs.mjs';
import { httpError } from '../http.mjs';
const run = promisify(execFile);
const git = async (dir, args, env = {}, binary = false) => (await run('git', ['-C', dir, ...args], { encoding: binary ? 'buffer' : 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 30000, env: { ...process.env, ...env, GIT_OPTIONAL_LOCKS: '0' } })).stdout;
const literal = (path) => `:(literal)${path}`;
const idOf = (text) => createHash('sha256').update(text).digest('hex').slice(0, 24);
export function reviewStates(agent, from, to, changes) {
  return { files: changes.map((c) => ({ path: c.path, status: agent.chatReviews?.[idOf(`${from}\0${to}\0${c.path}`)]?.status || 'pending' })) };
}
function fingerprint(path) {
  try {
    const s = lstatSync(path);
    return `${s.mode}:${s.size}:${s.isFile() ? idOf(readFileSync(path)) : s.mtimeMs}`;
  } catch (e) { if (e.code === 'ENOENT') return 'missing'; throw e; }
}
async function entry(root, tree, path) {
  return (await git(root, ['ls-tree', tree, '--', literal(path)])).trim().split('\t')[0];
}
export async function turnReview(agent, from, to, path) {
  if (![from, to].every((s) => /^[0-9a-f]{40,64}$/.test(s || '')) || typeof path !== 'string' || !path) throw httpError(400, 'Geçersiz değişiklik');
  const root = fromGit((await git(agent.workDir(), ['rev-parse', '--show-toplevel'])).trim());
  if (isAbsolute(path) || path.split('/').some((p) => ['..', '.git', ''].includes(p)) || path.includes('\0')) throw httpError(400, 'Geçersiz dosya yolu');
  inside(root, path);
  const patch = await git(root, ['diff', '--binary', '--no-ext-diff', '--no-textconv', '--no-renames', from, to, '--', literal(path)]);
  if (!patch) throw httpError(404, 'Bu turda dosya değişikliği yok');
  const oldEntry = await entry(root, from, path), newEntry = await entry(root, to, path);
  // Symlinks and submodules may be inspected but are never written by this feature.
  const writable = [oldEntry, newEntry].every((e) => !e || /^100(644|755) blob /.test(e));
  const binary = patch.includes('GIT binary patch');
  const lines = patch.split('\n'), start = lines.findIndex((l) => l.startsWith('@@ '));
  const hunks = [];
  if (!binary && start >= 0 && oldEntry && newEntry && oldEntry.slice(0, 6) === newEntry.slice(0, 6)) {
    let i = start;
    while (i < lines.length) {
      let end = i + 1; while (end < lines.length && !lines[end].startsWith('@@ ')) end++;
      const text = lines.slice(i, end).join('\n').replace(/\n*$/, '\n');
      hunks.push({ id: idOf(text), header: lines[i], diff: text }); i = end;
    }
  }
  const key = idOf(`${from}\0${to}\0${path}`);
  const state = agent.chatReviews?.[key] || { expected: to, status: 'pending', hunks: {} };
  return { root, patch, key, writable, from, to, path, binary, status: state.status, expected: state.expected,
    hunks: hunks.map((h) => ({ ...h, status: state.hunks[h.id] || 'pending' })) };
}
export function publicReview(r) {
  const { root, patch, key, expected, ...view } = r;
  return { ...view, diff: view.binary ? '' : patch };
}
export async function changeReview(agent, r, action, hunkId) {
  if (!['keep', 'revert', 'redo'].includes(action)) throw httpError(400, 'Geçersiz inceleme işlemi');
  if (!r.writable && action !== 'keep') throw httpError(400, 'Bu dosya türü yalnızca incelenebilir');
  const hunk = hunkId ? r.hunks.find((h) => h.id === hunkId) : null;
  if (hunkId && !hunk) throw httpError(409, 'Değişiklik bloğu artık geçerli değil');
  const old = agent.chatReviews?.[r.key] || { expected: r.to, status: 'pending', hunks: {} };
  if (hunk && old.status === 'reverted') throw httpError(409, 'Dosya geri alındı; önce ileri alın');
  const state = structuredClone(old);
  if (action === 'redo' && (hunk ? state.hunks[hunk.id] : state.status) !== 'reverted') throw httpError(409, 'İleri alınacak değişiklik yok');
  if (action === 'keep' && (hunk ? state.hunks[hunk.id] : state.status) === 'reverted') throw httpError(409, 'Önce değişikliği ileri alın');
  const beforeWrite = fingerprint(inside(r.root, r.path));
  const now = await snapshot(r.root);
  if (!now || await entry(r.root, now, r.path) !== await entry(r.root, state.expected, r.path)) throw httpError(409, 'Dosya sonradan değişti; düzenlemeleriniz korundu. Güncel farkı inceleyin.');
  let target = now;
  if (action !== 'keep') {
    if (hunk) {
      if (action === 'revert' && state.hunks[hunk.id] === 'reverted') throw httpError(409, 'Değişiklik zaten geri alındı');
      const tmp = mkdtempSync(join(tmpdir(), 'taksim-review-'));
      try {
        const env = { GIT_INDEX_FILE: join(tmp, 'index') };
        await git(r.root, ['read-tree', now], env);
        const header = r.patch.slice(0, r.patch.indexOf('@@ ')).split('\n').filter((l) => !l.startsWith('index ')).join('\n');
        const patchFile = join(tmp, 'change.patch'); writeFileSync(patchFile, header + hunk.diff);
        try { await git(r.root, ['apply', '--cached', ...(action === 'revert' ? ['--reverse'] : []), '--', patchFile], env); }
        catch { throw httpError(409, 'Bu blok diğer değişikliklerle çakışıyor; dosya değişmedi'); }
        target = (await git(r.root, ['write-tree'], env)).trim();
      } finally { rmSync(tmp, { recursive: true, force: true }); }
    } else target = action === 'revert' ? r.from : r.to;
    const dest = inside(r.root, r.path);
    try { if (lstatSync(dest).isSymbolicLink()) throw httpError(409, 'Dosya bir bağlantıya dönüştü'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const targetEntry = await entry(r.root, target, r.path);
    const data = targetEntry ? await git(r.root, ['cat-file', '--filters', `--path=${r.path}`, `${target}:${r.path}`], {}, true) : null;
    // Recheck after asynchronous Git work, immediately before writing this one path.
    const checked = await snapshot(r.root);
    if (!checked || await entry(r.root, checked, r.path) !== await entry(r.root, now, r.path)) throw httpError(409, 'Dosya işlem sırasında değişti; düzenlemeleriniz korundu');
    if (fingerprint(inside(r.root, r.path)) !== beforeWrite) throw httpError(409, 'Dosya işlem sırasında değişti; düzenlemeleriniz korundu');
    if (data === null) rmSync(dest, { force: true });
    else {
      mkdirSync(dirname(dest), { recursive: true });
      const temp = join(dirname(dest), `.taksim-review-${randomUUID()}.tmp`);
      try {
        writeFileSync(temp, data, { flag: 'wx' }); chmodSync(temp, targetEntry.startsWith('100755') ? 0o755 : 0o644);
        const checkedDest = inside(r.root, r.path);
        if (fingerprint(checkedDest) !== beforeWrite) throw httpError(409, 'Dosya işlem sırasında değişti; düzenlemeleriniz korundu');
        renameSync(temp, checkedDest);
      } finally { rmSync(temp, { force: true }); }
    }
    state.expected = target;
  }
  if (hunk) { state.hunks[hunk.id] = action === 'revert' ? 'reverted' : 'kept'; state.status = 'partial'; }
  else {
    state.hunks = Object.fromEntries(r.hunks.map((h) => [h.id, action === 'keep' && state.hunks[h.id] === 'reverted' ? 'reverted' : action === 'revert' ? 'reverted' : 'kept']));
    state.status = action === 'keep' && Object.values(state.hunks).includes('reverted') ? 'partial' : action === 'revert' ? 'reverted' : 'kept';
  }
  agent.chatReviews ||= {}; agent.chatReviews[r.key] = state; agent.canvas.save();
  if (action !== 'keep') for (const a of agent.canvas.agents.values()) if (a.workDir() === agent.workDir()) agent.canvas.bus.emit('ide_files', { id: a.id, paths: [r.path], git: true });
  return publicReview(await turnReview(agent, r.from, r.to, r.path));
}
