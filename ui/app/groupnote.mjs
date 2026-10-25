// A group's memory (GroupNote.swift): what its agents know together, as entries beside who wrote them. A click
// edits an entry in place, × drops it (↶ brings it back), the last line adds one. Every save is a version; older
// ones are a menu away. Members carry a dot, filled once they've read the latest; the pencil marks the keeper.
import { L } from './theme.mjs';
import { api } from './api.mjs';
import { icon } from './icons.mjs';
import { el, btn, menu, backendTile } from './ui.mjs';
import { inline } from './chat/markdown.mjs';

const isItem = (s) => /^(?:[-*+]|\d+[.)])\s/.test(s);
/** the note's blocks, as the engine splits them: at blank lines and between top-level list items */
export function splitMemory(text) {
  const out = [];
  let cur = null;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (!line.trim()) { if (cur != null) out.push(cur); cur = null; continue; }
    if (cur != null && isItem(line) && isItem(cur)) { out.push(cur); cur = line; continue; }
    cur = cur == null ? line : `${cur}\n${line}`;
  }
  if (cur != null) out.push(cur);
  return out.map((s) => s.replace(/\s+$/, '')).filter(Boolean);
}
/** consecutive list items stay one list; anything else is a paragraph of its own */
export function joinMemory(texts) {
  const parts = texts.map((t) => t.trim()).filter(Boolean);
  return parts.reduce((s, t, i) => s + (i ? (isItem(parts[i - 1]) && isItem(t) ? '\n' : '\n\n') : '') + t, '');
}

export class GroupNote {
  constructor(app) { this.app = app; this.store = app.store; }

  /** opens beside the note icon (`rect` in window coordinates) */
  open(gid, rect) {
    this.close();
    this.gid = gid;
    this.entries = [];
    this.versions = [];
    this.viewing = null;
    this.raw = false;
    this.undo = null;
    this.root = el('div', 'gnote');
    document.body.append(this.root);
    const x = Math.max(8, Math.min(rect.x + rect.width / 2 - 220, innerWidth - 448)), y = rect.y + rect.height + 8;
    Object.assign(this.root.style, { left: x + 'px', top: Math.min(y, innerHeight - 200) + 'px' });
    this.off = (e) => { if (!this.root?.contains(e.target)) this.close(); };
    setTimeout(() => document.addEventListener('pointerdown', this.off, true));
    this.unwatch = this.store.watch(() => {
      const g = this.store.groups.get(gid);
      if (g && g.version !== this.detail?.version && !this.editing && !this.raw && this.viewing == null) this.load();
    });
    this.root.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape' && !this.editing) this.close(); });
    this.load();
  }

  close() {
    if (!this.root) return;
    this.#flushRaw();
    document.removeEventListener('pointerdown', this.off, true);
    this.unwatch?.();
    this.root.remove();
    this.root = null;
  }

  get path() { return `${this.store.canvasPath()}/groups/${this.gid}`; }

  async load() {
    try {
      const d = await api.get(this.path);
      this.detail = d;
      this.entries = d.memory ?? splitMemory(d.context ?? '').map((text) => ({ text }));
      this.versions = (await api.get(this.path + '/history').catch(() => ({ versions: [] }))).versions ?? [];
    } catch {}
    this.draw();
  }

  draw() {
    if (!this.root) return;
    const d = this.detail ?? {}, head = el('div', 'gnote-head');
    const dot = el('i', 'dot');
    dot.style.background = /^#[0-9a-f]{6}/i.test(d.color ?? '') ? d.color : 'var(--accent)';
    head.append(dot, el('b', null, d.name ?? ''), el('span', 'spacer'));
    if (this.flash) head.append(el('span', 'ok', icon('checkmark', 10, 2.2)));
    if (this.undo) head.append(this.#key('arrow.uturn.backward', L('undo'), () => this.save(this.undo.map((e) => e.text), this.undo)));
    if (this.viewing != null) head.append(this.#key('arrow.clockwise', L('restore this version'), () => this.save(this.old, this.old.map((text) => ({ text }))), 'var(--warn)'));
    head.append(this.#key(this.raw ? 'list.bullet' : 'pencil', this.raw ? L('entries') : 'markdown', () => this.#toggleRaw(), this.raw ? 'var(--accent)' : null));
    const ver = btn('gnote-ver', null, () => menu(ver, [
      { label: L('Current'), checked: this.viewing == null, run: () => this.show(null) }, null,
      ...[...this.versions].reverse().map((v) => ({ label: `v${v}`, checked: this.viewing === v, run: () => this.show(v) })),
    ]));
    ver.append(icon('clock.arrow.circlepath', 11), el('span', null, this.viewing != null ? `v${this.viewing}` : `v${d.version ?? 0}`));
    if (this.viewing != null) ver.style.color = 'var(--warn)';
    ver.disabled = !this.versions.length;
    head.append(ver);
    const box = el('div', 'gnote-list' + (this.viewing != null ? ' old' : ''));
    if (this.raw) {
      const t = el('textarea', 'gnote-raw');
      t.value = this.rawText;
      t.addEventListener('input', () => { this.rawText = t.value; clearTimeout(this.rawTimer); this.rawTimer = setTimeout(() => this.#flushRaw(), 800); });
      box.append(t);
      requestAnimationFrame(() => t.focus());
    } else {
      const items = this.viewing != null ? this.old.map((text) => ({ text })) : this.entries, live = this.viewing == null;
      items.forEach((e, i) => box.append(this.#row(e, i, live, i === 0 || items[i - 1].by !== e.by)));
      if (live) {
        const add = el('textarea');
        add.rows = 1;
        add.addEventListener('keydown', (ev) => {
          if (ev.key !== 'Enter' || ev.shiftKey) return;
          ev.preventDefault();
          const t = add.value.trim();
          if (!t) return;
          const next = [...this.entries, { text: t, by: 'user', at: Date.now() }];
          this.save(next.map((x) => x.text), next);
          this.refocusAdd = true;
        });
        box.append(el('div', 'gnote-add', icon('plus', 10, 2.2), add));
        if (this.refocusAdd) { this.refocusAdd = false; requestAnimationFrame(() => add.focus()); }
      }
      if (!items.length && !live) box.append(el('div', 'gnote-empty', icon('book.closed', 24, 1.2)));
    }
    this.root.replaceChildren(head, box, this.#members());
  }

  #key(symbol, help, run, tint) {
    const b = btn('gnote-key', icon(symbol, 11), run, help);
    if (tint) b.style.color = tint;
    return b;
  }

  #row(e, i, live, first) {
    const row = el('div', 'gnote-row');
    row.append(first ? this.#author(e.by) : el('span', 'gnote-author'));
    if (live && this.editing === i) {
      const f = el('textarea');
      f.value = e.text;
      f.rows = Math.max(1, e.text.split('\n').length);
      const commit = () => this.#commit(i, f.value);
      f.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); commit(); } if (ev.key === 'Escape') { this.editing = null; this.draw(); } });
      f.addEventListener('blur', commit);
      row.classList.add('editing');
      row.append(f);
      requestAnimationFrame(() => { f.focus(); f.setSelectionRange(f.value.length, f.value.length); });
      return row;
    }
    const text = el('div', 'gnote-text');
    for (const [n, line] of e.text.split('\n').entries()) {
      if (n) text.append(el('br'));
      let s = line, heading = false;
      if (/^#{1,6}\s+/.test(s)) { s = s.replace(/^#{1,6}\s+/, ''); heading = true; }
      s = s.replace(/^(\s*)[-*+]\s/, '$1• ');
      text.append(inline(s, { size: 12.5, weight: heading ? 600 : 400 }));
    }
    if (live) text.addEventListener('click', () => { this.editing = i; this.draw(); });
    row.append(text);
    if (live) {
      const tail = el('span', 'gnote-tail');
      if (e.at) tail.append(el('span', 'muted2', ago(e.at)));
      tail.append(btn('gnote-x', icon('xmark', 8, 2.4), () => {
        this.undo = this.entries;
        const next = this.entries.filter((_, j) => j !== i);
        this.save(next.map((x) => x.text), next);
        const mark = next;
        setTimeout(() => { if (this.entries === mark) { this.undo = null; this.draw(); } }, 6000);
      }, L('forget')));
      row.append(tail);
    }
    return row;
  }

  #author(by) {
    if (by === 'user') { const s = el('span', 'gnote-author', icon('person', 14)); s.title = L('you'); return s; }
    const a = by && this.store.agents.get(by);
    if (a) { const t = backendTile(a.backend ?? '', 16); t.title = a.name; t.classList.add('gnote-author'); return t; }
    return el('span', 'gnote-author');
  }

  #commit(i, value) {
    if (this.editing !== i) return;
    this.editing = null;
    const t = value.trim();
    if (t === this.entries[i]?.text) return this.draw();
    const next = [...this.entries];
    if (!t) { this.undo = this.entries; next.splice(i, 1); } else next[i] = { text: t, by: 'user', at: Date.now() };
    this.save(next.map((x) => x.text), next);
  }

  #members() {
    const d = this.detail ?? {}, version = d.version ?? 0, row = el('div', 'gnote-members', icon('person.2', 11));
    if (!d.members?.length) row.append(el('span', 'muted2', '—'));
    for (const id of d.members ?? []) {
      const a = this.store.agents.get(id), keeper = d.maintainer === id, read = (d.seen?.[id] ?? -1) >= version;
      const b = btn('gnote-member' + (keeper ? ' keeper' : ''), null, () => {
        d.maintainer = keeper ? null : id;
        this.store.patchGroup(this.gid, { maintainer: keeper ? null : id });
        this.draw();
      }, keeper ? L('this agent may also rewrite the memory') : L('allow rewriting the memory'));
      if (a) b.append(backendTile(a.backend ?? '', 14));
      b.append(el('span', null, a?.name ?? id));
      if (keeper) b.append(icon('pencil', 9, 2));
      if (version > 0) b.append(el('i', 'seen' + (read ? ' read' : '')));
      row.append(b);
    }
    return row;
  }

  async show(v) {
    this.#flushRaw();
    this.raw = false;
    this.viewing = v;
    if (v == null) return this.load();
    try { this.old = splitMemory((await api.get(`${this.path}/history/${v}`)).content ?? ''); } catch { this.old = []; }
    this.draw();
  }

  #toggleRaw() {
    if (this.raw) { this.#flushRaw(); this.raw = false; this.load(); return; }
    this.rawText = joinMemory(this.entries.map((e) => e.text));
    this.raw = true;
    this.draw();
  }

  #flushRaw() {
    clearTimeout(this.rawTimer);
    if (this.raw && this.rawText !== joinMemory(this.entries.map((e) => e.text))) this.save(splitMemory(this.rawText), null, false);
  }

  /** writes the memory as its entries; the engine keeps each unchanged entry's writer */
  async save(texts, optimistic, reload = true) {
    if (optimistic) this.entries = optimistic;
    if (optimistic && this.undo === optimistic) this.undo = null;
    this.viewing = null;
    this.draw();
    try { await api.put(this.path + '/context', { content: joinMemory(texts) }); } catch { return; }
    if (reload) await this.load();
    else {
      this.entries = texts.map((t) => this.entries.find((e) => e.text === t) ?? { text: t, by: 'user', at: Date.now() });
      this.versions = (await api.get(this.path + '/history').catch(() => null))?.versions ?? this.versions;
    }
    this.flash = true;
    this.draw();
    setTimeout(() => { this.flash = false; this.draw(); }, 1200);
  }
}

function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return L('now');
  if (s < 3600) return L('%d min', Math.floor(s / 60));
  if (s < 86400) return L('%d hr', Math.floor(s / 3600));
  return L('%d d', Math.floor(s / 86400));
}
