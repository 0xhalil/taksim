// REST routes for an agent's IDE. Returns false when the path isn't an IDE route.
//   GET|POST|PATCH|DELETE /v1/canvases/:id/agents/:aid/ide      view · open {files, path, line, end_line} · state {tabs, active, ui} · close
//   GET  …/ide/tree?path=        a folder's entries          GET …/ide/files            every file (go to file)
//   GET|PUT|DELETE …/ide/file?path=   read · save {content, mtime} (409 when it changed on disk) · delete
//   POST …/ide/mkdir {path} · /move {from, to}   GET …/ide/search?q=&regex=&case=   GET …/ide/git[?path=] status · file at HEAD
//   DELETE …/ide/notes[?path=|?id=]
//   POST …/ide/commit {files, message, amend} · /push · /rollback {files}   GET …/ide/log · /show?hash= · /rev?rev=&path=
//   POST …/ide/commit-message {files}: one message for the change, written by the fast model
//   POST …/ide/edit {path, from, to, instruction}: ⌘K, the chosen lines rewritten (returned, not written)
//   POST …/ide/ask {question}: where in the project is it? an answer and file:line hits
//   POST …/ide/review {files}: what a model finds wrong in the uncommitted changes, set as notes
//   GET|POST …/ide/rules: the project's rule files (.taksimrules, .cursorrules, .cursor/rules) · create/get the file to open
//   GET|POST …/ide/sessions {kind: terminal|run|debug|exec, path, args} · DELETE …/ide/sessions/:sid · POST …/ide/sessions/:sid/stop
//   POST …/ide/sessions/:sid/debug {cmd: continue|next|step|return|pause|stop|frame|expand|evaluate, …}

import { readJson, sendJson, httpError } from "../http.mjs";
import { getCanvas } from "../canvas/canvas.mjs";
import { Ide } from "../ide/ide.mjs";
import * as fs from "../ide/fs.mjs";
import * as vcs from "../ide/vcs.mjs";
import { suggestMessage } from "../ide/commitmsg.mjs";
import { editSelection, askCodebase, reviewChanges } from "../ide/ai.mjs";
import { listRules, ensureRules } from "../ide/rules.mjs";

export async function ideRoutes(req, res, path) {
  const m = path.match(/^\/v1\/canvases\/([\w-]+)\/agents\/([\w-]+)\/ide(?:\/(tree|files|file|mkdir|move|search|git|notes|commit-message|edit|ask|review|rules|commit|push|rollback|log|show|rev|sessions)(?:\/([\w-]+)(?:\/(debug|stop))?)?)?$/);
  if (!m) return false;
  const canvas = getCanvas(m[1]);
  if (!canvas) throw httpError(404, `no canvas ${m[1]}`);
  const agent = canvas.agents.get(m[2]);
  if (!agent) throw httpError(404, `no agent ${m[2]}`);
  const method = req.method, q = new URL(req.url, "http://x").searchParams;
  const body = ["POST", "PUT", "PATCH"].includes(method) ? await readJson(req).catch(() => { throw httpError(400, "invalid JSON"); }) : null;
  const root = agent.workDir();
  const ok = (data) => sendJson(res, 200, data);
  const ide = () => { if (!agent.ide) throw httpError(404, "the IDE isn't open"); return agent.ide; };

  switch (m[3]) {
    case undefined:
      if (method === "GET") return ok(agent.ide?.view() || null);
      if (method === "POST") {
        const ide = agent.ide || new Ide(agent);
        const view = ide.open({ files: body?.files || [], path: body?.path, line: body?.line, endLine: body?.end_line });
        agent.ide = ide;
        return ok(view);
      }
      if (method === "PATCH") { if (!agent.ide) throw httpError(404, "the IDE isn't open"); agent.ide.setState(body); return ok(agent.ide.view()); }
      if (method === "DELETE") { agent.removeIde(); return ok({ ok: true }); }
      break;
    case "tree": if (method === "GET") return ok({ entries: fs.list(root, q.get("path") || "") }); break;
    case "files": if (method === "GET") return ok({ files: fs.allFiles(root) }); break;
    case "file": {
      const rel = q.get("path") || body?.path;
      if (!rel) throw httpError(400, "path is required");
      if (method === "GET") return ok(fs.read(root, rel));
      if (method === "PUT") {
        try { return ok(fs.write(root, rel, body?.content, body?.mtime)); }
        catch (e) { if (e.status === 409) return sendJson(res, 409, { error: { message: e.message }, mtime: e.mtime }); throw e; }
      }
      if (method === "DELETE") return ok(fs.remove(root, rel));
      break;
    }
    case "mkdir": if (method === "POST") return ok(fs.mkdir(root, String(body?.path || ""))); break;
    case "move": if (method === "POST") return ok(fs.move(root, String(body?.from || ""), String(body?.to || ""))); break;
    case "search":
      if (method === "GET") return ok({ results: await fs.search(root, { q: q.get("q") || "", regex: q.get("regex") === "1", caseSensitive: q.get("case") === "1" }) });
      break;
    case "git":
      if (method === "GET") return ok(q.get("path") ? { path: q.get("path"), content: await fs.gitHead(root, q.get("path")) } : await fs.gitStatus(root));
      break;
    case "commit": if (method === "POST") return ok(await vcs.commit(root, body || {})); break;
    case "commit-message": if (method === "POST") return ok(await suggestMessage(root, body || {})); break;
    case "edit": if (method === "POST") return ok(await editSelection(root, body || {})); break;
    case "ask": if (method === "POST") return ok(await askCodebase(root, body || {})); break;
    case "review":
      if (method === "POST") {
        const { findings, by } = await reviewChanges(root, body || {});
        const ide = agent.ide || new Ide(agent);
        ide.clearNotes({ source: "review" });
        const notes = [];
        for (const f of findings) { try { notes.push(ide.note({ ...f, source: "review" })); } catch { /* the file is gone */ } }
        agent.ide = ide;
        return ok({ notes, by });
      }
      break;
    case "rules":
      if (method === "GET") return ok({ rules: listRules(root).map(({ body, ...r }) => r) });
      if (method === "POST") return ok({ path: ensureRules(root) });
      break;
    case "push": if (method === "POST") return ok(await vcs.push(root)); break;
    case "rollback": if (method === "POST") return ok(await vcs.rollback(root, body?.files)); break;
    case "log": if (method === "GET") return ok({ commits: await vcs.log(root) }); break;
    case "show": if (method === "GET") return ok(await vcs.show(root, q.get("hash"))); break;
    case "rev": if (method === "GET") return ok({ content: await vcs.fileAt(root, q.get("rev") || "HEAD", q.get("path") || "") }); break;
    case "sessions": {
      const sessions = ide().sessions;
      if (!m[4]) {
        if (method === "GET") return ok({ sessions: sessions.views() });
        if (method === "POST") return ok(sessions.view(await sessions.start(body || {})));
        break;
      }
      if (!m[5] && method === "DELETE") { sessions.remove(m[4]); return ok({ ok: true }); }
      if (m[5] === "stop" && method === "POST") { sessions.stop(m[4]); return ok({ ok: true }); }
      if (m[5] === "debug" && method === "POST") {
        const s = sessions.get(m[4]);
        if (!s.debug) throw httpError(400, "not a debug session");
        const { cmd, ...args } = body || {};
        return ok(await s.debug.command(String(cmd || ""), args));
      }
      break;
    }
    case "notes":
      if (method === "DELETE") {
        if (!agent.ide) throw httpError(404, "the IDE isn't open");
        return ok({ removed: agent.ide.clearNotes({ path: q.get("path") || undefined, id: q.get("id") || undefined }) });
      }
      break;
  }
  throw httpError(405, "method not allowed");
}
