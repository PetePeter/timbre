/** Switchable groups of built-in Claude Code tools; a phone agent gets a whole group or none of it. */
export const CLAUDE_CODE_TOOL_CATEGORIES = [
  { id: 'read', label: 'Read files', tools: ['Read', 'Glob', 'Grep'] },
  { id: 'write', label: 'Write files', tools: ['Write', 'Edit', 'NotebookEdit'] },
  { id: 'shell', label: 'Run shell commands', tools: ['Bash'] },
  { id: 'web', label: 'Use the web', tools: ['WebFetch', 'WebSearch'] },
] as const;

/** Built-in Claude Code tools users may explicitly enable for a phone agent. */
export const CLAUDE_CODE_EXTRA_TOOLS = CLAUDE_CODE_TOOL_CATEGORIES.flatMap((category) => category.tools);

export type ClaudeCodeExtraTool = typeof CLAUDE_CODE_EXTRA_TOOLS[number];

/** Accept only known names, widen any touched category to the whole group, and return them in stable order. */
export function normalizeClaudeCodeExtraTools(value: unknown): ClaudeCodeExtraTool[] {
  if (!Array.isArray(value)) return [];
  const requested = new Set(value.filter((item): item is string => typeof item === 'string'));
  return CLAUDE_CODE_TOOL_CATEGORIES
    .filter((category) => category.tools.some((tool) => requested.has(tool)))
    .flatMap((category) => category.tools);
}
