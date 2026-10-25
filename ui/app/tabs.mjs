// The tab strip (TabStrip.swift): one tab per canvas, 168 wide, the open one on the ground colour with an
// accent line; drag to reorder, double-click to rename, right-click to lock or close several.
import { L, iconColor } from './theme.mjs';
import { icon } from './icons.mjs';
import { el, btn, menu } from './ui.mjs';

function stored(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }

export class TabStrip {
  renaming = null;

  constructor(app) {
    this.app = app;
    this.root = el('nav');
    this.root.id = 'tabs';
    this.root.setAttribute('aria-label', L('Canvases'));
    this.row = el('div', 'tabs-row');
    this.left = btn('ibtn', 'chevron.left', () => this.#page(-1), L('Previous tabs'));
    this.right = btn('ibtn', 'chevron.right', () => this.#page(1), L('Next tabs'));
    this.add = btn('ibtn', 'plus', () => app.store.newCanvas(), L('New canvas  ⌘T'));
    this.all = btn('ibtn', 'chevron.down', () => this.#allTabs(), L('All tabs'));
    this.branchSlot = el('span', 'branch-slot');
    this.root.append(this.left, this.row, this.right, this.add, el('span', 'spacer'), this.branchSlot, this.all);
    this.row.addEventListener('scroll', () => this.#arrows());
    new ResizeObserver(() => this.render()).observe(this.root);
  }

  get order() { return stored('taksim.tabOrder', []); }
  set order(ids) { try { localStorage.setItem('taksim.tabOrder', JSON.stringify(ids)); } catch {} }

  /** the visible canvases in the person's order */
  tabs() {
    const order = this.order, rank = (c) => { const i = order.indexOf(c.id); return i < 0 ? Infinity : i; };
    return this.app.store.visibleCanvases.map((c, i) => [c, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([c]) => c);
  }

  render() {
    const s = this.app.store, tabs = this.tabs();
    const branch = this.app.branches?.root;
    if (branch && branch.parentNode !== this.branchSlot) this.branchSlot.append(branch);
    const usable = Math.max(0, this.root.clientWidth - 16 - (branch && !branch.hidden ? 200 : 0));
    const overflowing = tabs.length * 168 + 28 * 2 > usable;
    this.row.style.width = (overflowing ? Math.max(0, usable - 28 * 4) : tabs.length * 168) + 'px';
    this.left.hidden = this.right.hidden = !overflowing;
    this.root.querySelector('.spacer').hidden = overflowing;
    const key = JSON.stringify([tabs.map((c) => [c.id, c.name, (c.busy ?? 0) > 0, s.lockedTabs.has(c.id)]), s.currentId, this.renaming]);
    if (key !== this.drawn) {
      this.drawn = key;
      this.row.replaceChildren(...tabs.map((c) => this.#tab(c)));
      this.reveal(s.currentId);
    }
    this.#arrows();
  }

  #tab(c) {
    const s = this.app.store, active = c.id === s.currentId, locked = s.lockedTabs.has(c.id);
    const tab = el('div', 'tab' + (active ? ' active' : ''));
    tab.dataset.canvas = c.id;
    tab.title = c.name;
    tab.tabIndex = 0;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', active);
    tab.append(canvasIcon(c.name, (c.busy ?? 0) > 0));
    if (this.renaming === c.id) {
      const f = el('input');
      f.value = c.name;
      f.setAttribute('aria-label', L('Canvas name'));
      let done = false;
      const commit = (ok) => {
        if (done) return;
        done = true;
        this.renaming = null;
        const name = f.value.trim();
        if (ok && name && name !== c.name) s.rename(c.id, name); else this.render();
      };
      f.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') commit(true); if (e.key === 'Escape') commit(false); });
      f.addEventListener('blur', () => commit(true));
      tab.append(f);
      requestAnimationFrame(() => { f.focus(); f.select(); });
    } else tab.append(el('span', 'name', c.name));
    if (locked) {
      const lock = el('span', 'lock', icon('lock.fill', 10));
      lock.title = L('Tab locked; right-click to unlock');
      tab.append(lock);
    } else tab.append(btn('close', icon('xmark', 9, 1.6), () => this.close([c.id]), L('Close tab')));
    tab.addEventListener('click', () => s.open(c.id));
    tab.addEventListener('dblclick', () => { this.renaming = c.id; this.render(); });
    tab.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === tab) s.open(c.id); });
    tab.addEventListener('contextmenu', (e) => { e.preventDefault(); this.#menu(c, e); });
    tab.addEventListener('auxclick', (e) => { if (e.button === 1 && !locked) this.close([c.id]); });
    // drag to reorder; a past conversation dropped here continues on this tab
    tab.draggable = this.renaming !== c.id;
    tab.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/taksim-tab', c.id); e.dataTransfer.effectAllowed = 'move'; });
    tab.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].some((t) => t === 'text/taksim-tab' || t === 'text/taksim-conversation')) e.preventDefault(); });
    tab.addEventListener('drop', (e) => {
      e.preventDefault();
      const past = e.dataTransfer.getData('text/taksim-conversation');
      if (past) { s.open(c.id).then(() => this.app.continueConversation(past)); return; }
      const from = e.dataTransfer.getData('text/taksim-tab');
      if (!from || from === c.id) return;
      const ids = this.tabs().map((t) => t.id).filter((id) => id !== from);
      ids.splice(ids.indexOf(c.id), 0, from);
      this.order = ids;
      this.render();
    });
    return tab;
  }

  #menu(c, e) {
    const s = this.app.store, ids = this.tabs().map((t) => t.id), i = ids.indexOf(c.id);
    const closeItem = (label, list) => ({ label, disabled: !list.some((id) => !s.lockedTabs.has(id)), run: () => this.close(list) });
    menu({ x: e.clientX, y: e.clientY }, [
      { label: s.lockedTabs.has(c.id) ? L('Unlock tab') : L('Lock tab'), run: () => s.toggleTabLock(c.id) },
      null,
      closeItem(L('Close tab'), [c.id]),
      closeItem(L('Close other tabs'), ids.filter((id) => id !== c.id)),
      closeItem(L('Close tabs to the right'), ids.slice(i + 1)),
      closeItem(L('Close tabs to the left'), ids.slice(0, i)),
      closeItem(L('Close all tabs'), ids),
      null,
      { label: L('Rename'), run: () => { this.renaming = c.id; this.render(); } },
    ]);
  }

  #allTabs() {
    const s = this.app.store, tabs = this.tabs();
    if (!tabs.length) return;
    menu(this.all, [
      { label: L('Go to first tab'), run: () => this.reveal(tabs[0].id, 'start') },
      { label: L('Go to last tab'), run: () => this.reveal(tabs.at(-1).id, 'end') },
      null,
      ...tabs.map((c) => ({ label: c.name, checked: c.id === s.currentId, icon: s.lockedTabs.has(c.id) ? 'lock.fill' : null, run: () => s.open(c.id) })),
    ]);
  }

  close(ids) { this.app.store.closeTabs(new Set(ids), this.tabs().map((t) => t.id)); }

  reveal(id, align = 'nearest') {
    const t = id && this.row.querySelector(`[data-canvas="${CSS.escape(id)}"]`);
    t?.scrollIntoView({ inline: align, block: 'nearest', behavior: 'smooth' });
  }

  #page(direction) {
    const tabs = this.tabs(), step = Math.max(1, Math.floor(this.row.clientWidth / 168) - 1);
    const first = Math.floor(Math.max(0, this.row.scrollLeft) / 168);
    const i = Math.min(Math.max(0, first + direction * step), tabs.length - 1);
    if (tabs[i]) this.reveal(tabs[i].id, 'start');
  }

  #arrows() {
    const left = Math.ceil(Math.max(0, this.row.scrollLeft - 0.5) / 168);
    const right = Math.ceil(Math.max(0, this.row.scrollWidth - this.row.scrollLeft - this.row.clientWidth - 0.5) / 168);
    this.left.disabled = left === 0;
    this.right.disabled = right === 0;
    this.left.dataset.tip = L('%d tabs on the left', left);
    this.right.dataset.tip = L('%d tabs on the right', right);
  }
}

/** a canvas's icon: its initial on a colour of its own, like a PyCharm project icon; a green dot while agents work */
export function canvasIcon(name, busy = false, size = 16) {
  const ch = [...name].find((c) => /[\p{L}\p{N}]/u.test(c));
  const box = el('span', 'cicon', ch ? ch.toLocaleUpperCase('tr') : '?');
  box.style.background = iconColor(name);
  if (size !== 16) Object.assign(box.style, { width: size + 'px', height: size + 'px', borderRadius: size / 4 + 'px', fontSize: size * 0.6 + 'px' });
  if (busy) box.append(el('span', 'busy'));
  return box;
}
