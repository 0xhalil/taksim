// Core policy, independent of the CLI: restrictive access wins over a contradictory stored mode.
export const CHAT_MODES = ['agent', 'ask', 'plan'];
export function modeOf(agent) {
  if (agent?.sandbox === 'read-only') return agent.chatMode === 'plan' ? 'plan' : 'ask';
  return CHAT_MODES.includes(agent?.chatMode) ? agent.chatMode : 'agent';
}
export const readOnly = (agent) => modeOf(agent) !== 'agent';
