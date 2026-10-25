// What happens on the canvas while you look elsewhere (AgentNotifier.swift): a notification when an agent finishes
// a turn, fails, or has a panel waiting for approval (only while the window is in the background), and the number
// of working agents in the window title (the Dock badge's place in a browser). Permission is asked the first time
// there is something to say.
function on(key) { try { return JSON.parse(localStorage.getItem(`taksim.notify.${key}`)) ?? true; } catch { return true; } }

export class Notifier {
  constructor(app) {
    this.app = app;
    this.store = app.store;
    this.store.listen((type, d) => this.#handle(type, d));
    this.store.watch(() => {
      const n = this.store.currentAgents.filter((a) => a.status === 'running').length;
      const title = n ? `(${n}) taksim` : 'taksim';
      if (document.title !== title) document.title = title;
    });
  }

  #handle(type, d) {
    const a = d.id ? this.store.agents.get(d.id) : null;
    if (!a) return;
    if (type === 'turn_done') this.#notify(a, (d.text ?? '').slice(0, 180), 'done');
    if (type === 'turn_failed') this.#notify(a, '⚠︎ ' + (d.error ?? '').slice(0, 160), 'failed');
    if (type === 'panel_updated' && d.panel?.status === 'pending') this.#notify(a, '⏸ ' + (d.panel?.spec?.title ?? 'Panel'), 'approval');
  }

  async #notify(a, body, kind) {
    if (document.hasFocus() || !on(kind) || typeof Notification === 'undefined') return;
    if (Notification.permission === 'default') { try { await Notification.requestPermission(); } catch {} }
    if (Notification.permission !== 'granted') return;
    const canvas = this.store.currentId;
    const n = new Notification(a.name, { body: body.trim(), tag: `${a.id}-${kind}`, silent: kind === 'done' || !on('sound') });
    // a click brings its agent into view
    n.onclick = async () => {
      window.focus();
      if (canvas && canvas !== this.store.currentId) await this.store.open(canvas);
      this.app.revealAgent(a.id);
      n.close();
    };
  }
}
