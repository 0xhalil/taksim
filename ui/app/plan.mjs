// A plan beside the chat it belongs to (ChatPlanDock.swift), docked to the node like its IDE: one document read
// top to bottom, any part selectable; letting go of a selection brings up "Add to chat" at the pointer. It opens by
// itself when the agent proposes a plan and from the plan's card; the one action is the card's.
import { L } from './theme.mjs';
import { icon } from './icons.mjs';
import { el, btn } from './ui.mjs';
import { markdown } from './chat/markdown.mjs';
import { drafts } from './chat/model.mjs';

function stored(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
const MIN = [320, 240];

export class PlanDocks {
  docks = new Map();   // agent id -> { root, model, live }
  size_ = stored('taksim.planSize', null);

  constructor(app) {
    this.app = app;
    this.store = app.store;
    this.graph = app.graph;
  }

  #model(id) { return this.app.bodyLayer?.chat(id); }

  /** its room beside the node while it is open */
  size(a) {
    const m = this.#model(a.id);
    if (!m?.planShown || !m.plan) return null;
    return this.docks.get(a.id)?.live ?? this.size_ ?? [440, Math.max(420, this.graph.size(a)[1] + 30)];
  }

  layout() {
    const g = this.graph, keep = new Set();
    for (const a of g.agents) {
      const m = this.#model(a.id), size = this.size(a);
      if (!size) continue;
      keep.add(a.id);
      let d = this.docks.get(a.id);
      if (!d) {
        d = { model: m, root: el('div', 'plan-dock'), live: null };
        d.root.dataset.agent = a.id;
        this.app.bodies.append(d.root);
        d.unwatch = m.watch(() => this.#draw(a.id));
        this.docks.set(a.id, d);
        this.#draw(a.id);
      }
      d.root.hidden = !g.terminalsShown || g.scale < 0.3 || !!a.collapsed;
      if (d.root.hidden) continue;
      const x = this.app.docks.dockX(a, [(b) => this.app.panels?.size(b) ?? null, (b) => this.app.docks.ideSize(b)]);
      const p = g.toScreen({ x, y: g.rectOf(a).y });
      Object.assign(d.root.style, { width: size[0] + 'px', height: size[1] + 'px', transform: `translate(${p.x}px, ${p.y}px) scale(${g.scale})`, zIndex: 900 });
    }
    for (const [id, d] of this.docks) if (!keep.has(id)) { d.unwatch?.(); d.root.remove(); this.docks.delete(id); }
  }

  #draw(id) {
    const d = this.docks.get(id), m = d?.model, plan = m?.plan;
    if (!d || !plan) return;
    const a = this.store.agents.get(id), running = ['running', 'waiting'].includes(a?.status ?? '');
    const available = !running && !m.queue.length && !m.workflowBusy;
    if (d.version !== plan.version) { d.editing = false; d.version = plan.version; }
    const status = { running: L('Applying'), done: L('Done'), failed: L('Failed') }[plan.status] ?? L('Ready for review');
    const st = el('span', null, status);
    st.style.color = plan.status === 'done' ? 'var(--ok)' : plan.status === 'failed' ? 'var(--err)' : 'var(--muted)';
    const head = el('div', 'plan-head', el('span', 'accent', icon('list.bullet.clipboard', 12)), el('b', null, plan.title), el('span', 'muted2', `v${plan.version}`), el('span', 'spacer'), st,
      btn('tap', icon('xmark', 10, 2), () => { m.planShown = false; m.changed(); this.app.layoutBodies(); }, L('Close')));
    const body = el('div', 'plan-body');
    if (d.editing) {
      const t = el('textarea', 'plan-edit');
      t.value = d.draft;
      t.addEventListener('input', () => { d.draft = t.value; save.disabled = apply.disabled = !available || !d.draft.trim(); });
      t.addEventListener('keydown', (e) => e.stopPropagation());
      body.append(t);
      requestAnimationFrame(() => t.focus());
    } else {
      const doc = markdown(plan.content);
      doc.classList.add('plan-doc');
      body.append(doc);
      body.addEventListener('pointerup', (e) => setTimeout(() => this.#pill(d, body, e), 0));
    }
    const act = (action, p = plan) => m.changeWorkflow({ action, id: p.id, version: p.version });
    const applyKey = () => { const k = btn('chat-primary', null, null, L('Apply version %d of this plan in Agent mode', plan.version)); k.append(icon('play.fill', 11), L('Apply plan')); return k; };
    const foot = el('div', 'plan-foot');
    let save, apply;
    if (d.editing) {
      const cancel = btn('tap', null, () => { d.editing = false; this.#draw(id); });
      cancel.append(L('Cancel'));
      save = btn('tap', null, async () => { if (await this.#saveEdit(d, plan)) this.#draw(id); });
      save.append(icon('checkmark', 11, 2), L('Save'));
      apply = applyKey();
      apply.title = L('Save these changes and apply the plan');
      apply.addEventListener('click', async () => { if (await this.#saveEdit(d, plan) && m.plan) { act('build', m.plan); drafts.ask(id); } });
      save.disabled = apply.disabled = !available || !d.draft.trim();
      foot.append(cancel, el('span', 'spacer'), save, apply);
    } else {
      foot.append(el('span', 'spacer'));
      const keep = btn('tap', icon('square.and.arrow.down', 12), () => act('save'), L('Save to project and open'));
      keep.disabled = !available;
      foot.append(keep);
      if (plan.status === 'draft') {
        const edit = btn('tap', icon('pencil', 12), () => { d.draft = plan.content; d.editing = true; this.#draw(id); }, L('Edit plan'));
        edit.disabled = !available;
        const go = applyKey();
        go.addEventListener('click', () => { act('build'); drafts.ask(id); });
        go.disabled = !available;
        foot.append(edit, go);
      } else if (plan.status !== 'running') {
        const replan = btn('tap', null, () => act('revise'));
        replan.append(icon('arrow.clockwise', 11), L('Replan'));
        replan.disabled = !available;
        foot.append(replan);
      }
    }
    const corner = el('div', 'dock-corner');
    corner.addEventListener('pointerdown', (e) => this.#resize(e, id, corner));
    d.root.replaceChildren(head, body, foot, corner);
  }

  /** the edit becomes the plan's next version (nothing is sent when nothing changed) */
  async #saveEdit(d, plan) {
    if (d.draft === plan.content) { d.editing = false; return true; }
    if (!(await d.model.changeWorkflow({ id: plan.id, version: d.version, content: d.draft }, { edit: true }))) return false;
    d.editing = false;
    return true;
  }

  /** a selection let go: "Add to chat" beside the pointer quotes it at the end of the draft */
  #pill(d, body, e) {
    body.querySelector('.quote-pill')?.remove();
    const sel = window.getSelection(), text = sel?.toString().trim();
    if (!text || !body.contains(sel.anchorNode)) return;
    const pill = btn('quote-pill', null, () => {
      const quoted = text.split('\n').map((l) => '> ' + l).join('\n'), id = d.root.dataset.agent, cur = drafts.text[id] ?? '';
      drafts.set(id, (cur ? cur.replace(/\n+$/, '') + '\n\n' : '') + quoted + '\n\n');
      sel.removeAllRanges();
      pill.remove();
      drafts.ask(id);
    });
    pill.append(icon('list.bullet', 11, 2), L('Add to chat'));
    const r = body.getBoundingClientRect(), k = this.graph.scale;
    pill.style.left = Math.min((e.clientX - r.left) / k + 6, body.clientWidth - 130) + 'px';
    pill.style.top = (e.clientY - r.top) / k + body.scrollTop + 6 + 'px';
    body.append(pill);
  }

  #resize(e, id, corner) {
    e.preventDefault();
    e.stopPropagation();
    corner.setPointerCapture(e.pointerId);
    const a = this.store.agents.get(id), start = { x: e.clientX, y: e.clientY, size: this.size(a) }, d = this.docks.get(id);
    const move = (ev) => {
      const k = Math.max(0.1, this.graph.scale);
      d.live = [Math.max(MIN[0], start.size[0] + (ev.clientX - start.x) / k), Math.max(MIN[1], start.size[1] + (ev.clientY - start.y) / k)];
      this.graph.kick();
      this.app.layoutBodies();
    };
    corner.addEventListener('pointermove', move);
    corner.addEventListener('pointerup', () => {
      corner.removeEventListener('pointermove', move);
      if (d.live) { this.size_ = d.live.map(Math.round); d.live = null; try { localStorage.setItem('taksim.planSize', JSON.stringify(this.size_)); } catch {} }
      this.app.layoutBodies();
    }, { once: true });
  }
}
