// A group's memory: its context note seen as entries, each with who wrote it and when.
// The note stays plain markdown (what agents read with get_context); entries are its blocks, split at blank
// lines and between top-level list items. On every write an unchanged entry keeps its author, a new or
// edited one gets the writer, so the user sees whose memory each line is and can edit it by hand.

const ITEM = /^(?:[-*+]|\d+[.)])\s/;

export function splitMemory(text) {
  const out = [];
  let cur = null;
  for (const line of String(text || "").replace(/\r\n?/g, "\n").split("\n")) {
    if (!line.trim()) { if (cur !== null) out.push(cur); cur = null; continue; }
    // a top-level list item after another one starts its own entry
    if (cur !== null && ITEM.test(line) && ITEM.test(cur)) { out.push(cur); cur = line; continue; }
    cur = cur === null ? line : `${cur}\n${line}`;
  }
  if (cur !== null) out.push(cur);
  return out.map((s) => s.trimEnd()).filter(Boolean);
}

// consecutive list items stay one list; anything else is a paragraph of its own
export function joinMemory(texts) {
  const parts = texts.map((t) => String(t).trim()).filter(Boolean);
  return parts.map((t, i) => (i === 0 ? t : `${ITEM.test(parts[i - 1]) && ITEM.test(t) ? "\n" : "\n\n"}${t}`)).join("");
}

// entries for a new text: an entry whose text is unchanged keeps its author and time
export function attribute(prev, text, by, at) {
  const pool = new Map();
  for (const e of prev || []) { const k = e.text.trim(); if (!pool.has(k)) pool.set(k, []); pool.get(k).push(e); }
  return splitMemory(text).map((t) => {
    const same = pool.get(t.trim())?.shift();
    return same ? { text: t, by: same.by, at: same.at } : { text: t, by, at };
  });
}

// the stored entries when they still match the note; otherwise the note's blocks, all by its last writer
export function entriesOf(stored, text, by, at) {
  const blocks = splitMemory(text);
  if (Array.isArray(stored) && stored.length === blocks.length && stored.every((e, i) => e?.text === blocks[i])) return stored;
  return attribute(stored, text, by ?? "user", at ?? null);
}
