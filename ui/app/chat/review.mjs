// A turn's frozen changes, file by file and hunk by hunk (Chat/ChatReview.swift): keep or revert each, redo a
// revert, and ask the agent for a fix right beside the code it is about.
import { L } from '../theme.mjs';
import { api } from '../api.mjs';
import { icon } from '../icons.mjs';
import { el, btn, sheet } from '../ui.mjs';

export function openReview(entry, model, app, initialPath) {
  const base = model.path, from = entry.checkpoint, to = entry.after;
  let selected = initialPath ?? entry.changes?.[0]?.path ?? '', review = null, states = {}, busy = false, loading = false, error = null, commentHunk = null, sent = false;
  const root = el('div', 'review');
  const close = sheet(root, { width: 900 });
  const running = () => ['running', 'waiting'].includes(app.store.agents.get(model.agent)?.status ?? '');
  const disabled = () => busy || loading || running();
  const symbol = (s) => (s === 'kept' ? 'checkmark.circle.fill' : s === 'reverted' ? 'arrow.uturn.backward.circle' : s === 'partial' ? 'circle.lefthalf.filled' : 'circle');

  const actions = (status, hunk, writable) => {
    if (status === 'reverted') { const b = btn('tap', null, () => change('redo', hunk)); b.append(icon('arrow.uturn.forward', 11), L('Redo')); b.disabled = disabled() || !writable; return [b]; }
    const keep = btn('tap accent' + (status === 'kept' ? ' ok' : ''), null, () => change('keep', hunk));
    keep.append(icon('checkmark', 11, 2), status === 'kept' ? (hunk == null ? L('File kept') : L('Hunk kept')) : hunk == null ? L('Keep file') : L('Keep hunk'));
    keep.disabled = disabled() || status === 'kept';
    const revert = btn('tap', icon('arrow.uturn.backward', 11), () => change('revert', hunk), L('Revert'));
    revert.disabled = disabled() || !writable;
    return [keep, revert];
  };
  const code = (text) => el('div', 'review-code selectable', ...(text.endsWith('\n') ? text.slice(0, -1) : text).split('\n').map((l) => {
    const d = el('div', null, l || ' ');
    d.style.color = l.startsWith('+') ? 'var(--ok)' : l.startsWith('-') ? 'var(--err)' : 'var(--text)';
    return d;
  }));

  function draw() {
    const files = el('div', 'review-files', ...(entry.changes ?? []).map((f) => {
      const b = btn('review-file' + (f.path === selected ? ' on' : ''), null, () => { selected = f.path; load(); }, f.path);
      const s = el('span', null, icon(symbol(states[f.path] ?? 'pending'), 11));
      s.style.color = states[f.path] === 'kept' ? 'var(--ok)' : 'var(--muted)';
      b.append(s, el('span', 'ellip', f.path.split('/').at(-1)));
      b.disabled = busy;
      return b;
    }));
    const pane = el('div', 'review-pane');
    if (review) {
      const head = el('div', 'review-head', el('span', 'ellip', review.path), el('span', 'spacer'),
        btn('tap', icon('bubble.left', 12), () => { commentHunk = ''; sent = false; draw(); }, L('Request a fix for this file')),
        btn('tap', icon('arrow.up.right.square', 12), () => { app.showDiff(model.agent, review.path, from, to); close(); }, L('Open in editor')),
        ...actions(review.status, null, review.writable));
      const body = el('div', 'review-body');
      if (review.binary) body.append(el('div', 'muted', icon('doc', 12), L('Binary file')));
      else if (!review.hunks.length) body.append(code(review.diff));
      else for (const h of review.hunks) {
        const box = el('div', 'review-hunk' + (commentHunk === h.id ? ' on' : ''), el('div', 'review-hunk-head', el('code', 'muted', h.header), el('span', 'spacer'),
          btn('tap', icon('bubble.left', 11), () => { commentHunk = h.id; sent = false; draw(); }, L('Request a fix for this change')),
          ...actions(h.status, h.id, review.writable && review.status !== 'reverted')),
        code(h.diff.startsWith('@@') ? h.diff.slice(h.diff.indexOf('\n') + 1) : h.diff));
        body.append(box);
      }
      pane.append(head, body);
      if (commentHunk != null) {
        const f = el('input');
        f.placeholder = L('Fix request');
        const go = btn('tap accent', icon(sent ? 'checkmark' : 'arrow.up', 12, 2), () => fix(f.value), L('Ask the agent for a fix'));
        go.disabled = disabled() || app.store.agents.get(model.agent)?.chatMode !== 'agent' && app.store.agents.get(model.agent)?.chatMode != null;
        f.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') fix(f.value); });
        pane.append(el('div', 'review-comment', f, go));
        requestAnimationFrame(() => f.focus());
      }
    } else pane.append(el('div', 'review-empty', loading ? el('span', 'spin') : icon('doc.text.magnifyingglass', 20)));
    const top = el('div', 'review-top', el('span', 'accent', icon('doc.text.magnifyingglass', 13)), el('b', null, L('Changes')), el('span', 'muted', L('%d files', entry.changes?.length ?? 0)), el('span', 'spacer'));
    if (busy || loading) top.append(el('span', 'spin'));
    top.append(btn('tap', icon('xmark', 11, 2), close, L('Close')));
    root.replaceChildren(top, el('div', 'review-split', files, pane), ...(error ? [el('div', 'review-error selectable', error)] : []));
  }

  async function load() {
    if (!selected || !from || !to) return draw();
    const file = selected;
    loading = true; review = null; error = null; commentHunk = null; sent = false;
    draw();
    try {
      const v = await api.get(`${base}/review?from=${from}&to=${to}&path=${encodeURIComponent(file)}`);
      if (selected !== file) return;
      review = v; states[file] = v.status;
    } catch (e) { if (selected === file) error = e.message; }
    loading = false;
    draw();
  }
  async function change(action, hunk) {
    if (disabled()) return;
    busy = true; error = null; draw();
    try { review = await api.post(`${base}/review`, { from, to, path: selected, action, ...(hunk != null ? { hunk } : {}) }); states[selected] = review.status; }
    catch (e) { error = e.message; }
    busy = false; draw();
  }
  async function fix(comment) {
    if (disabled() || !comment.trim() || !review) return;
    const diff = review.hunks.find((h) => h.id === commentHunk)?.diff ?? review.diff;
    busy = true; error = null; draw();
    try {
      await api.post(`${base}/messages`, { text: `My fix request for the ${review.path} change: ${comment}\n\nReviewed turn: ${from ?? ''} → ${to ?? ''}\n<review_diff>\n${diff.slice(0, 20000)}\n</review_diff>` });
      sent = true;
    } catch (e) { error = e.message; }
    busy = false; draw();
  }

  (async () => {
    if (from && to) { try { states = Object.fromEntries((await api.get(`${base}/review?from=${from}&to=${to}`)).files.map((f) => [f.path, f.status])); } catch {} }
    load();
  })();
}
