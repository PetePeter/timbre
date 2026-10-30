/** Built-in Claude Code tools users may explicitly enable for a phone agent. */
export const CLAUDE_CODE_EXTRA_TOOLS = ['Bash', 'Write', 'Edit', 'WebFetch'] as const;

export type ClaudeCodeExtraTool = typeof CLAUDE_CODE_EXTRA_TOOLS[number];

/** Accept only exact names from the curated list and return them in stable order. */
export function normalizeClaudeCodeExtraTools(value: unknown): ClaudeCodeExtraTool[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<string>(CLAUDE_CODE_EXTRA_TOOLS);
  const selected = new Set(value.filter((item): item is ClaudeCodeExtraTool =>
    typeof item === 'string' && allowed.has(item)));
  return CLAUDE_CODE_EXTRA_TOOLS.filter((tool) => selected.has(tool));
}
