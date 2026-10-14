// Reviewable plans and clarification requests belong to the chat, never the CLI's private transcript.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, renameSync, existsSync, readFileSync } from 'node:fs';
import { HOME } from './store.mjs';
import { inside, recheck } from '../ide/fs.mjs';
import { httpError } from '../http.mjs';

export class ChatWorkflow {
  constructor(agent) { this.agent = agent; this.pending = null; }
  emit() {
    const a = this.agent;
    a.canvas.bus.emit('chat_workflow', { id: a.id, plan: a.chatPlan || null, question: this.pending?.view || null });
    a.canvas.save();
  }
  idle() {
    const a = this.agent;
    if (a.current || a.queue.length || a.terminal) throw httpError(409, 'finish the current turn first');
  }
  publish({ title, content }, user = false) {
    const a = this.agent;
    if (a.chatMode !== 'plan') throw httpError(409, 'switch to Plan mode first');
    if (user) this.idle();
    if (typeof content !== 'string' || !content.trim() || content.length > 100000) throw httpError(400, 'plan content: 1–100000 characters');
    const previous = a.chatPlan;
    a.chatPlan = { id: a.chatPlan?.status === 'draft' ? a.chatPlan.id : randomUUID(),
      version: (a.chatPlan?.version || 0) + 1, title: String(title || 'Plan').trim().slice(0, 120) || 'Plan',
      content: content.trim(), status: 'draft', updatedAt: Date.now() };
    try { this.persistPlan(); } catch (e) { a.chatPlan = previous; throw e; }
    this.emit(); return a.chatPlan;
  }
  check(id, version) {
    const plan = this.agent.chatPlan;
    if (!plan || plan.id !== id || plan.version !== version) throw httpError(409, 'plan changed; reload it');
    return plan;
  }
  edit({ id, version, content, title }) {
    this.idle(); const plan = this.check(id, version);
    if (plan.status !== 'draft') throw httpError(409, 'only draft plans can be edited');
    return this.publish({ content, title: title ?? plan.title }, true);
  }
  persistPlan() {
    const a = this.agent, plan = a.chatPlan;
    const folder = join(HOME, 'plans', a.canvas.id, a.id);
    mkdirSync(folder, { recursive: true });
    const path = join(folder, `${plan.id}-v${plan.version}.md`);
    writeFileSync(path + '.tmp', plan.content + '\n'); renameSync(path + '.tmp', path);
  }
  save({ id, version }) {
    this.idle(); const plan = this.check(id, version), a = this.agent;
    const relative = `.taksim/plans/${plan.id}-v${plan.version}.md`;
    const target = inside(a.workDir(), relative);
    mkdirSync(join(target, '..'), { recursive: true });
    // the CLI shares this folder: re-resolve after mkdir, a symlink may have moved
    const cur = recheck(a.workDir(), target, relative);
    if (existsSync(cur)) {
      if (readFileSync(cur, 'utf8') !== plan.content + '\n') throw httpError(409, 'saved plan was edited in the workspace');
    } else writeFileSync(cur, plan.content + '\n', { flag: 'wx' });
    return { path: relative };
  }
  build({ id, version }) {
    this.idle(); const plan = this.check(id, version), a = this.agent;
    if (plan.status !== 'draft') throw httpError(409, 'this plan has already been started');
    a.canvas.updateAgent(a, { chatMode: 'agent' });
    plan.status = 'running'; this.emit();
    const prompt = `Implement this user-reviewed plan exactly. Investigate the named files, follow the steps, run appropriate validation and report the result. If reality contradicts the plan, ask the user rather than silently changing its scope.\n\n<approved_plan id="${plan.id}" version="${plan.version}">\n${plan.content}\n</approved_plan>`;
    a.enqueue({ kind: 'user', text: prompt, plan: { id, version } }).catch(() => {});
    return plan;
  }
  revise({ id, version }) {
    this.idle(); const plan = this.check(id, version);
    if (plan.status === 'running') throw httpError(409, 'plan is still running');
    this.agent.canvas.updateAgent(this.agent, { chatMode: 'plan' });
    return this.publish({ title: plan.title, content: plan.content }, true);
  }
  completed(item, success) {
    const plan = this.agent.chatPlan;
    if (item.plan && plan?.id === item.plan.id && plan.version === item.plan.version) {
      plan.status = success ? 'done' : 'failed'; this.emit();
    }
  }
  // `detached.signal`: a question that belongs to no turn (the engine asks about orchestrated work). It waits for
  // its place when another question is open and ends with that signal instead of with a turn.
  async ask({ questions }, detached = null) {
    const a = this.agent;
    if (detached) {
      while (this.pending && !detached.signal.aborted) await new Promise((r) => setTimeout(r, 200));
      if (a.terminal) throw httpError(409, 'the question needs the chat; this node shows its terminal');
    } else {
      if (!a.current || a.terminal) throw httpError(409, 'clarifications need an active chat turn');
      if (this.pending) throw httpError(409, 'a question is already waiting');
    }
    if (!Array.isArray(questions) || !questions.length || questions.length > 3) throw httpError(400, 'ask one to three questions');
    const view = { id: randomUUID(), questions: questions.map((q, i) => {
      if (typeof q.title !== 'string' || !q.title.trim() || q.title.length > 1000) throw httpError(400, 'question title is required');
      if (q.options !== undefined && (!Array.isArray(q.options) || q.options.length > 5 || !q.options.every((v) => typeof v === 'string' && v.trim() && v.length <= 300))) throw httpError(400, 'invalid question options');
      return { id: `q${i + 1}`, title: q.title.trim(), options: q.options || [] };
    }) };
    const signal = detached ? detached.signal : a.current.ac.signal;
    if (signal.aborted) throw httpError(409, 'turn was stopped');
    return new Promise((resolve, reject) => {
      const abort = () => { this.pending = null; this.emit(); if (!a.current && a.status === 'waiting') a.setStatus('idle'); reject(new Error('question cancelled')); };
      signal.addEventListener('abort', abort, { once: true });
      this.pending = { view, resolve: (answers) => { signal.removeEventListener('abort', abort); resolve(answers); } };
      if (!detached || !a.current) a.setStatus('waiting');
      this.emit();
    });
  }
  answer({ id, answers }) {
    const pending = this.pending, a = this.agent;
    if (!pending || pending.view.id !== id) throw httpError(409, 'question is no longer waiting');
    if (!answers || !pending.view.questions.every((q) => typeof answers[q.id] === 'string' && answers[q.id].trim() && answers[q.id].length <= 4000)) throw httpError(400, 'answer each question');
    const text = pending.view.questions.map((q) => `${q.title}\n${answers[q.id].trim()}`).join('\n\n');
    a.record({ from: 'user', to: a.id, kind: 'clarification', text });
    this.pending = null; this.emit(); a.setStatus(a.current ? 'running' : 'idle'); pending.resolve(text);
  }
}
