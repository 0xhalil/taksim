// The exact Claude a run used. Claude Code takes aliases ("sonnet"); its stream says which model that was
// ("claude-sonnet-5-5"), so the picker can show "Sonnet 5.5" instead of an alias that hides the version.

const seen = new Map(); // alias -> "Sonnet 5.5"

// "claude-sonnet-5-5[1m]" -> ["sonnet", "Sonnet 5.5"]; null when it isn't a family-version id
export function prettyClaude(id) {
  const m = String(id || "").match(/^claude-(opus|sonnet|haiku|fable)-(\d+(?:-\d{1,2})?)(?:-\d{8})?(?:\[.*\])?$/);
  if (!m) return null;
  return [m[1], `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2].replace("-", ".")}`];
}

export function recordClaudeModel(id) {
  const p = prettyClaude(id);
  if (p) seen.set(p[0], p[1]);
}

export const claudeName = (alias) => seen.get(alias) || null;
