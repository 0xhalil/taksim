# Jev (TypeSafe's decision model)

Jev writes no text. Given a content and a question with fixed answers it returns a probability for each. In
taksim it is optional and off until a key is connected: **Settings › Connections › Jev (TypeSafe)**. The key
goes into the keychain like the other connections; without one nothing in taksim changes.

- **For the orchestrator (and any agent):** the MCP tool `decide` appears while Jev is connected. An agent passes
  `state`, a `question` and `options` (`{name: what it means}`) and gets the likeliest option, its confidence and every
  probability. Meant for quick judgments: a model tier for a part of the work, which agent should take a task, how
  risky a change looks. It is advice: a low confidence means decide yourself or ask the person, and it never replaces
  an approval.
- **Where it is not used:** panels (Jev is not a source), approvals (nothing is auto-approved by it).
- **Code:** `src/jev.mjs` (`ask`, `pick`, `yesNo`; five minutes of caching for identical questions, an eight second
  timeout, `null` when it can't answer), the `jev` entry in `src/connectors.mjs`, `decide` in `src/mcp/server.mjs`.
- **Endpoint:** `POST https://api.typesafe.ai/v1/systemone` with `{ model: "jev-latest", state, questions }`
  (`TAKSIM_JEV_BASE` / `TAKSIM_JEV_MODEL` override). Tests run against a local stand-in (`test/jev.test.mjs`).
- **Not verified against the live API:** the request and response shapes come from TypeSafe's public docs
  (docs.typesafe.ai); the key needs a TypeSafe account (early access).
