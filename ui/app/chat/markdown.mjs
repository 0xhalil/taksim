// An answer's Markdown, as Chat/ChatMarkdown.swift reads it: a streaming-safe block parser (an unfinished code
// fence stays code), inline **bold**, *italic*, `code`, ~~strike~~ and links. Built with DOM nodes and textContent
// only: what an agent wrote never becomes markup.
import { L } from '../theme.mjs';
import { icon } from '../icons.mjs';
import { el } from '../ui.mjs';

export function blocks(source) {
  const out = [];
  let prose = [], code = null, language = '', fence = '';
  const flush = () => {
    const lines = prose;
    prose = [];
    let paragraph = [];
    const flushParagraph = () => {
      const text = paragraph.join('\n').replace(/^\n+|\n+$/g, '');
      if (text) out.push({ kind: 'text', text });
      paragraph = [];
    };
    for (let i = 0; i < lines.length;) {
      const line = lines[i], t = line.trim();
      if (!t) { flushParagraph(); i++; continue; }
      if (i + 1 < lines.length && t.includes('|') && tableDivider(lines[i + 1])) {
        flushParagraph();
        const rows = [cells(t)];
        i += 2;
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
        out.push({ kind: 'table', rows });
        continue;
      }
      const hashes = t.match(/^#+/)?.[0].length ?? 0;
      if (hashes >= 1 && hashes <= 6 && t[hashes] === ' ') { flushParagraph(); out.push({ kind: 'heading', level: hashes, text: t.slice(hashes + 1) }); }
      else if (['---', '***', '___'].includes(t)) { flushParagraph(); out.push({ kind: 'rule' }); }
      else if (t.startsWith('>')) { flushParagraph(); out.push({ kind: 'quote', text: t.slice(1).trim() }); }
      else {
        const item = listItem(t);
        if (item) { flushParagraph(); out.push({ kind: 'item', marker: item[0], indent: Math.floor((line.match(/^ */)[0].length) / 2), text: item[1] }); }
        else paragraph.push(line);
      }
      i++;
    }
    flushParagraph();
  };
  for (const line of source.split('\n')) {
    const t = line.trim();
    if (code) {
      const run = t.match(new RegExp('^\\' + fence[0] + '+'))?.[0] ?? '';
      if (run.length >= fence.length && !t.slice(run.length).trim()) { out.push({ kind: 'code', language, code: code.join('\n') }); code = null; }
      else code.push(line);
    } else if (t.startsWith('```') || t.startsWith('~~~')) {
      flush();
      fence = t.match(new RegExp('^\\' + t[0] + '+'))[0];
      language = t.slice(fence.length).trim();
      code = [];
    } else prose.push(line);
  }
  if (code) out.push({ kind: 'code', language, code: code.join('\n') });
  flush();
  return out;
}

function listItem(t) {
  for (const p of ['- ', '* ', '+ ']) {
    if (!t.startsWith(p)) continue;
    const body = t.slice(2);
    if (body.startsWith('[ ] ')) return ['☐', body.slice(4)];
    if (body.toLowerCase().startsWith('[x] ')) return ['☑', body.slice(4)];
    return ['•', body];
  }
  const m = t.match(/^(\d+)[.)] (.*)$/);
  return m ? [m[1] + '.', m[2]] : null;
}
function cells(text) { let t = text.trim(); if (t.startsWith('|')) t = t.slice(1); if (t.endsWith('|')) t = t.slice(0, -1); return t.split('|').map((c) => c.trim()); }
function tableDivider(text) { const c = cells(text); return c.length > 0 && c.every((x) => { const v = x.replace(/:/g, ''); return v.length >= 3 && /^-+$/.test(v); }); }

/** prose with **bold**, *italic*, `code`, ~~strike~~ and [links](url) as a fragment */
export function inline(text, { size = 13, weight = 400 } = {}) {
  const box = el('span', 'md-inline');
  box.style.fontSize = size + 'px';
  if (weight !== 400) box.style.fontWeight = weight;
  const re = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|~~([\s\S]+?)~~|\*([^*\s][\s\S]*?)\*|_([^_\s][\s\S]*?)_(?![\p{L}\p{N}])|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/gu;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) box.append(text.slice(last, m.index));
    if (m[1]) box.append(el('code', null, m[2]));
    else if (m[3] || m[4]) box.append(inlineChild('strong', m[3] ?? m[4]));
    else if (m[5]) box.append(inlineChild('s', m[5]));
    else if (m[6] || m[7]) box.append(inlineChild('em', m[6] ?? m[7]));
    else { const a = el('a', null, m[8] ?? m[10]); const href = m[9] ?? m[10]; if (/^(https?:|mailto:)/i.test(href)) { a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; } box.append(a); }
    last = re.lastIndex;
  }
  if (last < text.length) box.append(text.slice(last));
  return box;
}
function inlineChild(tag, text) { const e = el(tag); e.append(...inline(text).childNodes); return e; }

export function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  fallbackCopy(text);
}
function fallbackCopy(text) {
  const t = el('textarea'); t.value = text; document.body.append(t); t.select();
  try { document.execCommand('copy'); } catch {}
  t.remove();
}

/** a copy key whose glyph turns to a green check for a moment */
export function copyButton(text, help) {
  const b = el('button', 'tap copy');
  b.type = 'button';
  b.title = help;
  b.setAttribute('aria-label', help);
  b.append(icon('doc.on.doc', 11));
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    copyText(typeof text === 'function' ? text() : text);
    b.replaceChildren(icon('checkmark', 11, 1.8));
    b.classList.add('copied');
    setTimeout(() => { b.replaceChildren(icon('doc.on.doc', 11)); b.classList.remove('copied'); }, 1200);
  });
  return b;
}

export function markdown(text) {
  const root = el('div', 'md');
  for (const b of blocks(text)) {
    switch (b.kind) {
      case 'text': root.append(el('p', null, inline(b.text))); break;
      case 'heading': {
        const h = el('div', 'md-h md-h' + Math.min(b.level, 3), inline(b.text, { size: b.level === 1 ? 17 : b.level === 2 ? 14.5 : 13, weight: 600 }));
        root.append(h);
        break;
      }
      case 'item': {
        const row = el('div', 'md-item', el('span', 'md-marker', b.marker), inline(b.text));
        row.style.paddingLeft = b.indent * 8 + 'px';
        root.append(row);
        break;
      }
      case 'quote': root.append(el('div', 'md-quote', inline(b.text))); break;
      case 'rule': root.append(el('hr', 'md-rule')); break;
      case 'table': {
        const n = Math.max(...b.rows.map((r) => r.length));
        const grid = el('div', 'md-table');
        grid.style.gridTemplateColumns = `repeat(${n}, auto)`;
        b.rows.forEach((r, i) => {
          for (let j = 0; j < n; j++) grid.append(el('div', null, inline(r[j] ?? '', { weight: i === 0 ? 600 : 400 })));
          if (i === 0) { const line = el('div', 'md-table-line'); line.style.gridColumn = `span ${n}`; grid.append(line); }
        });
        root.append(grid);
        break;
      }
      case 'code': root.append(codeBlock(b.language, b.code)); break;
    }
  }
  return root;
}

function codeBlock(language, code) {
  const lines = code.split('\n');
  const box = el('div', 'md-code');
  const head = el('div', 'md-code-head', el('span', null, language || L('code')), el('span', 'spacer'), copyButton(code, L('Copy code')));
  const pre = el('pre');
  let expanded = false;
  const fill = () => { pre.textContent = (expanded ? lines : lines.slice(0, 24)).join('\n'); };
  fill();
  box.append(head, pre);
  if (lines.length > 24) {
    const more = el('button', 'md-code-more');
    more.type = 'button';
    const label = () => { more.replaceChildren(expanded ? L('Collapse') : L('%d more lines', lines.length - 24), icon(expanded ? 'chevron.up' : 'chevron.down', 10)); };
    label();
    more.addEventListener('click', () => { expanded = !expanded; fill(); label(); });
    box.append(more);
  }
  return box;
}
