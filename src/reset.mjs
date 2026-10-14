// Back to a fresh install: every canvas (with its agents' transcripts), every named account (its login
// folder, its key), every connection's token, the usage numbers, the user's own tools. The CLIs' own logins
// on this computer are not taksim's and stay as they are.

import { rmSync } from "node:fs";
import { join } from "node:path";
import { HOME } from "./canvas/store.mjs";
import { allCanvases, removeCanvas } from "./canvas/canvas.mjs";
import { listAccounts, removeAccount, stopAllLogins } from "./accounts.mjs";
import { listConnections, disconnect } from "./connectors.mjs";
import { clearUsage } from "./usage.mjs";
import { clearLibrary } from "./toolbox/store.mjs";

export async function resetAll() {
  const done = { canvases: 0, accounts: 0, connections: 0 };
  for (const c of allCanvases()) { removeCanvas(c); done.canvases++; }
  stopAllLogins();
  for (const a of listAccounts()) { try { removeAccount(a.id); done.accounts++; } catch {} }
  for (const c of listConnections().filter((x) => x.connected)) { await disconnect(c.id).catch(() => {}); done.connections++; }
  clearUsage();
  clearLibrary();
  rmSync(join(HOME, "plans"), { recursive: true, force: true });
  return { ok: true, ...done };
}
