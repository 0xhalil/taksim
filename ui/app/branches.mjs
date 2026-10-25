// The canvas's branches, at the right of the tab strip (BranchControl.swift, TaksimKit/BranchSets.swift): the set
// the canvas is on, or the branch all its repos share. Its menu switches the whole canvas to another set in one
// step, keeps the current branches as a new set, and moves a single repo. Shown only when an agent works in a repo.
import { L } from './theme.mjs';
import { api } from './api.mjs';
import { icon } from './icons.mjs';
import { el, menu, editInPlace } from './ui.mjs';

export class BranchControl {
  state = null;
  error = null;
  switching = false;
  cache = new Map();

  constructor(app) {
    this.app = app;
    this.store = app.store;
    this.root = el('button', 'branch-key');
    this.root.type = 'button';
    this.root.setAttribute('aria-label', L('Branches'));
    this.root.hidden = true;
    this.root.addEventListener('click', () => this.#menu());
    // a new folder, a moved branch, another canvas: read again
    let folders = '';
    this.store.watch(() => {
      const id = this.store.currentId, f = JSON.stringify([id, this.store.currentAgents.map((a) => [a.folder?.path, a.folder?.branch])]);
      if (f === folders) return;
      if (id !== this.canvas) { this.canvas = id; this.state = this.cache.get(id) ?? null; this.error = null; this.render(); }
      folders = f;
      this.refresh();
    });
    this.store.listen((type) => { if (type === 'branches_changed') this.refresh(); });
  }

  get path() { return `${this.store.canvasPath()}`; }

  async refresh() {
    const id = this.store.currentId;
    if (!id) return;
    try {
      const s = await api.get(`/v1/canvases/${id}/branches`);
      if (this.store.currentId !== id) return;
      this.state = s;
      this.cache.set(id, s);
      this.render();
    } catch {}
  }

  /** what the control says: the set the canvas is on; else the branch every repo is on; else the icon alone */
  get title() {
    const s = this.state, active = s?.sets?.find((x) => x.id === s.active);
    if (active) return active.name;
    const all = new Set((s?.repos ?? []).map((r) => r.branch).filter(Boolean));
    return all.size === 1 ? [...all][0] : null;
  }

  render() {
    const s = this.state;
    this.root.hidden = !s?.repos?.length;
    this.app.tabs?.render();
    if (this.root.hidden) return;
    const mark = el('span', 'branch-mark', this.switching ? el('span', 'spin small') : icon('arrow.triangle.branch', 12));
    mark.style.color = this.error ? 'var(--err)' : s.active ? 'var(--accent)' : 'var(--muted)';
    const parts = [mark];
    if (this.title) parts.push(el('span', 'branch-title', this.title));
    if (s.repos.some((r) => r.dirty)) { const d = el('i', 'branch-dirty'); d.title = L('Uncommitted changes'); parts.push(d); }
    this.root.replaceChildren(...parts);
    this.root.title = this.error ?? s.repos.map((r) => `${r.name}  ${r.branch ?? '—'}`).join('\n');
  }

  async #switch(body) {
    const id = this.store.currentId;
    this.error = null;
    this.switching = true;
    this.render();
    try {
      const s = await api.post(`/v1/canvases/${id}/branches`, body);
      if (this.store.currentId === id) this.state = s;
      this.cache.set(id, s);
    } catch (e) { if (this.store.currentId === id) this.error = e.message; }
    this.switching = false;
    this.render();
  }

  #menu() {
    const s = this.state, id = this.store.currentId, items = [];
    if (!s) return;
    const lines = (set) => s.repos.filter((r) => set.branches[r.dir]).map((r) => `${r.name} ${set.branches[r.dir]}`).join(' · ');
    if (this.error) items.push({ label: this.error, disabled: true }, null);
    for (const set of s.sets) items.push({ label: set.name, key: lines(set), checked: set.id === s.active, disabled: set.id === s.active || this.switching, run: () => this.#switch({ set: set.id }) });
    if (!s.active) {
      items.push({ label: L('Current branches'), icon: 'plus', run: async () => {
        // the system names it; the name arrives selected, ready to type over
        const set = await api.post(`/v1/canvases/${id}/branch-sets`, {}).catch(() => null);
        await this.refresh();
        if (set) this.#rename(set);
      } });
    }
    items.push(null);
    for (const r of s.repos) {
      items.push({ label: r.name, key: (r.branch ?? '—') + (r.dirty ? '  ●' : ''), items: (r.branches ?? []).map((b) => ({ label: b, checked: b === r.branch, disabled: b === r.branch || this.switching, run: () => this.#switch({ branches: { [r.dir]: b } }) })) });
    }
    if (s.sets.length) {
      items.push(null, { label: L('Sets'), items: s.sets.map((set) => ({ label: set.name, items: [
        { label: L('Rename'), run: () => this.#rename(set) },
        { label: L('Take current branches'), disabled: set.id === s.active, run: async () => {
          const now = Object.fromEntries(s.repos.filter((r) => r.branch).map((r) => [r.dir, r.branch]));
          await api.patch(`/v1/canvases/${id}/branch-sets/${set.id}`, { branches: now }).catch((e) => this.store.fail(e));
          this.refresh();
        } },
        null,
        { label: L('Delete'), danger: true, run: async () => { s.sets = s.sets.filter((x) => x.id !== set.id); this.render(); await api.delete(`/v1/canvases/${id}/branch-sets/${set.id}`).catch(() => {}); this.refresh(); } },
      ] })) });
    }
    menu(this.root, items);
  }

  #rename(set) {
    const r = this.root.getBoundingClientRect();
    editInPlace({ x: Math.max(8, r.right - 200), y: r.bottom + 4, width: 200, height: 26 }, set.name, async (name) => {
      await api.patch(`/v1/canvases/${this.store.currentId}/branch-sets/${set.id}`, { name }).catch((e) => this.store.fail(e));
      this.refresh();
    }, { fontSize: 12.5 });
  }
}
