// One agent's chat, as Chat/ChatModel.swift keeps it: the transcript, the answer streaming in, its tasks,
// activity, queue, plan, question and orchestrated job; plus the drafts each composer keeps per agent.
import { api, APIError } from '../api.mjs';
import { L } from '../theme.mjs';

function stored(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }

/** what was typed and attached per agent, kept across reloads */
export const drafts = {
  text: stored('taksim.chat.drafts.text', {}),
  attachments: stored('taksim.chat.drafts.attachments', {}),
  focus: null,
  listeners: new Set(),
  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      try {
        localStorage.setItem('taksim.chat.drafts.text', JSON.stringify(Object.fromEntries(Object.entries(this.text).filter(([, v]) => v))));
        localStorage.setItem('taksim.chat.drafts.attachments', JSON.stringify(Object.fromEntries(Object.entries(this.attachments).filter(([, v]) => v?.length))));
      } catch {}
    }, 250);
  },
  set(agent, text) { this.text[agent] = text; this.save(); this.changed(agent); },
  add(a, agent) {
    const list = this.attachments[agent] ?? [];
    if (!list.some((x) => attachmentId(x) === attachmentId(a))) list.push(a);
    this.attachments[agent] = list;
    this.focus = agent;
    this.save();
    this.changed(agent);
  },
  remove(a, agent) { this.attachments[agent] = (this.attachments[agent] ?? []).filter((x) => attachmentId(x) !== attachmentId(a)); this.save(); this.changed(agent); },
  clear(agent) { this.text[agent] = ''; this.attachments[agent] = []; this.save(); this.changed(agent); },
  /** bring an earlier request back without dropping what is being composed */
  reuse(entry, agent) {
    this.text[agent] = [this.text[agent] ?? '', entry.text ?? ''].filter(Boolean).join('\n\n');
    for (const a of entry.attachments ?? []) this.add(a, agent);
    this.focus = agent;
    this.save();
    this.changed(agent);
  },
  ask(agent) { this.focus = agent; this.changed(agent); },
  changed(agent) { for (const fn of this.listeners) fn(agent); },
};

export const attachmentId = (a) => [a.kind, a.path ?? a.name ?? '', a.from ?? '', a.to ?? ''].join('|');
export function attachmentLabel(a) {
  const base = (p) => (p ?? '').split(/[\\/]/).filter(Boolean).at(-1) ?? '';
  if (a.kind === 'conversation') return a.name ?? L('Chat');
  if (a.kind === 'agent') return '@' + (a.name ?? '');
  if (a.kind === 'selection') return `${base(a.path)} ${a.from ?? 1}–${a.to ?? a.from ?? 1}`;
  return base(a.path);
}
export function attachmentSymbol(a) {
  return { folder: 'folder', image: 'photo', selection: 'list.bullet', conversation: 'bubble.left', agent: 'person' }[a.kind] ?? 'doc.on.doc';
}

const entryId = (e) => `${e.ts ?? 0}|${e.from}|${e.kind ?? ''}|${(e.text ?? '').slice(0, 24)}`;

/** the version of the plan a message started ("Apply plan"); the engine's prompt around it isn't the person's words */
export function appliedPlan(e) {
  if (e.from !== 'user') return null;
  const m = (e.text ?? '').match(/<approved_plan id="[^"]*" version="(\d+)">/);
  return m ? Number(m[1]) : null;
}
/** what the person wrote: a fix request from a review shows without the diff sent with it */
export function shownText(e) {
  const t = e.text ?? '';
  if (e.from !== 'user' || !t.includes('\n<review_diff>\n')) return t;
  const cut = t.indexOf('\n\nReviewed turn: ');
  return cut >= 0 ? t.slice(0, cut) : t;
}

export class ChatModel {
  entries = [];
  streaming = '';
  loaded = false;
  busyRestore = null;
  error = null;
  queue = [];
  queueBusy = false;
  sending = 0;
  uploading = 0;
  branching = false;
  settingMode = false;
  job = null;
  plan = null;
  planShown = false;
  question = null;
  tasks = [];
  workflowBusy = false;
  stopping = false;
  activities = [];
  files = null;
  #versions = { task: 0, workflow: 0, activity: 0, queue: 0 };
  #watchers = new Set();

  constructor(store, canvas, agent) { this.store = store; this.canvas = canvas; this.agent = agent; }

  get path() { return `/v1/canvases/${this.canvas}/agents/${this.agent}`; }
  watch(fn) { this.#watchers.add(fn); return () => this.#watchers.delete(fn); }
  changed(what = 'all') { for (const fn of this.#watchers) fn(what); }
  fail(e) { this.error = e instanceof APIError ? e.message : e?.message || String(e); this.changed(); }

  async load() {
    try {
      const t = await api.get(`${this.path}/transcript?limit=500`);
      const ids = new Set(t.transcript.map(entryId));
      const live = this.entries.filter((e) => !ids.has(entryId(e)));
      this.entries = [...t.transcript, ...live].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
    } catch (e) { this.error = e.message; }
    const v = { ...this.#versions };
    const [a, w, tk, j] = await Promise.all([
      api.get(`${this.path}/activity`).catch(() => null), api.get(`${this.path}/workflow`).catch(() => null),
      api.get(`${this.path}/tasks`).catch(() => null), api.get(`${this.path}/job`).catch(() => null),
    ]);
    if (a && v.activity === this.#versions.activity) this.activities = a.activities ?? [];
    if (w && v.workflow === this.#versions.workflow) this.takeWorkflow(w.plan ?? null, w.question ?? null);
    if (tk && v.task === this.#versions.task) this.takeTasks(tk.tasks ?? []);
    if (j) this.job = j.job ?? null;
    await this.loadQueue();
    this.loaded = true;
    this.changed();
  }

  /** a recorded message from the canvas's events */
  take(e) {
    if ((e.from !== this.agent && e.to !== this.agent) || e.from === e.to) return;
    const id = entryId(e);
    if (this.entries.some((x) => entryId(x) === id)) return;
    if (e.from === this.agent) { this.files = null; this.#versions.activity++; this.streaming = ''; this.activities = []; this.takeTasks([]); this.stopping = false; }
    this.entries.push(e);
    this.changed();
  }
  delta(text) { this.streaming += text; this.changed('streaming'); }

  send(text, attachments) {
    const t = text.trim();
    if (!t && !attachments.length) return;
    this.sending++;
    this.changed();
    api.post(`${this.path}/messages`, { text: t, attachments })
      .catch((e) => { this.fail(e); drafts.reuse({ text: t, attachments }, this.agent); })
      .finally(() => { this.sending--; this.changed(); });
  }

  stop() {
    if (this.stopping) return;
    this.stopping = true;
    this.changed();
    api.post(`${this.path}/stop`).catch((e) => this.fail(e)).finally(() => { this.stopping = false; this.changed(); });
  }
  resumeJob() { api.post(`${this.path}/job`, { action: 'resume' }).catch((e) => this.fail(e)); }

  takeTasks(tasks) { this.#versions.task++; this.tasks = tasks; this.changed(); }
  takeWorkflow(plan, question) { this.#versions.workflow++; this.plan = plan; this.question = question; this.changed(); }
  takeActivity(activity, reset) {
    this.#versions.activity++;
    if (reset) { this.activities = []; this.streaming = ''; }
    if (activity) {
      const i = this.activities.findIndex((a) => a.id === activity.id);
      if (i >= 0) this.activities[i] = activity; else this.activities.push(activity);
    }
    this.changed();
  }
  takeQueue(messages) { this.#versions.queue++; this.queue = messages; this.changed(); }
  async loadQueue() {
    const v = this.#versions.queue;
    try { const q = await api.get(`${this.path}/queue`); if (v === this.#versions.queue) this.takeQueue(q.messages ?? []); } catch {}
  }

  async changeQueue(body, cancel = false) {
    if (this.queueBusy) return false;
    this.queueBusy = true;
    this.changed();
    try {
      if (cancel) await api.post(`${this.path}/queue`, body); else await api.patch(`${this.path}/queue`, body);
      return true;
    } catch (e) {
      this.error = e.status === 409 ? L('Queue changed; the message may have started.') : e.message;
      return false;
    } finally { this.queueBusy = false; await this.loadQueue(); }
  }

  async changeWorkflow(fields, { edit = false } = {}) {
    if (this.workflowBusy) return false;
    this.workflowBusy = true;
    this.changed();
    const v = this.#versions.workflow;
    try {
      if (edit) { const w = await api.patch(`${this.path}/workflow`, fields); if (v === this.#versions.workflow) this.takeWorkflow(w.plan ?? null, this.question); }
      else if (fields.action === 'save') { const s = await api.post(`${this.path}/workflow`, fields); this.store.openIDE?.(this.agent, s.path); }
      else if (fields.action === 'answer') { await api.post(`${this.path}/workflow`, fields); if (v === this.#versions.workflow) this.takeWorkflow(this.plan, null); }
      else {
        const w = await api.post(`${this.path}/workflow`, fields);
        if (v === this.#versions.workflow) this.takeWorkflow(w.plan ?? null, this.question);
        this.store.reloadAgent(this.agent).catch(() => {});
      }
      return true;
    } catch (e) {
      if (e.status === 409) { this.error = L('Workflow changed; re-check the plan or question.'); await this.load(); }
      else this.error = e.message;
      return false;
    } finally { this.workflowBusy = false; this.changed(); }
  }

  async setMode(mode) { await this.#setting({ chatMode: mode }); }
  async setPermission(permission) { await this.#setting({ permission }); }
  async #setting(fields) {
    if (this.settingMode) return;
    this.settingMode = true;
    this.changed();
    try { await this.store.updateAgent(this.agent, fields); } catch (e) { this.error = e.message; }
    this.settingMode = false;
    this.changed();
  }

  /** a side chat (history kept) or a new chat (fresh session), from here or from a message */
  async branch({ at = null, fresh = false } = {}) {
    if (this.branching) return null;
    this.branching = true;
    this.changed();
    try {
      const fields = { fresh };
      if (at?.ts) Object.assign(fields, { at: at.ts, from: at.from, text: at.text ?? '' });
      const a = await api.post(`${this.path}/fork`, fields);
      if (!this.store.agents.has(a.id)) this.store.order.push(a.id);
      this.store.agents.set(a.id, a);
      this.store.changed();
      return a;
    } catch (e) { this.fail(e); return null; }
    finally { this.branching = false; this.changed(); }
  }

  /** search keeps the timeline; results are places to go to */
  matches(query) {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return this.entries.map((e, i) => [e, i]).filter(([e]) => (e.text ?? '').toLowerCase().includes(q)
      || (e.attachments ?? []).some((a) => (a.path ?? a.name ?? '').toLowerCase().includes(q))
      || (e.changes ?? []).some((c) => c.path.toLowerCase().includes(q))).map(([, i]) => i);
  }

  static markdown(entries, title, agent) {
    const parts = ['# ' + title.replace(/\n/g, ' ')];
    for (const e of entries) {
      if (e.kind === 'restore') { parts.push('---\n\n' + L('Restored')); continue; }
      const heading = e.from === 'user' ? L('You') : e.from === agent ? title : e.from;
      let block = e.kind === 'changes' ? '' : `## ${heading}\n\n${e.text ?? ''}`;
      for (const a of e.attachments ?? []) {
        block += `\n\n> ${a.kind}: ${a.path ?? a.name ?? ''}`;
        if (a.kind === 'selection') block += ` · ${a.from ?? 1}–${a.to ?? a.from ?? 1}\n\n` + (a.text ?? '');
      }
      for (const t of e.tasks ?? []) block += `\n\n- [${t.status === 'completed' ? 'x' : ' '}] ${t.content} · ${t.status}`;
      for (const c of e.changes ?? []) block += `\n\n- ${c.path}` + (c.added != null ? ` (+${c.added}, −${c.removed ?? 0})` : ` (${L('binary')})`);
      if (block) parts.push(block);
    }
    return parts.join('\n\n') + '\n';
  }

  /** the whole conversation as a Markdown file the browser saves */
  async export(title) {
    try {
      const t = await api.get(`${this.path}/transcript?limit=100000`);
      const blob = new Blob([ChatModel.markdown(t.transcript, title, this.agent)], { type: 'text/markdown' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = title.replace(/[\\/]/g, '-') + '.md';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (e) { this.fail(e); }
  }

  /** back to a checkpoint (or forward again, with a restore's redo point) */
  restore(checkpoint) {
    if (this.busyRestore) return;
    this.busyRestore = checkpoint;
    this.changed();
    api.post(`${this.path}/restore`, { checkpoint }).catch((e) => this.fail(e)).finally(() => { this.busyRestore = null; this.changed(); });
  }

  /** an image pasted or dropped: kept in the workspace, attached by its path */
  async upload(blob) {
    this.uploading++;
    this.changed();
    try {
      const r = await fetch(`${this.path}/attachments`, { method: 'POST', headers: { 'content-type': blob.type || 'image/png' }, body: blob });
      if (r.status !== 201) throw new Error();
      return { kind: 'image', path: (await r.json()).path };
    } catch { this.error = L("Couldn't attach the image"); return null; }
    finally { this.uploading--; this.changed(); }
  }

  /** the files of its folder, for @ (loaded once) */
  async fileList() {
    if (this.files) return this.files;
    try { this.files = (await api.get(`${this.path}/ide/files`)).files ?? []; } catch { this.files = []; }
    return this.files;
  }

  /** a restore that steps forward again over the one right before it (Redo) */
  wentForward(i) {
    const e = this.entries[i], prev = this.entries[i - 1];
    if (!e || e.kind !== 'restore' || !prev || prev.kind !== 'restore' || !prev.redo || prev.redo !== e.checkpoint) return false;
    return !this.wentForward(i - 1);
  }

  /** the checkpoint before the turn a user message started */
  checkpointAfter(i) {
    for (const e of this.entries.slice(i + 1)) {
      if (e.from === 'user' && e.kind !== 'restore') return null;
      if (e.checkpoint && e.kind !== 'restore') return e.checkpoint;
    }
    return null;
  }
}

/** FuzzyPath (TaksimKit/IDE.swift): subsequence matches, word starts and the file name count most */
export function fuzzyRank(query, paths, limit = 50) {
  const q = [...query.toLowerCase().replace(/\s/g, '')];
  if (!q.length) return paths.slice(0, limit);
  const score = (path) => {
    const p = [...path.toLowerCase()], nameStart = path.lastIndexOf('/') + 1;
    let s = 0, qi = 0, last = -2;
    for (let i = 0; i < p.length && qi < q.length; i++) {
      if (p[i] !== q[qi]) continue;
      s += 1;
      if (i === last + 1) s += 5;
      if (i === 0 || '/_-. '.includes(p[i - 1])) s += 8;
      if (i >= nameStart) s += 3;
      last = i;
      qi++;
    }
    return qi === q.length ? s * 100 - path.length : null;
  };
  return paths.map((p) => [p, score(p)]).filter(([, s]) => s != null).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([p]) => p);
}
