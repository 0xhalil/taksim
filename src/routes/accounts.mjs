// Accounts API: list, create, delete, check status, and run a CLI's login flow in a terminal.

import { readJson, sendJson, httpError } from "../http.mjs";
import { listAccounts, createAccount, removeAccount, renameAccount, accountStatus, startLogin, stopLogin, loginState, findAccount, carryOver, accountBackends, machineStatus, setApiKey }
  from "../accounts.mjs";
import { allCanvases } from "../canvas/canvas.mjs";
import { accountEnv } from "../accounts.mjs";
import { USAGE_BACKENDS, usageKey, refreshUsage, allUsage, onUsage } from "../usage.mjs";

// every canvas hears of new numbers: its agents' cards show their login's
onUsage((key, usage) => { for (const c of allCanvases()) c.bus.emit("usage_updated", { key, usage }); });

/** the logins whose usage can be read: this computer's own per CLI, and each named account with its own folder */
function usageLogins() {
  const installed = new Set(accountBackends().filter((b) => b.installed).map((b) => b.name));
  const machines = USAGE_BACKENDS.filter((b) => installed.has(b)).map((backend) => ({ key: `machine:${backend}`, backend, dir: null, env: {} }));
  const own = listAccounts().filter((a) => a.dir && USAGE_BACKENDS.includes(a.backend) && installed.has(a.backend))
    .map((a) => ({ key: usageKey(a), backend: a.backend, dir: a.dir, env: accountEnv(a) }));
  return [...machines, ...own];
}

// who each login is, so two logins of one CLI can be told apart: its name, the email it signed in with, its plan.
// This computer's own logins are read from their CLI now and then (a named account's status is kept already).
const machineSeen = new Map(); // backend -> { email, plan, at }
async function readMachine(backend) {
  const st = await machineStatus(backend).catch(() => null);
  if (st) machineSeen.set(backend, { email: st.email || null, plan: st.plan || null, loggedIn: st.loggedIn !== false, at: Date.now() });
}
function identities(keys) {
  const out = {};
  for (const key of keys) {
    if (key.startsWith("machine:")) {
      const backend = key.slice("machine:".length);
      const named = listAccounts().find((a) => a.backend === backend && !a.dir);
      const seen = machineSeen.get(backend) || named?.status;
      if (!machineSeen.has(backend) || Date.now() - machineSeen.get(backend).at > 10 * 60 * 1000) readMachine(backend);
      // this computer signed in as one of the named accounts: the same login (one plan, one set of limits)
      const twin = seen?.email && listAccounts().find((a) => a.backend === backend && a.dir && a.status?.email === seen.email);
      out[key] = { backend, name: named?.name || twin?.name || null, machine: true, email: seen?.email || null, plan: seen?.plan || null,
        ...(twin ? { same: twin.id } : {}) };
    } else {
      const a = listAccounts().find((x) => x.id === key);
      if (!a) continue;
      if (!a.status) accountStatus(a.id).catch(() => {});
      out[key] = { backend: a.backend, name: a.name, machine: false, email: a.status?.email || null, plan: a.status?.plan || null };
    }
  }
  return out;
}
// A CLI's own login is listed only as the account it is: once read, a signed-out or nameless one isn't an
// account, so its numbers stay out of the list (one that is a named account's login is merged by the app).
const usageBody = () => {
  const all = allUsage(), logins = identities(Object.keys(all)), usage = {};
  for (const [key, u] of Object.entries(all)) {
    const l = logins[key];
    if (key.startsWith("machine:")) {
      const backend = key.slice("machine:".length), seen = machineSeen.get(backend);
      if (seen && (seen.loggedIn === false || (!l?.email && !l?.name))) { delete logins[key]; continue; }
    }
    usage[key] = u;
  }
  return { usage, logins };
};

// GET /v1/usage: what is known; POST /v1/usage/refresh { force? }: read every login again (Claude: a short check)
export async function usageRoutes(req, res, path) {
  if (path === "/v1/usage" && req.method === "GET") return sendJson(res, 200, usageBody());
  if (path === "/v1/usage/refresh" && req.method === "POST") {
    const { force } = await readJson(req).catch(() => ({}));
    const logins = usageLogins();
    await Promise.all([
      ...logins.map((l) => refreshUsage({ ...l, force: !!force }).catch(() => null)),
      // this computer's logins: those usage can be read for, and any other one usage is known for
      ...[...new Set([...logins.filter((l) => !l.dir).map((l) => l.backend),
        ...Object.keys(allUsage()).filter((k) => k.startsWith("machine:")).map((k) => k.slice("machine:".length))])].map(readMachine),
      ...logins.filter((l) => l.dir).map((l) => accountStatus(l.key).catch(() => null)),
    ]);
    return sendJson(res, 200, usageBody());
  }
  return false;
}

export async function accountRoutes(req, res, path) {
  const machine = path.match(/^\/v1\/accounts\/machine\/([\w-]+)$/);
  if (machine && req.method === "GET") return sendJson(res, 200, await machineStatus(machine[1]));
  const m = path.match(/^\/v1\/accounts(?:\/([\w-]+))?(?:\/(status|login|carry-over|api-key))?$/);
  if (!m) return false;
  const [, id, action] = m;
  const method = req.method;

  if (!id) {
    if (method === "GET") return sendJson(res, 200, { accounts: listAccounts(), backends: accountBackends() });
    if (method === "POST") {
      const account = createAccount(await readJson(req).catch(() => { throw httpError(400, "invalid JSON"); }));
      accountStatus(account.id).catch(() => {});
      return sendJson(res, 201, account);
    }
    throw httpError(405, "method not allowed");
  }

  if (!findAccount(id)) throw httpError(404, `no account ${id}`);

  if (!action) {
    if (method === "PATCH") {
      const body = await readJson(req).catch(() => { throw httpError(400, "invalid JSON"); });
      const a = renameAccount(id, body?.name);
      for (const c of allCanvases()) for (const ag of c.agents.values()) if (ag.account === a.id) c.bus.emit("agent_updated", { agent: ag.view() });
      return sendJson(res, 200, a);
    }
    if (method !== "DELETE") throw httpError(405, "method not allowed");
    // agents that used it fall back to their CLI's machine login (their CLIs stop before the folder goes)
    const gone = findAccount(id);
    for (const c of allCanvases()) for (const a of c.agents.values()) {
      if (a.account === gone.id) c.updateAgent(a, { account: null });
    }
    removeAccount(id);
    return sendJson(res, 200, { ok: true });
  }

  if (action === "status" && method === "GET") return sendJson(res, 200, await accountStatus(id));
  if (action === "carry-over" && method === "POST") { carryOver(id); return sendJson(res, 200, { ok: true }); }
  if (action === "api-key" && method === "PUT") {
    const body = await readJson(req).catch(() => { throw httpError(400, "invalid JSON"); });
    const st = await setApiKey(id, body?.key);
    for (const c of allCanvases()) for (const ag of c.agents.values()) if (ag.account === id) c.bus.emit("agent_updated", { agent: ag.view() });
    return sendJson(res, 200, st);
  }
  if (action === "login") {
    if (method === "GET") return sendJson(res, 200, loginState(id));
    if (method === "POST") {
      const body = await readJson(req).catch(() => ({}));
      await startLogin(id, { private: body?.private === true });
      return sendJson(res, 200, loginState(id));
    }
    if (method === "DELETE") { stopLogin(id); return sendJson(res, 200, { ok: true }); }
  }
  throw httpError(405, "method not allowed");
}
