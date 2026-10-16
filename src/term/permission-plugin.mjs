// opencode's side of the node permission modes: a plugin taksim adds to a run (OPENCODE_CONFIG_CONTENT "plugin")
// when the node runs in Manual or Accept edits. Before each tool call it decides as permission-hook.mjs does, and a
// call the person doesn't allow is thrown back to the model.
import { normalize } from "./permission-adapters.mjs";
import { decide, askTaksim } from "./permission-hook.mjs";

export const TaksimPermissions = async () => ({
  "tool.execute.before": async (input, output) => {
    const call = normalize(input?.tool, output?.args);
    if (decide(call, process.env.TAKSIM_PERMISSION) === "allow") return;
    const answer = await askTaksim(process.env.TAKSIM_PERMISSION_URL, call);
    if (answer.behavior !== "allow") throw new Error(answer.message || "the user declined");
  },
});
