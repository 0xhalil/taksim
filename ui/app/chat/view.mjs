// The chat inside a node (Chat/ChatView.swift, ChatComposer.swift and the cards beside them): messages as they
// happen, each answer's changed files with the way back, the plan and question cards, the queue, and the
// composer. Calm surfaces; the person's messages sit in a wash, the agent's answers are plain text.
import { L } from '../theme.mjs';
import { icon } from '../icons.mjs';
import { el, btn, menu, tooltip } from '../ui.mjs';
import { effortName } from '../graph.mjs';
import { backendLabel } from '../store.mjs';
import { markdown, copyButton, copyText } from './markdown.mjs';
import { openReview } from './review.mjs';
import { drafts, attachmentId, attachmentLabel, attachmentSymbol, appliedPlan, shownText, fuzzyRank } from './model.mjs';

const count = (n, one, other) => (n === 1 ? L(one) : L(other, n));
const base = (p) => (p ?? '').split(/[\\/]/).filter(Boolean).at(-1) ?? '';
const dir = (p) => { const parts = (p ?? '').split('/'); parts.pop(); return parts.join('/'); };

/** a small quiet key (Tap): a well under it on hover, it sinks when pressed */
function tap(symbol, help, run, size = 12) {
  const b = btn('tap', symbol ? icon(symbol, size) : null, run, help);
  return b;
}

export class ChatView {
  searching = false;
  query = '';
  match = 0;
  following = true;
  rows = new Map();

  constructor(model, app) {
    this.model = model;
    this.app = app;
    this.store = app.store;
    this.root = el('div', 'chat');
    this.toolbar = el('div', 'chat-bar');
    this.list = el('div', 'chat-list');
    this.inner = el('div', 'chat-inner');
    this.list.append(this.inner);
    this.latest = btn('chat-latest', 'arrow.down', () => { this.following = true; this.#scrollEnd(true); this.#latest(); }, L('Go to latest message'));
    this.listWrap = el('div', 'chat-list-wrap', this.list, this.latest);
    this.footer = el('div', 'chat-footer');
    this.composer = new Composer(model, app, this);
    this.root.append(this.toolbar, this.listWrap, this.footer);
    this.list.addEventListener('scroll', () => {
      const near = this.list.scrollTop + this.list.clientHeight >= this.list.scrollHeight - 40;
      if (this.ownScroll) { this.ownScroll = false; return; }
      if (!this.searching) this.following = near;
      this.#latest();
    });
    // pinches and ⌘-wheel zoom the canvas; plain scrolling scrolls the chat
    this.root.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); app.graph.wheel(e); }
    }, { passive: false });
    this.root.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); e.stopPropagation(); this.openSearch(); }
    });
    model.watch((what) => this.schedule(what));
    if (!model.loaded) model.load();
    this.render();
  }

  get agent() { return this.store.agents.get(this.model.agent); }
  get running() { return ['running', 'waiting'].includes(this.agent?.status ?? ''); }

  schedule(what) {
    if (what === 'streaming') this.streamDirty = true; else this.dirty = true;
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      if (this.dirty) { this.dirty = this.streamDirty = false; this.render(); }
      else if (this.streamDirty) { this.streamDirty = false; this.#tail(); this.#follow(); }
    });
  }

  render() {
    this.#toolbar();
    this.#messages();
    this.#footer();
    this.composer.render();
    this.#follow();
  }

  // ---------- toolbar ----------

  #toolbar() {
    const a = this.agent, bar = this.toolbar;
    bar.replaceChildren();
    if (this.searching) {
      const field = el('input', 'chat-search');
      field.placeholder = L('Search');
      field.value = this.query;
      const matches = this.model.matches(this.query);
      const n = el('span', 'chat-count', matches.length ? `${this.match + 1}/${matches.length}` : '0');
      field.addEventListener('input', () => { this.query = field.value; this.match = 0; this.#toolbarCount(); this.#messages(); this.#reveal(); });
      field.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { this.#step(e.shiftKey ? -1 : 1); }
        if (e.key === 'Escape') this.closeSearch();
      });
      const prev = tap('chevron.up', L('Previous'), () => this.#step(-1)), next = tap('chevron.down', L('Next'), () => this.#step(1));
      prev.disabled = next.disabled = !matches.length;
      bar.append(field, n, prev, next, tap('xmark', L('Close'), () => this.closeSearch()));
      this.countEl = n;
      if (this.focusSearch) { this.focusSearch = false; requestAnimationFrame(() => field.focus()); }
      return;
    }
    bar.append(el('span', 'chat-title', L('Chat')));
    if (a?.status === 'waiting' || a?.workingWith?.length) {
      const p = el('span', 'chat-paused', icon('pause.circle', 11));
      p.title = a.status === 'waiting' ? L('Waiting for a reply') : L('%d agents are working for it', a.workingWith.length);
      bar.append(p);
    }
    if (a?.chatOrigin) {
      const o = btn('tap chat-origin', null, () => this.app.revealAgent(a.chatOrigin.id), L('Go to main chat'));
      o.append(icon('arrow.triangle.branch', 11), el('span', null, a.chatOrigin.name));
      bar.append(o);
    }
    bar.append(el('span', 'spacer'));
    const fresh = tap('plus', L('New chat'), () => this.#branch({ fresh: true }));
    fresh.disabled = this.model.branching;
    bar.append(fresh, tap('magnifyingglass', L('Search in chat (⌘F)'), () => this.openSearch()));
    const more = tap('ellipsis', L('Chat'), () => menu(more, [
      { label: L('Side chat'), icon: 'arrow.triangle.branch', disabled: this.model.branching, run: () => this.#branch({}) },
      null,
      { label: L('Export Markdown…'), icon: 'square.and.arrow.up', run: () => this.model.export(a?.name ?? L('Chat')) },
    ]));
    bar.append(more);
  }

  #toolbarCount() {
    const m = this.model.matches(this.query);
    if (this.countEl) this.countEl.textContent = m.length ? `${this.match + 1}/${m.length}` : '0';
  }

  openSearch() { this.searching = true; this.following = false; this.focusSearch = true; this.render(); }
  closeSearch() { this.searching = false; this.query = ''; this.following = true; this.render(); }
  #step(d) {
    const m = this.model.matches(this.query);
    if (!m.length) return;
    this.match = (this.match + d + m.length) % m.length;
    this.#toolbarCount();
    this.#messages();
    this.#reveal();
  }
  #reveal() {
    const m = this.model.matches(this.query), i = m[this.match];
    this.inner.querySelector(`[data-index="${i}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  async #branch(opts) {
    const a = await this.model.branch(opts);
    if (a) { this.app.revealAgent(a.id); setTimeout(() => drafts.ask(a.id), 350); }
  }

  // ---------- messages ----------

  /** a finished plan stays where it ended: what was said after it comes after it */
  #planIndex() {
    const p = this.model.plan;
    if (!p || (p.status !== 'done' && p.status !== 'failed')) return -1;
    return this.model.entries.findIndex((e) => (e.ts ?? 0) > p.updatedAt);
  }

  #messages() {
    const m = this.model, rows = [], seen = new Set();
    const matches = new Set(this.searching ? m.matches(this.query) : []);
    const destination = this.searching ? m.matches(this.query)[this.match] : -1;
    const planAt = this.#planIndex();
    const lastRestore = m.entries.map((e) => e.kind).lastIndexOf('restore');
    const lastAnswer = m.entries.map((e) => e.from).lastIndexOf(m.agent);
    const running = this.running;
    this.root.classList.toggle('running', running);

    if (!this.loadedOnce) {
      if (this.model.loaded || m.entries.length > 0) {
        this.loadedOnce = true;
        this.seenCount = m.entries.length;
      }
    }

    m.entries.forEach((e, i) => {
      if (i === planAt && m.plan) rows.push(this.#planCard());
      const isLastAnswer = (i === lastAnswer);
      const isLastRestore = (i === lastRestore);
      const key = [
        i,
        e.ts ?? 0,
        e.kind ?? '',
        e.from ?? '',
        (e.text ?? '').length,
        e.tasks?.length ?? 0,
        e.activities?.length ?? 0,
        e.changes?.length ?? 0,
        e.kind === 'restore' ? isLastRestore : '',
        isLastAnswer ? [isLastAnswer, this.agent?.chatMode, !m.plan, running].join(':') : '',
        e.kind === 'error' ? running : '',
      ].join('|');

      let row = this.rows.get(key);
      if (!row) {
        row = this.#row(i, e, { latestRestore: isLastRestore, lastAnswer: isLastAnswer });
        if (i >= this.seenCount) {
          row.classList.add('anim-in');
        }
      }
      seen.add(key);
      this.rows.set(key, row);
      row.classList.toggle('found', i === destination);
      row.classList.toggle('match', matches.has(i) && i !== destination);
      rows.push(row);
    });

    this.seenCount = Math.max(this.seenCount, m.entries.length);

    for (const k of this.rows.keys()) if (!seen.has(k)) this.rows.delete(k);
    if (planAt < 0 && m.plan) rows.push(this.#planCard());
    if (m.activities.length) rows.push(activityView(m.activities));
    if (!this.tailEl) this.tailEl = el('div', 'chat-tail');
    rows.push(this.tailEl);
    if (!m.entries.length && !m.plan && !m.question && !running) rows.push(this.#empty());

    const nextChildren = rows.filter(Boolean);
    let same = this.inner.childElementCount === nextChildren.length;
    if (same) {
      let cur = this.inner.firstElementChild;
      for (let j = 0; j < nextChildren.length; j++) {
        if (cur !== nextChildren[j]) { same = false; break; }
        cur = cur.nextElementSibling;
      }
    }
    if (!same) {
      this.inner.replaceChildren(...nextChildren);
    }
    this.#tail();
  }

  /** the answer streaming in, else what it's doing while its turn hasn't spoken */
  #tail() {
    const m = this.model, a = this.agent;
    if (!this.tailEl) return;
    if (m.streaming) {
      if (this.tailEl._streamText !== m.streaming) {
        this.tailEl._streamText = m.streaming;
        this.tailEl.replaceChildren(markdown(m.streaming));
      }
      return;
    }
    this.tailEl._streamText = null;
    if (this.running && !m.question) {
      const holders = a?.blockedBy ?? [];
      if (holders.length) {
        const names = holders.map((id) => this.store.agents.get(id)?.name).filter(Boolean).join(', ');
        const b = btn('tap chat-blocked', null, () => this.app.revealAgent(holders[0]), L('Waiting: this agent is writing in the same folder'));
        b.append(icon('lock', 11), el('span', null, names), icon('arrow.up.right', 9));
        this.tailEl.replaceChildren(b);
      } else if (!this.tailEl.querySelector('.chat-working')) this.tailEl.replaceChildren(working());
      return;
    }
    this.tailEl.replaceChildren();
  }

  #empty() {
    const mode = this.agent?.chatMode;
    const box = el('div', 'chat-empty');
    if (this.list.clientHeight === 0 || this.list.clientHeight >= 190) box.append(icon(mode === 'plan' ? 'list.bullet.clipboard' : mode === 'ask' ? 'bubble.left' : 'bubble.left.and.text.bubble.right', 26, 1.2));
    box.append(el('div', 'chat-empty-title', mode === 'plan' ? L('New plan') : mode === 'ask' ? L('New question') : L('New chat')));
    const action = (key, label, run) => { const b = btn('tap chat-empty-key', null, run); b.append(el('kbd', null, key), el('span', null, label)); return b; };
    box.append(el('div', 'chat-empty-keys',
      action('@', L('Context'), () => { const d = drafts.text[this.model.agent] ?? ''; drafts.set(this.model.agent, !d || /\s$/.test(d) ? d + '@' : d + ' @'); drafts.ask(this.model.agent); }),
      action('/', L('Command'), () => { if (!drafts.text[this.model.agent]) drafts.set(this.model.agent, '/'); drafts.ask(this.model.agent); })));
    return box;
  }

  #row(i, e, { latestRestore, lastAnswer }) {
    const m = this.model;
    let row;
    if (e.kind === 'restore') row = this.#restoreDivider(e, latestRestore, m.wentForward(i));
    else if (e.kind === 'changes') row = e.changes?.length ? this.#changesCard(e) : el('div');
    else if (e.kind === 'job') {
      row = el('div', 'chat-divider', el('i'), el('span', null, icon('point.3.connected.trianglepath.dotted', 11), L('Work ended')), el('i'));
      row.addEventListener('contextmenu', (ev) => { ev.preventDefault(); menu({ x: ev.clientX, y: ev.clientY }, [{ label: L('Copy'), icon: 'doc.on.doc', run: () => copyText(e.text ?? '') }]); });
    } else if (e.to === m.agent) row = this.#userMessage(e, i);
    else if (e.from === m.agent) row = this.#answer(e, i, lastAnswer);
    else row = el('div');
    row.classList.add('chat-row');
    row.dataset.index = i;
    return row;
  }

  #answer(e, i, lastAnswer) {
    const m = this.model, row = el('div', 'chat-answer');
    const stopped = e.kind === 'error' && e.text === 'stopped';
    if (e.kind === 'error' && !stopped) row.append(el('div', 'chat-failed', L("Couldn't complete")));
    if (e.tasks?.length) row.append(taskList(e.tasks, { live: false }));
    if (e.activities?.length) row.append(activityView(e.activities));
    if (stopped) row.append(el('div', 'chat-stopped', icon('stop.circle', 12), L('Stopped')));
    else if (e.kind === 'error') {
      row.append(el('div', 'chat-error selectable', icon('exclamationmark.triangle.fill', 12), el('span', null, e.text ?? '')));
      if (e.signIn && lastAnswer) {
        const s = btn('chat-signin', null, () => this.app.openSettings('accounts'));
        s.append(icon('person', 14), L('Sign in'));
        row.append(s);
      }
    } else row.append(markdown(e.text ?? ''));
    const actions = el('div', 'chat-actions' + (e.kind === 'error' ? ' shown' : ''));
    const usage = (e.usage?.input ?? 0) + (e.usage?.output ?? 0);
    if (usage > 0) { const u = el('span', 'chat-usage', count(usage, '1 token', '%d tokens')); u.title = L('Input: %d · Output: %d', e.usage.input ?? 0, e.usage.output ?? 0); actions.append(u); }
    actions.append(el('span', 'spacer'));
    if (this.agent?.chatMode === 'plan' && e.kind === 'assistant' && !m.plan && !this.running && lastAnswer) {
      const p = tap('list.bullet.clipboard', L('Open as plan'), () => m.changeWorkflow({ action: 'publish', title: 'Plan', content: e.text ?? '' }), 11);
      p.disabled = m.workflowBusy;
      actions.append(p);
    }
    const request = m.entries.slice(0, i).reverse().find((x) => x.from === 'user' && x.kind !== 'restore');
    if (e.kind === 'error' && request) {
      const r = tap('arrow.clockwise', L('Retry'), () => m.send(request.text ?? '', request.attachments ?? []));
      r.disabled = this.running || m.sending > 0;
      actions.append(r);
    }
    actions.append(copyButton(e.text ?? '', L('Copy response')));
    row.append(actions);
    if (e.changes?.length) row.append(this.#changesCard(e));
    row.addEventListener('contextmenu', (ev) => {
      if (window.getSelection()?.toString()) return;
      ev.preventDefault();
      menu({ x: ev.clientX, y: ev.clientY }, [
        { label: L('Copy'), icon: 'doc.on.doc', run: () => copyText(e.text ?? '') },
        { label: L('Branch from here'), icon: 'arrow.triangle.branch', disabled: m.branching, run: () => this.#branch({ at: e }) },
      ]);
    });
    return row;
  }

  /** what was asked: in a wash, its attachments as chips; hovering offers going back to before it */
  #userMessage(e, i) {
    const m = this.model, box = el('div', 'chat-user');
    if (e.from !== 'user') box.append(el('div', 'chat-who', this.store.agents.get(e.from)?.name ?? e.from));
    if (e.attachments?.length) box.append(chipRow(e.attachments, { open: (a) => a.path && this.app.openIDE?.(m.agent, a.path), imageUrl: (p) => `${m.path}/attachments?path=${encodeURIComponent(p)}` }));
    const plan = appliedPlan(e);
    if (plan != null) box.append(el('div', 'chat-applied', icon('list.bullet.clipboard', 12), `${L('Apply plan')} · v${plan}`));
    else { const t = shownText(e); if (t) box.append(el('div', 'chat-text selectable', t)); }
    const checkpoint = m.checkpointAfter(i);
    if (checkpoint) {
      const back = btn('chat-goback', null, () => m.restore(checkpoint), L('Restore the folder to before this message'));
      back.append(icon('arrow.uturn.backward', 11), L('Go back'));
      box.append(back);
    }
    box.addEventListener('contextmenu', (ev) => {
      if (window.getSelection()?.toString()) return;
      ev.preventDefault();
      const items = [{ label: L('Copy'), icon: 'doc.on.doc', run: () => copyText(shownText(e)) }];
      if (e.from === 'user' && plan == null) {
        items.push({ label: L('Edit and reuse'), icon: 'pencil', run: () => drafts.reuse(e, m.agent) });
        items.push({ label: L('Branch from here'), icon: 'arrow.triangle.branch', disabled: m.branching, run: () => this.#branch({ at: e }) });
      }
      menu({ x: ev.clientX, y: ev.clientY }, items);
    });
    return box;
  }

  #restoreDivider(e, latest, forward) {
    const m = this.model, row = el('div', 'chat-divider', el('i'), el('span', null, icon(forward ? 'arrow.uturn.forward' : 'arrow.uturn.backward', 11), forward ? L('Redone') : L('Restored')));
    if (latest && e.redo) {
      const b = el('button', 'tap chat-link', forward ? L('Undo') : L('Redo'));
      b.type = 'button';
      b.disabled = !!m.busyRestore;
      b.addEventListener('click', () => m.restore(e.redo));
      row.append(b);
    }
    row.append(el('i'));
    return row;
  }

  /** the files a turn changed: +/− per file, a click opens the turn's own diff; Undo restores the folder */
  #changesCard(e) {
    const m = this.model, ch = e.changes ?? [], card = el('div', 'chat-changes');
    const add = ch.reduce((s, c) => s + (c.added ?? 0), 0), rem = ch.reduce((s, c) => s + (c.removed ?? 0), 0);
    const head = el('div', 'chat-changes-head', icon('doc.on.doc', 11), el('b', null, count(ch.length, '1 file', '%d files')), el('span', 'plus', `+${add}`), el('span', 'minus', `−${rem}`), el('span', 'spacer'));
    const busy = !!m.busyRestore || this.agent?.status === 'running';
    if (e.checkpoint && e.after) {
      const r = btn('tap accent', null, () => ch[0] && this.#openDiff(e, ch[0]), L('Review'));
      r.append(icon('doc.text.magnifyingglass', 11), el('span', 'words', L('Review')));
      head.append(r);
    }
    if (e.checkpoint) {
      const u = btn('tap', null, () => m.restore(e.checkpoint), L('Revert entire turn'));
      u.append(icon('arrow.uturn.backward', 11), el('span', 'words', L('Undo')));
      u.disabled = busy;
      head.append(u);
    }
    card.append(head);
    let expanded = false;
    const list = el('div');
    const fill = () => {
      list.replaceChildren(...ch.slice(0, expanded ? ch.length : 12).map((c) => {
        const b = el('button', 'chat-change');
        b.type = 'button';
        b.append(el('span', 'name', base(c.path)), el('span', 'dir', dir(c.path)), el('span', 'spacer'));
        if (c.added != null) b.append(el('span', 'plus', `+${c.added}`));
        if (c.removed != null) b.append(el('span', 'minus', `−${c.removed}`));
        if (c.added == null) b.append(el('span', 'muted', L('binary')));
        b.addEventListener('click', () => this.#openDiff(e, c));
        return b;
      }));
      if (ch.length > 12) {
        const more = el('button', 'chat-change more');
        more.type = 'button';
        more.append(icon(expanded ? 'chevron.up' : 'chevron.down', 10), expanded ? L('Collapse') : L('%d more files', ch.length - 12));
        more.addEventListener('click', () => { expanded = !expanded; fill(); });
        list.append(more);
      }
    };
    fill();
    card.append(list);
    card.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      const items = [];
      if (e.checkpoint && e.after) items.push({ label: L('Review hunks'), run: () => openReview(e, m, this.app) });
      if (e.checkpoint) items.push({ label: L('Revert entire turn'), disabled: busy, run: () => m.restore(e.checkpoint) });
      if (items.length) menu({ x: ev.clientX, y: ev.clientY }, items);
    });
    return card;
  }

  #openDiff(e, c) {
    if ((c.added == null && c.removed == null) || (!e.checkpoint && !e.after)) return this.app.openIDE?.(this.model.agent, c.path);
    this.app.showDiff?.(this.model.agent, c.path, e.checkpoint, e.after);
  }

  // ---------- the plan's handle ----------

  #planCard() {
    const m = this.model, plan = m.plan, running = this.running;
    const available = !running && !m.queue.length && !m.workflowBusy;
    const status = { running: L('Applying'), done: L('Done'), failed: L('Failed') }[plan.status] ?? L('Ready for review');
    const skip = (s) => s.replace(/^[#\-*>+\s]+/, '').replace(/\*\*|`/g, '').replace(/\[[ xX]\] /g, '').trim();
    const preview = plan.content.split('\n').map(skip).filter((l) => l && l.toLowerCase() !== plan.title.toLowerCase() && !l.startsWith('```')).slice(0, 3).join('\n');
    const card = el('div', 'chat-plan');
    const top = btn('tap chat-plan-top', null, () => { m.planShown = !m.planShown; m.changed(); this.app.layoutBodies?.(); this.app.graph.kick(); }, m.planShown ? L('Close plan') : L('Open plan beside the chat'));
    const st = el('span', 'status', status);
    st.style.color = plan.status === 'done' ? 'var(--ok)' : plan.status === 'failed' ? 'var(--err)' : 'var(--muted)';
    const side = icon('sidebar.left', 13);
    side.style.transform = 'scaleX(-1)';
    side.style.color = m.planShown ? 'var(--accent)' : 'var(--muted)';
    top.append(el('span', 'accent', icon('list.bullet.clipboard', 13)), el('b', null, plan.title), el('span', 'muted2', `v${plan.version}`), el('span', 'spacer'), st, side);
    card.append(top);
    if (preview) card.append(el('div', 'chat-plan-preview', preview));
    const row = el('div', 'chat-plan-actions', el('span', 'spacer'));
    const act = (action) => m.changeWorkflow({ action, id: plan.id, version: plan.version });
    if (plan.status === 'draft') {
      const apply = btn('chat-primary', null, () => act('build'), L('Apply version %d of this plan in Agent mode', plan.version));
      apply.append(icon('play.fill', 11), L('Apply plan'));
      apply.disabled = !available;
      row.append(apply);
    } else if (plan.status !== 'running') {
      const replan = btn('tap', null, () => act('revise'));
      replan.append(icon('arrow.clockwise', 11), L('Replan'));
      replan.disabled = !available;
      row.append(replan);
    }
    card.append(row);
    return card;
  }

  // ---------- below the messages ----------

  #footer() {
    const m = this.model, a = this.agent, parts = [];
    if (m.tasks.length) parts.push(el('div', 'chat-pad', taskList(m.tasks, { live: true, paused: a?.status === 'waiting' })));
    if (m.error) {
      const close = tap('xmark', L('Close'), () => { m.error = null; this.render(); }, 10);
      parts.push(el('div', 'chat-errorbar', icon('exclamationmark.triangle', 11), el('span', 'selectable', m.error), el('span', 'spacer'), close));
    }
    if (m.job && this.#showsJob(m.job)) parts.push(el('div', 'chat-pad', jobCard(m.job, m, this.app)));
    if (m.queue.length) parts.push(queueView(m));
    if (m.question) {
      this.questionCard ??= new QuestionCard(m);
      this.questionCard.update(m.question);
      parts.push(this.questionCard.root);
    } else this.questionCard = null;
    if (!m.question) parts.push(this.composer.root);
    this.footer.replaceChildren(...parts);
  }

  #showsJob(job) {
    if (['proposed', 'running'].includes(job.status)) return true;
    const asked = [...this.model.entries].reverse().find((e) => e.from === 'user' && e.kind === 'user')?.ts ?? 0;
    return (job.updatedAt ?? 0) >= asked && job.status !== 'declined';
  }

  // ---------- following the latest ----------

  #follow() { if (this.following) this.#scrollEnd(false); this.#latest(); }
  #scrollEnd(smooth) {
    this.ownScroll = this.list.scrollTop !== this.list.scrollHeight - this.list.clientHeight;
    this.list.scrollTo({ top: this.list.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }
  #latest() { this.latest.hidden = this.following || this.searching || this.list.scrollHeight <= this.list.clientHeight; }

  focus() { this.composer.focus(); }
}

// ---------- the composer ----------

class Composer {
  suggestions = [];
  selected = 0;

  constructor(model, app, view) {
    this.model = model;
    this.app = app;
    this.view = view;
    this.store = app.store;
    this.root = el('div', 'composer');
    this.popup = el('div', 'composer-popup');
    this.uploads = el('div', 'composer-uploads');
    this.chips = el('div');
    this.field = el('textarea', 'composer-field');
    this.field.rows = 1;
    this.field.spellcheck = true;
    this.field.setAttribute('aria-label', L('Message'));
    this.field.value = drafts.text[model.agent] ?? '';
    this.row = el('div', 'composer-row');
    this.root.append(this.popup, this.uploads, this.chips, this.field, this.row);
    this.field.addEventListener('input', () => { drafts.set(model.agent, this.field.value); this.#size(); this.#suggest(); this.#popup(); this.#send(); });
    this.field.addEventListener('keydown', (e) => this.#key(e));
    this.field.addEventListener('focus', () => this.root.classList.add('focused'));
    this.field.addEventListener('blur', () => this.root.classList.remove('focused'));
    this.field.addEventListener('paste', (e) => {
      const img = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
      if (!img || e.clipboardData.getData('text/plain')) return;
      e.preventDefault();
      this.#upload(img.getAsFile());
    });
    for (const t of ['dragenter', 'dragover']) this.root.addEventListener(t, (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); this.root.classList.add('drop'); } });
    this.root.addEventListener('dragleave', (e) => { if (!this.root.contains(e.relatedTarget)) this.root.classList.remove('drop'); });
    this.root.addEventListener('drop', (e) => {
      e.preventDefault();
      this.root.classList.remove('drop');
      for (const f of e.dataTransfer?.files ?? []) {
        if (f.type.startsWith('image/')) this.#upload(f);
        else if (f.path) drafts.add({ kind: 'file', path: f.path }, model.agent); // a desktop shell gives the file's path
      }
    });
    this.unlisten = (drafts.listeners.add((id) => { if (id === model.agent) this.#fromDrafts(); }), () => {});
    new ResizeObserver(() => { const w = this.root.clientWidth; if (Math.abs(w - (this.width ?? 0)) > 20) { this.width = w; this.render(); } }).observe(this.root);
  }

  get agent() { return this.store.agents.get(this.model.agent); }
  get text() { return drafts.text[this.model.agent] ?? ''; }
  get attached() { return drafts.attachments[this.model.agent] ?? []; }
  get mode() { const a = this.agent; return a?.chatMode ?? (a?.sandbox === 'read-only' ? 'ask' : 'agent'); }
  get locked() { return this.view.running || (this.agent?.queued ?? 0) > 0 || this.model.settingMode || this.model.sending > 0; }

  #fromDrafts() {
    if (this.field.value !== this.text) { this.field.value = this.text; this.#size(); this.#suggest(); this.#popup(); }
    this.render();
    if (drafts.focus === this.model.agent) { drafts.focus = null; this.focus(); }
  }

  focus() { this.field.focus(); const n = this.field.value.length; this.field.setSelectionRange(n, n); }

  render() {
    const m = this.model, a = this.agent, running = this.view.running, narrow = (this.root.clientWidth || 600) < 340;
    this.field.placeholder = running ? L('Add to queue') : this.mode === 'ask' ? L('Ask about the code') : this.mode === 'plan' ? L('What should we plan?')
      : narrow ? L('Ask for something…') : L('Ask for something…  / for commands · @ for context');
    this.uploads.replaceChildren(...(m.uploading > 0 ? [el('span', null, icon('arrow.up', 11), L('%d images', m.uploading))] : []));
    this.chips.replaceChildren(...(this.attached.length ? [chipRow(this.attached, { remove: (x) => drafts.remove(x, m.agent), open: (x) => x.path && this.app.openIDE?.(m.agent, x.path), imageUrl: (p) => `${m.path}/attachments?path=${encodeURIComponent(p)}` })] : []));
    this.row.replaceChildren(this.#modeChip(), ...[this.#permissionChip()].filter(Boolean), this.#modelChip(), el('span', 'spacer'));
    if (m.sending > 0) { const s = el('span', 'accent', icon('ellipsis', 12)); s.title = L('Sending'); this.row.append(s); }
    const queued = (a?.queued ?? 0) - m.queue.length;
    if (queued > 0) this.row.append(el('span', 'composer-pending', L('%d pending', queued)));
    if (a?.context?.window > 0) this.row.append(contextGauge(a.context));
    this.row.append(this.#attachKey());
    this.sendKey = el('button', 'composer-send');
    this.sendKey.type = 'button';
    this.sendKey.addEventListener('click', () => { if (this.view.running && this.#empty()) m.stop(); else this.send(); });
    this.row.append(this.sendKey);
    this.#send();
    this.#size();
    this.#popup();
  }

  #empty() { return !this.text.trim() && !this.attached.length; }

  #send() {
    if (!this.sendKey) return;
    const m = this.model, running = this.view.running, empty = this.#empty(), stopping = running && empty;
    this.sendKey.replaceChildren(icon(m.stopping ? 'ellipsis' : stopping ? 'stop.fill' : running ? 'text.line.first.and.arrowtriangle.forward' : 'arrow.up', 13, 2));
    this.sendKey.classList.toggle('stop', stopping);
    this.sendKey.classList.toggle('idle', !running && empty);
    this.sendKey.disabled = (!running && empty) || m.stopping || m.uploading > 0;
    const help = stopping ? L('Stop') : running ? L('Add to queue (⏎)') : L('Send (⏎)');
    this.sendKey.title = help;
    this.sendKey.setAttribute('aria-label', help.replace(/ \(⏎\)$/, ''));
  }

  /** as tall as its lines, between 42 and 144 */
  #size() {
    this.field.style.height = 'auto';
    this.field.style.height = Math.min(144, Math.max(42, this.field.scrollHeight + 2)) + 'px';
  }

  send() {
    const m = this.model;
    if (m.uploading) return;
    if (this.#pickCommand()) return;
    if (this.#empty()) return;
    m.send(this.text, this.attached);
    drafts.clear(m.agent);
    this.field.value = '';
    this.suggestions = [];
    this.#size();
    this.#popup();
    this.#send();
  }

  #key(e) {
    e.stopPropagation();
    const list = this.#commands().length ? this.#commands() : this.suggestions;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!this.#pickSuggestion()) this.send(); return; }
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      if (this.locked) return;
      const modes = ['agent', 'ask', 'plan'];
      this.model.setMode(modes[(modes.indexOf(this.mode) + 1) % 3]);
      return;
    }
    if (e.key === 'Tab' && list.length) { e.preventDefault(); this.#pickCommand() || this.#pickSuggestion(); return; }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && list.length) {
      e.preventDefault();
      this.selected = (this.selected + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
      this.#popup();
      return;
    }
    if (e.key === 'Escape') {
      if (this.#commands().length) { e.preventDefault(); drafts.set(this.model.agent, ''); this.field.value = ''; this.#popup(); return; }
      if (this.suggestions.length) { e.preventDefault(); this.suggestions = []; this.#popup(); }
    }
  }

  // ---------- / commands ----------

  #commands() {
    const t = this.text;
    if (!t.startsWith('/') || /\s/.test(t)) return [];
    return [
      ['/side', L('Side chat'), L('Branch aside, history stays'), 'arrow.triangle.branch'],
      ['/new', L('New chat'), L('Same model, fresh session'), 'plus.bubble'],
      ['/files', L('Add files'), L('Pick files and folders'), 'paperclip'],
      ['/export', L('Export'), L('Save as Markdown'), 'square.and.arrow.up'],
      ['/agents', L('Create agents'), this.agent?.delegate ? L('On · click to turn off') : L('Split work across agents'), 'person.2.badge.plus'],
      ['/agent', L('Agent'), L('Apply and verify'), 'bolt'],
      ['/ask', L('Ask'), L('Research the code'), 'bubble.left'],
      ['/plan', L('Plan'), L('Review the plan first'), 'list.bullet.clipboard'],
    ].filter(([id]) => id.startsWith(t.toLowerCase()));
  }

  #pickCommand() {
    const c = this.#commands()[this.selected];
    if (!c) return false;
    this.#execute(c[0]);
    return true;
  }

  async #execute(id) {
    const m = this.model, original = this.text, clear = () => { drafts.set(m.agent, ''); this.field.value = ''; this.#popup(); };
    if (id === '/side' || id === '/new') { const a = await m.branch({ fresh: id === '/new' }); if (a && this.text === original) clear(); if (a) { this.app.revealAgent(a.id); setTimeout(() => drafts.ask(a.id), 350); } return; }
    if (['/agent', '/ask', '/plan'].includes(id)) {
      if (this.locked) return;
      await m.setMode(id.slice(1));
      if (this.agent?.chatMode === id.slice(1) && this.text === original) clear();
      return;
    }
    clear();
    if (id === '/agents') this.store.setHelpers(m.agent, !this.agent?.delegate);
    if (id === '/files') { drafts.set(m.agent, '@'); this.field.value = '@'; this.#suggest(); this.focus(); }
    if (id === '/export') m.export(this.agent?.name ?? L('Chat'));
  }

  // ---------- @ ----------

  #mention(t) {
    const at = t.lastIndexOf('@');
    if (at < 0 || (at > 0 && !/\s/.test(t[at - 1]))) return null;
    const q = t.slice(at + 1);
    return /\s/.test(q) ? null : q;
  }

  async #suggest() {
    const t = this.text, q = this.#mention(t), m = this.model;
    this.selected = 0;
    if (q == null) { if (this.suggestions.length) { this.suggestions = []; this.#popup(); } return; }
    const ql = q.toLowerCase(), others = this.store.currentAgents.filter((a) => a.id !== m.agent);
    const agents = others.filter((a) => !q || a.name.toLowerCase().includes(ql)).slice(0, 3).map((a) => ({ kind: 'agent', name: a.name }));
    const conversations = others.filter((a) => a.lastText && (!q || a.name.toLowerCase().includes(ql))).slice(0, 2).map((a) => ({ kind: 'conversation', path: a.id, name: a.name }));
    const paths = await m.fileList();
    const folders = new Set();
    for (const p of paths) { const parts = p.split('/'); for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/')); }
    const dirs = fuzzyRank(q, [...folders].sort(), 3).map((p) => ({ kind: 'folder', path: p }));
    const files = fuzzyRank(q, paths, 7).map((p) => ({ kind: 'file', path: p }));
    if (this.text !== t) return;
    this.suggestions = [...agents, ...conversations, ...dirs, ...files].slice(0, 10);
    this.#popup();
  }

  #pickSuggestion() {
    if (this.#pickCommand()) return true;
    const a = this.suggestions[this.selected];
    if (!a) return false;
    this.#pick(a);
    return true;
  }

  #pick(a) {
    const t = this.text, at = t.lastIndexOf('@');
    if (at >= 0) { drafts.text[this.model.agent] = t.slice(0, at); this.field.value = t.slice(0, at); }
    this.suggestions = [];
    drafts.add(a, this.model.agent);
    drafts.focus = null;
    this.focus();
  }

  #popup() {
    const commands = this.#commands(), box = this.popup;
    box.replaceChildren();
    box.hidden = !commands.length && !this.suggestions.length;
    if (commands.length) {
      box.className = 'composer-popup commands';
      commands.forEach(([id, title, detail, symbol], i) => {
        const b = el('button', 'composer-option' + (i === this.selected ? ' on' : ''));
        b.type = 'button';
        b.append(el('span', 'accent', icon(symbol, 13)), el('span', 'stack', el('span', 'title', title), el('span', 'detail', detail)), el('span', 'spacer'), el('code', null, id));
        b.addEventListener('mousedown', (e) => { e.preventDefault(); this.#execute(id); });
        box.append(b);
      });
    } else {
      box.className = 'composer-popup';
      this.suggestions.forEach((a, i) => {
        const b = el('button', 'composer-option compact' + (i === this.selected ? ' on' : ''));
        b.type = 'button';
        const name = a.kind === 'agent' || a.kind === 'conversation' ? a.name : base(a.path);
        b.append(el('span', 'accent', icon(attachmentSymbol(a), 11)), el('span', 'title', name));
        if (a.kind === 'file' || a.kind === 'folder') b.append(el('span', 'dir', dir(a.path)));
        b.append(el('span', 'spacer'));
        if (i === this.selected) b.append(el('span', 'muted2', '⇥'));
        b.addEventListener('mousedown', (e) => { e.preventDefault(); this.#pick(a); });
        box.append(b);
      });
    }
  }

  // ---------- attachments ----------

  #attachKey() {
    const b = tap('paperclip', L('Add a file, folder, or image'), () => menu(b, [
      { label: L('Image'), icon: 'photo', run: () => {
        const input = el('input');
        input.type = 'file'; input.accept = 'image/png,image/jpeg,image/gif,image/webp'; input.multiple = true;
        input.addEventListener('change', () => { for (const f of input.files) this.#upload(f); });
        input.click();
      } },
      { label: L('Add files'), icon: 'doc.on.doc', run: () => { drafts.set(this.model.agent, (this.text && !/\s$/.test(this.text) ? this.text + ' ' : this.text) + '@'); this.field.value = this.text; this.#suggest(); this.focus(); } },
    ]));
    return b;
  }

  async #upload(file) {
    if (!file) return;
    const a = await this.model.upload(file);
    if (a) drafts.add(a, this.model.agent);
  }

  // ---------- mode, permission, model ----------

  #chip(text, symbol, help, items, { danger = false } = {}) {
    const b = el('button', 'composer-chip' + (danger ? ' danger' : ''));
    b.type = 'button';
    if (symbol) b.append(icon(symbol, 11));
    if (text) b.append(el('span', null, text));
    b.append(icon('chevron.down', 8, 2));
    if (help) tooltip(b, help);
    b.disabled = this.locked;
    b.addEventListener('click', (e) => { e.stopPropagation(); menu(b, items()); });
    return b;
  }

  #modeChip() {
    const mode = this.mode, names = { agent: L('Agent'), ask: L('Ask'), plan: 'Plan' }, symbols = { agent: 'bolt', ask: 'bubble.left', plan: 'list.bullet.clipboard' };
    const help = mode === 'plan' ? L("Plan · doesn't change files · ⇧⇥") : mode === 'ask' ? L('Ask · read-only · ⇧⇥') : L('Agent · applies changes · ⇧⇥');
    return this.#chip(names[mode], symbols[mode], help, () => ['agent', 'ask', 'plan'].map((n) => ({ label: names[n], checked: n === mode, icon: symbols[n], run: () => this.model.setMode(n) })));
  }

  #permissionChip() {
    const a = this.agent, modes = a?.permissions ?? [];
    if (this.mode !== 'agent' || !modes.length) return null;
    const current = a.permission ?? 'auto', narrow = (this.root.clientWidth || 600) < 340;
    return this.#chip(narrow ? '' : permissionTitle(current), permissionSymbol(current), L('Permissions: %@', permissionHint(current)),
      () => modes.map((n) => ({ label: `${permissionTitle(n)} · ${permissionHint(n)}`, checked: n === current, icon: permissionSymbol(n), run: () => this.model.setPermission(n) })),
      { danger: current === 'bypassPermissions' });
  }

  #modelChip() {
    const s = this.store, a = this.agent, backend = a?.backend ?? '';
    const name = s.models.find((x) => x.id === a?.model)?.display_name ?? a?.model ?? '';
    const w = this.root.clientWidth || 600, limit = w < 320 ? 9 : w < 460 ? 14 : 24;
    const label = (name.length > limit ? name.slice(0, limit - 1) + '…' : name) + (a?.effort ? ' · ' + effortName(a.effort) : '');
    const choice = (id) => {
      const info = s.models.find((x) => x.id === id), shown = info?.display_name ?? id, current = id === a?.model;
      if (info?.efforts?.length) {
        return { label: shown + (current && a.effort ? ' · ' + effortName(a.effort) : ''), checked: current, items: [
          { label: L('Default'), checked: current && !a.effort, run: () => this.#pickModel(id, null) }, null,
          ...info.efforts.map((l) => ({ label: effortName(l), checked: current && a.effort === l, run: () => this.#pickModel(id, l) })),
        ] };
      }
      return { label: shown, checked: current, run: () => this.#pickModel(id, null) };
    };
    const chip = this.#chip(label, null, L('Model: %@', a?.model ?? ''), () => {
      const own = s.models.filter((x) => x.owned_by === backend).map((x) => choice(x.id));
      const others = s.backends.filter((b) => b !== backend && (b !== 'fake' || backend === 'fake'));
      return [...own, ...(others.length ? [null] : []), ...others.map((b) => ({ label: backendLabel(b), items: s.models.filter((x) => x.owned_by === b).map((x) => choice(x.id)) }))];
    });
    chip.classList.add('model');
    return chip;
  }

  /** the same model: only its thinking changes; another one: model and level go together */
  async #pickModel(id, effort) {
    const a = this.agent;
    if (id === a?.model) return this.store.setEffort(this.model.agent, effort);
    const levels = this.store.models.find((x) => x.id === id)?.efforts ?? [];
    const change = { model: id };
    if (levels.length) change.effort = effort ?? '';
    try { await this.store.updateAgent(this.model.agent, change); } catch (e) { this.model.fail(e); }
  }
}

export const permissionTitle = (m) => ({ default: L('Manual'), acceptEdits: L('Accept edits'), bypassPermissions: L('Bypass') }[m] ?? L('Auto'));
export const permissionHint = (m) => ({ default: L('Asks before every change'), acceptEdits: L('Edits files, asks about the rest'), bypassPermissions: L('Does everything without asking') }[m] ?? L('The agent decides what is safe'));
export const permissionSymbol = (m) => ({ default: 'hand.raised', acceptEdits: 'pencil', bypassPermissions: 'exclamationmark.shield' }[m] ?? 'wand.and.stars');

/** how full the agent's context is: a small ring and the percentage; amber from 80%, red from 95% */
function contextGauge(c) {
  const f = c.window > 0 ? Math.min(1, Math.max(0, c.used / c.window)) : 0;
  const color = f >= 0.95 ? 'var(--err)' : f >= 0.8 ? 'var(--warn)' : 'var(--accent)';
  const tokens = (n) => (n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace('.0', '') + 'M' : n >= 1000 ? Math.round(n / 1000) + 'K' : String(n));
  const box = el('span', 'gauge');
  box.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5" fill="none" stroke="var(--line)" stroke-width="2"/><circle cx="6" cy="6" r="5" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" pathLength="100" stroke-dasharray="${Math.max(2, f * 100)} 100" transform="rotate(-90 6 6)"/></svg>`;
  const n = el('span', null, `${Math.round(f * 100)}%`);
  if (f >= 0.8) n.style.color = color;
  box.append(n);
  box.title = L('Context: %@ of %@ tokens', tokens(c.used), tokens(c.window));
  return box;
}

/** chips for attachments: a click previews, × removes */
export function chipRow(items, { remove, open, imageUrl } = {}) {
  const row = el('div', 'chips');
  for (const a of items) {
    const chip = el('span', 'chip');
    const label = btn('tap', null, () => {
      if (open && ['file', 'selection'].includes(a.kind)) open(a);
    }, a.path ?? a.name ?? '');
    if (a.kind === 'image' && a.path && imageUrl) {
      const img = el('img');
      img.alt = '';
      img.src = imageUrl ? imageUrl(a.path) : '';
      img.onerror = () => img.replaceWith(icon('photo', 10));
      label.append(img);
    } else label.append(el('span', 'accent', icon(attachmentSymbol(a), 10)));
    label.append(el('span', null, attachmentLabel(a)));
    chip.append(label);
    if (remove) {
      const x = btn('tap chip-x', icon('xmark', 8, 2.2), () => remove(a), L('Remove from context'));
      x.setAttribute('aria-label', L('Remove %@ attachment', attachmentLabel(a)));
      chip.append(x);
    }
    row.append(chip);
  }
  return row;
}

/** live progress of a turn: done/total, a bar per step, the step under way */
function taskList(tasks, { live, paused = false }) {
  const completed = tasks.filter((t) => t.status === 'completed').length;
  const cancelled = tasks.filter((t) => t.status === 'cancelled').length;
  const blocked = tasks.filter((t) => t.status === 'blocked').length;
  const active = tasks.filter((t) => t.status === 'in_progress');
  const summary = active[0] ?? tasks.find((t) => t.status === 'blocked') ?? tasks.find((t) => t.status === 'pending');
  const title = live ? L('Tasks') : completed === tasks.length ? L('Done') : cancelled === tasks.length ? L('Cancelled') : L('Incomplete');
  const box = el('div', 'tasks');
  let expanded = false;
  const draw = () => {
    const head = el('button', 'tasks-head');
    head.type = 'button';
    const done = completed === tasks.length;
    const mark = el('span', null, icon(done ? 'checkmark.circle' : 'checklist', 12));
    mark.style.color = done ? 'var(--ok)' : 'var(--accent)';
    head.append(mark, el('span', null, title), el('span', 'muted', `${completed}/${tasks.length}`));
    if (cancelled) head.append(el('span', 'muted2', L('%d cancelled', cancelled)));
    if (blocked) head.append(el('span', 'warn', L('%d blocked', blocked)));
    if (paused) {
      const p = el('span', 'muted', icon('pause.circle', 11));
      p.title = L('Waiting for a reply');
      head.append(p);
    } else if (active.length > 1) head.append(el('span', 'muted', L('%d active', active.length)));
    head.append(el('span', 'spacer'), el('span', 'muted2', icon(expanded ? 'chevron.up' : 'chevron.down', 10)));
    head.title = expanded ? L('Collapse tasks') : L('Show tasks');
    head.addEventListener('click', () => { expanded = !expanded; draw(); });
    const bars = el('div', 'tasks-bars', ...tasks.map((t) => { const b = el('i'); b.style.background = taskColor(t.status, true); return b; }));
    box.replaceChildren(head, bars);
    if (expanded) box.append(el('div', 'tasks-rows' + (live ? ' live' : ''), ...tasks.map((t) => taskRow(t, paused))));
    else if (live && summary) box.append(taskRow(summary, paused, true));
  };
  draw();
  return box;
}
function taskColor(s, bar) { return s === 'completed' ? 'var(--ok)' : s === 'in_progress' ? 'var(--accent)' : s === 'blocked' ? 'var(--warn)' : bar ? 'var(--line)' : 'var(--muted2)'; }
function taskRow(t, paused, clamp = false) {
  const sym = t.status === 'completed' ? 'checkmark.circle.fill' : t.status === 'in_progress' ? (paused ? 'pause.circle' : 'arrow.trianglehead.2.clockwise.rotate.90') : t.status === 'blocked' ? 'exclamationmark.circle' : t.status === 'cancelled' ? 'minus.circle' : 'circle';
  const mark = el('span', 'task-mark', icon(sym, 11));
  mark.style.color = taskColor(t.status, false);
  const text = el('span', 'task-text selectable' + (clamp ? ' clamp' : ''), t.status === 'in_progress' ? (t.activeForm ?? t.content) : t.content);
  if (t.status === 'cancelled') text.classList.add('struck');
  const row = el('div', 'task-row', mark, text);
  row.title = t.content;
  return row;
}

/** the tools a turn ran, as plain muted lines; a chevron after the words opens the details */
function activityView(activities) {
  const failed = activities.filter((a) => a.status === 'error').length;
  const active = [...activities].reverse().find((a) => a.status === 'running');
  const box = el('div', 'activity');
  let expanded = false;
  const draw = () => {
    const head = el('button', 'activity-head');
    head.type = 'button';
    head.title = L('Activity details');
    if (active) { head.append(el('span', null, active.label)); if (active.detail) head.append(el('span', 'detail', active.detail)); }
    else {
      if (failed) { const w = el('span', null, icon('exclamationmark.triangle', 11)); w.style.color = 'var(--err)'; head.append(w); }
      head.append(el('span', null, failed ? `${count(activities.length, '1 operation', '%d operations')} · ${count(failed, '1 error', '%d errors')}` : count(activities.length, '1 operation', '%d operations')));
    }
    const chev = el('span', 'chev', icon('chevron.right', 9, 2));
    if (expanded) chev.classList.add('open');
    head.append(chev);
    head.addEventListener('click', () => { expanded = !expanded; draw(); });
    box.replaceChildren(head);
    if (expanded) {
      for (const a of activities) {
        const line = el('div', 'activity-item');
        const top = el('div', 'activity-label');
        if (a.status === 'error') { const w = el('span', null, icon('exclamationmark.triangle', 10)); w.style.color = 'var(--err)'; top.append(w); }
        top.append(el('span', null, a.label));
        if (a.status === 'running') top.append(icon('ellipsis', 10));
        line.append(top);
        if (a.detail) line.append(el('div', 'activity-detail selectable', a.detail));
        box.append(line);
      }
    }
  };
  draw();
  return box;
}

/** a quiet living indicator while work is in progress: three breathing dots and the seconds */
function working() {
  const box = el('div', 'chat-working', el('span', 'dots', el('i'), el('i'), el('i')));
  const label = el('span', null, L('Working…'));
  box.append(label);
  const since = Date.now();
  const t = setInterval(() => {
    if (!box.isConnected) return clearInterval(t);
    const s = Math.floor((Date.now() - since) / 1000);
    label.textContent = s > 0 ? L('Working… %ds', s) : L('Working…');
  }, 1000);
  box.setAttribute('aria-label', L('Agent is working'));
  return box;
}

/** pending requests next to the composer: edit, remove, drag to reorder */
function queueView(m) {
  const box = el('div', 'queue');
  const head = el('div', 'queue-head', icon('text.line.first.and.arrowtriangle.forward', 10), el('span', null, L('%d queued', m.queue.length)), el('span', 'spacer'));
  if (m.queueBusy) head.append(el('span', 'accent', icon('ellipsis', 10)));
  box.append(head);
  const rows = el('div', 'queue-rows' + (m.queue.length > 3 ? ' scroll' : ''));
  for (const msg of m.queue) {
    const row = el('div', 'queue-row');
    row.draggable = true;
    row.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/taksim-queue', msg.id));
    row.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/taksim-queue')) e.preventDefault(); });
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const id = e.dataTransfer.getData('text/taksim-queue'), ids = m.queue.map((x) => x.id);
      const from = ids.indexOf(id), to = ids.indexOf(msg.id);
      if (id === msg.id || from < 0 || to < 0 || m.queueBusy) return;
      ids.splice(from, 1);
      ids.splice(to, 0, id);
      m.changeQueue({ order: ids });
    });
    const text = el('div', 'queue-text', msg.text || L('Attachment'));
    const edit = () => {
      const f = el('textarea', 'queue-edit');
      f.value = msg.text;
      f.rows = Math.min(5, Math.max(1, msg.text.split('\n').length));
      const save = () => { if (f.value.trim() || msg.attachments.length) m.changeQueue({ id: msg.id, text: f.value }); };
      f.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); } if (e.key === 'Escape') text.replaceWith(text); });
      text.replaceChildren(f);
      f.focus();
      editKey.replaceChildren(icon('checkmark', 11));
      editKey.onclick = (e) => { e.stopPropagation(); save(); };
    };
    text.addEventListener('dblclick', edit);
    const body = el('div', 'queue-body', text);
    if (msg.attachments?.length) body.append(chipRow(msg.attachments, { imageUrl: (p) => `${m.path}/attachments?path=${encodeURIComponent(p)}` }));
    const editKey = tap('pencil', L('Edit'), edit, 11);
    row.append(el('span', 'queue-grip', icon('line.3.horizontal', 10)), body, editKey, tap('xmark', L('Remove from queue'), () => m.changeQueue({ id: msg.id }, true), 11));
    rows.append(row);
  }
  box.append(rows);
  return box;
}

/** the work an orchestrator handed out: each part, who has it, how far it is; a row leads to its agent */
function jobCard(job, m, app) {
  const done = job.parts.filter((p) => p.status === 'done').length;
  const state = { proposed: L('Waiting for you'), running: L('Working'), done: L('Done'), stopped: L('Stopped'), 'timed out': L('Timed out') }[job.status] ?? L('Incomplete');
  const box = el('div', 'job');
  const st = el('span', null, state);
  st.style.color = job.status === 'done' ? 'var(--ok)' : ['running', 'proposed'].includes(job.status) ? 'var(--muted)' : 'var(--warn)';
  const head = el('div', 'job-head', el('span', 'accent', icon('point.3.connected.trianglepath.dotted', 12)), el('b', null, job.title), el('span', 'muted', `${done}/${job.parts.length}`), el('span', 'spacer'), st);
  if (job.status === 'running') { const s = tap(m.stopping ? 'ellipsis' : 'stop.fill', L('Stop'), () => m.stop(), 11); s.disabled = m.stopping; head.append(s); }
  else if (['stopped', 'partial', 'timed out'].includes(job.status)) head.append(tap('play.fill', L('Resume where it left off'), () => m.resumeJob(), 11));
  box.append(head, el('div', 'tasks-bars', ...job.parts.map((p) => { const b = el('i'); b.style.background = partColor(p.status, true); return b; })));
  const row = (sym, tint, title, trailing, { struck = false, writes = false, mono = false, help, agent }) => {
    const b = el('button', 'job-row');
    b.type = 'button';
    const mark = el('span', 'task-mark', icon(sym, 11));
    mark.style.color = tint;
    const t = el('span', 'job-title' + (mono ? ' mono' : '') + (struck ? ' struck' : ''), title);
    b.append(mark, t);
    if (writes) { const w = el('span', 'muted2', icon('pencil', 9)); w.title = L('Changes files'); b.append(w); }
    b.append(el('span', 'spacer'), el('span', 'muted2 job-trailing', trailing));
    b.title = help;
    b.disabled = !agent;
    if (agent) b.addEventListener('click', () => app.revealAgent(agent));
    return b;
  };
  for (const p of job.parts) {
    box.append(row({ done: 'checkmark.circle.fill', running: 'arrow.trianglehead.2.clockwise.rotate.90', failed: 'exclamationmark.circle', skipped: 'minus.circle', cancelled: 'minus.circle', stopped: 'stop.circle' }[p.status] ?? 'circle',
      partColor(p.status, false), p.title, p.model ?? '', { struck: ['skipped', 'cancelled'].includes(p.status), writes: !!p.writes, help: p.error ?? p.agentName ?? p.title, agent: p.agentId }));
  }
  for (const c of job.checks ?? []) {
    box.append(row(c.status === 'passed' ? 'checkmark.circle.fill' : c.status === 'running' ? 'arrow.trianglehead.2.clockwise.rotate.90' : c.status === 'pending' ? 'circle' : 'xmark.circle.fill',
      c.status === 'passed' ? 'var(--ok)' : c.status === 'running' ? 'var(--accent)' : c.status === 'pending' ? 'var(--muted2)' : 'var(--err)', c.command, '', { mono: true, help: c.output ?? c.command }));
  }
  if (job.review) {
    const r = job.review;
    box.append(row(r.status === 'ok' ? 'checkmark.seal.fill' : r.status === 'running' ? 'arrow.trianglehead.2.clockwise.rotate.90' : r.status === 'problems' ? 'exclamationmark.triangle.fill' : 'minus.circle',
      r.status === 'ok' ? 'var(--ok)' : r.status === 'running' ? 'var(--accent)' : r.status === 'problems' ? 'var(--warn)' : 'var(--muted2)', L('Review'), r.model ?? '', { help: r.findings ?? L('Review'), agent: r.agentId }));
  }
  if (job.warning === 'light-lead' && ['proposed', 'running'].includes(job.status)) {
    const w = el('div', 'job-warning', icon('exclamationmark.triangle', 10), L('Light model leading'));
    w.title = L('This agent runs on a light model; a stronger one plans and checks better.');
    box.append(w);
  }
  return box;
}
function partColor(s, bar) { return s === 'done' ? 'var(--ok)' : s === 'running' ? 'var(--accent)' : s === 'failed' ? 'var(--err)' : bar ? 'var(--line)' : 'var(--muted2)'; }

/** what the agent asks: numbered choices and a line of one's own; Continue once each question has an answer */
class QuestionCard {
  answers = {};
  constructor(model) {
    this.model = model;
    this.root = el('div', 'question');
    this.root.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey && this.complete()) { e.preventDefault(); this.submit(); }
      const q = this.question?.questions;
      if (q?.length === 1 && /^[1-9]$/.test(e.key) && e.target.tagName !== 'TEXTAREA') {
        const o = q[0].options[Number(e.key) - 1];
        if (o != null) { this.answers[q[0].id] = o; this.draw(); }
      }
    });
  }
  update(question) {
    if (this.question?.id !== question.id) this.answers = {};
    this.question = question;
    this.draw();
  }
  has(q) { return !!(this.answers[q.id] ?? '').trim(); }
  complete() { return this.question.questions.every((q) => this.has(q)); }
  submit() { this.model.changeWorkflow({ action: 'answer', id: this.question.id, answers: this.answers }); }
  draw() {
    const q = this.question, m = this.model, answered = q.questions.filter((x) => this.has(x)).length;
    const head = el('div', 'question-head', el('span', 'accent', icon('questionmark.bubble', 12)), el('span', 'muted', q.questions.length > 1 ? `${answered}/${q.questions.length}` : L('Question')), el('span', 'spacer'));
    const stop = tap(m.stopping ? 'ellipsis' : 'stop.fill', L('Stop'), () => m.stop(), 11);
    stop.disabled = m.stopping;
    head.append(stop);
    const fields = el('div', 'question-fields');
    for (const item of q.questions) {
      const block = el('div', 'question-item', el('div', 'question-title selectable', item.title));
      item.options.forEach((o, n) => {
        const b = el('button', 'question-option' + (this.answers[item.id] === o ? ' on' : ''));
        b.type = 'button';
        b.append(el('span', 'num', String(n + 1)), el('span', 'words', o));
        b.addEventListener('click', () => { this.answers[item.id] = o; this.draw(); });
        block.append(b);
      });
      const typed = !item.options.includes(this.answers[item.id] ?? '') && this.has(item);
      const other = el('label', 'question-option other' + (typed ? ' on' : ''));
      const f = el('textarea');
      f.rows = 1;
      f.placeholder = L('Your reply');
      f.value = typed || !this.has(item) ? this.answers[item.id] ?? '' : '';
      f.addEventListener('input', () => {
        this.answers[item.id] = f.value;
        f.style.height = '0px'; f.style.height = Math.min(80, f.scrollHeight) + 'px';
        other.classList.toggle('on', !!f.value.trim());
        block.querySelectorAll('.question-option:not(.other)').forEach((x) => x.classList.remove('on'));
        cont.disabled = !this.complete() || m.workflowBusy;
        cont.classList.toggle('ready', this.complete());
      });
      other.append(el('span', 'num', icon('pencil', 10)), f);
      block.append(other);
      fields.append(block);
    }
    const cont = el('button', 'question-continue' + (this.complete() ? ' ready' : ''));
    cont.type = 'button';
    cont.append(m.workflowBusy ? L('Sending…') : L('Continue'), icon('return', 10));
    cont.disabled = !this.complete() || m.workflowBusy;
    cont.addEventListener('click', () => this.submit());
    this.root.replaceChildren(head, fields, el('div', 'question-foot', el('span', 'spacer'), cont));
  }
}
