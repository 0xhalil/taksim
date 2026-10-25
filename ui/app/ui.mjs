// Small pieces the views share: elements, menus (NSMenu), in-place renaming (InPlaceField), tooltips, toasts.
import { icon } from './icons.mjs';
import { logos } from './logos.mjs';

export function el(tag, cls, ...children) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const c of children) if (c != null) e.append(c);
  return e;
}

/** a button: `run` gets the event; `help` is its tooltip and accessible name */
export function btn(cls, content, run, help) {
  const b = el('button', cls);
  b.type = 'button';
  if (typeof content === 'string') b.append(icon(content, 14)); else if (content) b.append(content);
  if (help) { b.setAttribute('aria-label', help.split('  ')[0]); tooltip(b, help); }
  if (run) b.addEventListener('click', (e) => { e.stopPropagation(); run(e); });
  return b;
}

/** puts a floating box (menu, tip, list, field) above everything. While a sheet is open the rest of the page is
 *  inert behind it, so inside one the box joins the top layer as a popover, positioned against the window. */
export function float(box, fallback = document.body) {
  const host = [...document.querySelectorAll('dialog[open]')].reverse().find((d) => d.matches(':modal'));
  if (!host) { fallback?.append(box); return box; }
  box.setAttribute('popover', 'manual');
  host.append(box);
  box.showPopover();
  return box;
}

// ---------- tooltips: a short delay, like help(); never over a press ----------

let tipEl = null, tipTimer = null;
export function tooltip(node, text) {
  node.dataset.tip = text;
  node.addEventListener('pointerenter', () => {
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => {
      const t = typeof node.dataset.tip === 'string' ? node.dataset.tip : '';
      if (!t || !node.isConnected) return;
      tipEl?.remove();
      tipEl = el('div', 'tip', t);
      float(tipEl);
      const r = node.getBoundingClientRect();
      tipEl.style.left = Math.max(4, Math.min(r.left + r.width / 2 - tipEl.offsetWidth / 2, innerWidth - tipEl.offsetWidth - 4)) + 'px';
      tipEl.style.top = (r.bottom + 6 + tipEl.offsetHeight > innerHeight ? r.top - tipEl.offsetHeight - 6 : r.bottom + 6) + 'px';
    }, 600);
  });
  const hide = () => { clearTimeout(tipTimer); tipEl?.remove(); tipEl = null; };
  node.addEventListener('pointerleave', hide);
  node.addEventListener('pointerdown', hide);
}

// ---------- menus ----------

let openMenu = null;
export function closeMenu() { openMenu?.close(); }

/**
 * A context menu at a point or under an element. Items: { label, run, checked, mixed, danger, disabled, icon,
 * key, items (a submenu) } or null for a separator.
 */
export function menu(at, items, { onClose } = {}) {
  const prev = openMenu;
  closeMenu();
  if (at instanceof Element && prev?.at === at) return () => {};
  const box = el('div', 'menu');
  box.tabIndex = -1;
  box.setAttribute('role', 'menu');
  let sub = null;
  const close = () => {
    sub?.remove();
    box.remove();
    document.removeEventListener('pointerdown', outside, true);
    removeEventListener('blur', close);
    if (openMenu?.box === box) openMenu = null;
    onClose?.();
  };
  const outside = (e) => {
    if (at instanceof Element && at.contains(e.target)) return;
    if (!box.contains(e.target) && !sub?.contains(e.target)) close();
  };
  const fill = (target, list) => {
    for (const item of list) {
      if (!item) { target.append(el('hr')); continue; }
      const b = el('button', 'item' + (item.danger ? ' danger' : ''));
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      const check = el('span', 'check');
      if (item.checked) check.append(icon('checkmark', 12, 1.8)); else if (item.mixed) check.append('–'); else if (item.icon) check.append(icon(item.icon, 13));
      b.append(check, el('span', 'label', item.label));
      if (item.key) b.append(el('span', 'key', item.key));
      if (item.items) b.append(icon('chevron.right', 10));
      b.disabled = !!item.disabled;
      if (item.items) {
        b.addEventListener('pointerenter', () => {
          sub?.remove();
          sub = el('div', 'menu');
          fill(sub, item.items);
          float(sub);
          const r = b.getBoundingClientRect();
          place(sub, r.right + 2, r.top - 5, r.left - 2);
        });
      } else {
        b.addEventListener('pointerenter', () => { sub?.remove(); sub = null; });
        b.addEventListener('click', (e) => { e.stopPropagation(); close(); item.run?.(); });
      }
      target.append(b);
    }
  };
  fill(box, items);
  float(box);
  if (at instanceof Element) { const r = at.getBoundingClientRect(); place(box, r.left, r.bottom + 4); }
  else place(box, at.x, at.y);
  box.focus();
  box.addEventListener('keydown', (e) => {
    const buttons = [...box.querySelectorAll('.item:not(:disabled)')];
    const i = buttons.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); buttons[(i + 1) % buttons.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); buttons[(i - 1 + buttons.length) % buttons.length]?.focus(); }
  });
  setTimeout(() => { document.addEventListener('pointerdown', outside, true); addEventListener('blur', close); });
  openMenu = { box, close, at };
  return close;
}

function place(box, x, y, flipX) {
  const w = box.offsetWidth, h = box.offsetHeight;
  box.style.left = Math.max(4, x + w > innerWidth - 4 ? (flipX != null ? flipX - w : innerWidth - w - 4) : x) + 'px';
  box.style.top = Math.max(4, Math.min(y, innerHeight - h - 4)) + 'px';
}

// ---------- renaming in place ----------

/** a field over `rect` (client coordinates) holding `value`, selected; Enter or leaving saves, Esc cancels */
export function editInPlace(rect, value, save, { fontSize = 14 } = {}) {
  document.querySelector('.inplace')?.remove();
  const f = el('input', 'inplace');
  f.value = value;
  Object.assign(f.style, { left: rect.x + 'px', top: rect.y + 'px', width: rect.width + 'px', height: rect.height + 'px', fontSize: fontSize + 'px', position: 'fixed' });
  let done = false;
  const finish = (ok) => {
    if (done) return;
    done = true;
    const next = f.value.trim();
    f.remove();
    if (ok && next && next !== value) save(next);
  };
  f.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
  f.addEventListener('blur', () => finish(true));
  f.addEventListener('pointerdown', (e) => e.stopPropagation());
  float(f);
  f.focus();
  f.select();
}

// ---------- toasts ----------

let toastEl = null, toastTimer = null;
export function toast(text, { error = false } = {}) {
  toastEl?.remove();
  toastEl = el('div', 'toast' + (error ? ' err' : ''), text);
  toastEl.setAttribute('role', 'alert');
  float(toastEl, document.getElementById('stage'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl?.remove(); toastEl = null; }, 6000);
}

/** taksim's mark (native/Resources/logo/taksim-mark-small.svg): four roads meeting at a crossing */
let marks = 0;
export function mark(size = 15) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '100 100 800 800');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  const id = 'taksim-mark-' + ++marks;
  const quarter = (q) => `<g transform="rotate(${q} 500 500)"><path d="M500 40 V330 A170 170 0 0 1 330 500 H40"/><path d="M500 40 V330"/></g>`;
  svg.innerHTML = `<mask id="${id}"><path d="M500 100 L630 230 V370 H770 L900 500 L770 630 H630 V770 L500 900 L370 770 V630 H230 L100 500 L230 370 H370 V230 Z" fill="#fff"/>`
    + `<g fill="none" stroke="#000" stroke-width="34">${[0, 90, 180, 270].map(quarter).join('')}</g></mask>`
    + `<rect width="1000" height="1000" fill="currentColor" mask="url(#${id})"/>`;
  return svg;
}

/** a CLI's tile (BackendTile): its own icon, else its mark on its brand colour, else a terminal */
export function backendTile(backend, size = 22) {
  const box = el('span', 'btile');
  Object.assign(box.style, { width: size + 'px', height: size + 'px', borderRadius: size / 4.4 + 'px' });
  if (logos.icons[backend]) {
    const img = el('img');
    img.alt = '';
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(logos.icons[backend]);
    box.append(img);
    return box;
  }
  box.style.background = logos.tiles[backend] ?? '#6b6862';
  if (logos.paths[backend]) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', size * 0.64);
    svg.setAttribute('height', size * 0.64);
    const p = document.createElementNS(svg.namespaceURI, 'path');
    p.setAttribute('d', logos.paths[backend]);
    p.setAttribute('fill', '#fff');
    svg.append(p);
    box.append(svg);
  } else box.append(icon('terminal', size * 0.5));
  return box;
}

/** a sheet over the window (SwiftUI .sheet): it drops from the top edge, Esc closes it */
export function sheet(content, { width = 460, onClose } = {}) {
  const d = el('dialog', 'sheet');
  d.style.width = width + 'px';
  d.append(content);
  document.body.append(d);
  const close = () => { if (d.open) d.close(); };
  d.addEventListener('close', () => { d.remove(); onClose?.(); });
  d.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  d.addEventListener('pointerdown', (e) => {
    if (e.target === d) {
      if (document.querySelector('.model-list, .menu, .usage-panel, .ask-box, .audit-box')) return;
      close();
    }
  });
  d.showModal();
  return close;
}
