// WebSocket endpoint for terminals: /term/<canvasId>/<agentId>. A terminal is a shell on this machine,
// so on top of the Host check the Origin must be present and our own, and remote mode disables it.

import { WebSocketServer } from "ws";
import { cfg } from "../config.mjs";
import { getCanvas } from "../canvas/canvas.mjs";
import { loginTerminal } from "../accounts.mjs";

const wss = new WebSocketServer({ noServer: true });

function reject(socket, status, text) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
}

export function handleUpgrade(req, socket, head) {
  const path = new URL(req.url, "http://x").pathname;
  // /term/ide/<canvas>/<agent>/<session>: a terminal, run, debug or exec session of an agent's IDE
  const ide = path.match(/^\/term\/ide\/([\w-]+)\/([\w-]+)\/([\w-]+)$/);
  // /term/shell/<canvas>/<agent>: the plain shell of an agent's node
  const shell = path.match(/^\/term\/shell\/([\w-]+)\/([\w-]+)$/);
  const m = ide ? [null, "ide", null] : shell ? [null, "shell", null] : path.match(/^\/term\/([\w-]+)\/([\w-]+)$/);
  if (!m) return reject(socket, 404, "Not Found");
  if (cfg.allowRemote) return reject(socket, 403, "Forbidden");
  const hosts = ["127.0.0.1", "localhost", "[::1]"].map((h) => `${h}:${cfg.port}`);
  if (!hosts.includes(req.headers.host) || !hosts.some((h) => req.headers.origin === `http://${h}`)) {
    return reject(socket, 403, "Forbidden");
  }
  // /term/account/<id>: an account's login flow; /term/<canvas>/<agent>: an agent's TUI
  const terminal = shell ? getCanvas(shell[1])?.agents.get(shell[2])?.shell : ide ? getCanvas(ide[1])?.agents.get(ide[2])?.ide?.sessions.list.get(ide[3])?.term
    : m[1] === "account" ? loginTerminal(m[2]) : getCanvas(m[1])?.agents.get(m[2])?.terminal;
  if (!terminal) return reject(socket, 409, "Conflict");
  wss.handleUpgrade(req, socket, head, (ws) => terminal.attach(ws));
}
