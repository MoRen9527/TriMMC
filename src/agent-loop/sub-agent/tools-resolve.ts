// ── Sub-Agent Tools Resolution ──
// P3T1: Maps Claude Code tool declarations to TriMMC tool names + applies agent filtering.
// Absorbed from Claude Code's resolveAgentTools / filterToolsForAgent.

import { getToolDefinitions } from '../tools.js';
import type { ToolDefinition } from 'trimodel';
import type { AgentDefinition } from './types.js';
import { CLAUDE_TOOL_MAP } from './built-in.js';

// ── Tools Resolution ──

/**
 * Resolve an agent definition's tool declarations into actual TriMMC ToolDefinitions.
 *
 * Claude Code tool names are mapped:
 *   Read → read_file, Bash → shell_exec, Glob → glob_search, Write → write_file, Edit → edit_file, Task → task
 *
 * Special syntax (stripped for Tier 1 — sub-command filtering is Tier 2+):
 *   Bash(git:*) → shell_exec (all Bash variants map to shell_exec in Tier 1)
 *   Bash(git diff:*) → shell_exec
 *
 * '*' in the tools array means all subagent-tier tools.
 *
 * @param agentDef - The agent definition with Claude Code tool declarations
 * @returns Resolved TriMMC ToolDefinition list
 */
export function resolveAgentTools(agentDef: AgentDefinition): ToolDefinition[] {
  // All tools available at subagent tier
  const subagentTools = getToolDefinitions('subagent');

  // '*' means all subagent-tier tools
  if (agentDef.tools.includes('*')) {
    // Apply disallowed tools filter
    if (agentDef.disallowedTools && agentDef.disallowedTools.length > 0) {
      const disallowedTriMMCNames = agentDef.disallowedTools
        .map(ccName => resolveClaudeToolName(ccName))
        .filter((n): n is string => n !== null);

      return subagentTools.filter(t => !disallowedTriMMCNames.includes(t.function.name));
    }
    return subagentTools;
  }

  // Resolve each Claude Code tool name to TriMMC name
  const resolvedNames = new Set<string>();
  for (const ccTool of agentDef.tools) {
    const triMCName = resolveClaudeToolName(ccTool);
    if (triMCName) {
      resolvedNames.add(triMCName);
    }
  }

  // Filter subagent tools to only those explicitly declared
  const filtered = subagentTools.filter(t => resolvedNames.has(t.function.name));

  // If nothing resolved (e.g., unknown tool names), return empty
  return filtered;
}

/**
 * Resolve a single Claude Code tool declaration to a TriMMC tool name.
 * Strips sub-command syntax like "Bash(git:*)" → "shell_exec".
 *
 * @param ccDeclaration - Claude Code tool declaration (e.g., "Read", "Bash(git:*)" )
 * @returns TriMMC tool name or null if unrecognized
 */
function resolveClaudeToolName(ccDeclaration: string): string | null {
  // Strip sub-command syntax: "Bash(git:*)" → "Bash"
  const baseName = ccDeclaration.replace(/\(.*\)$/, '').trim();

  // Direct mapping
  if (CLAUDE_TOOL_MAP[baseName]) {
    return CLAUDE_TOOL_MAP[baseName];
  }

  // Check if it's already a TriMMC name
  const triMCNames = ['read_file', 'write_file', 'edit_file', 'shell_exec', 'glob_search', 'task'];
  if (triMCNames.includes(baseName)) {
    return baseName;
  }

  // Case-insensitive fallback
  const lower = baseName.toLowerCase();
  for (const [cc, triMC] of Object.entries(CLAUDE_TOOL_MAP)) {
    if (cc.toLowerCase() === lower) return triMC;
  }
  if (triMCNames.includes(lower)) return lower;

  return null;
}

/**
 * Filter tools for a specific agent.
 * Applies disallowedTools from agent definition as an additional filter on top of resolution.
 *
 * @param tools - The resolved tools
 * @param agentDef - The agent definition (for disallowedTools check)
 * @returns Filtered ToolDefinition list
 */
export function filterToolsForAgent(
  tools: ToolDefinition[],
  agentDef: AgentDefinition,
): ToolDefinition[] {
  if (!agentDef.disallowedTools || agentDef.disallowedTools.length === 0) {
    return tools;
  }

  const disallowedTriMMCNames = agentDef.disallowedTools
    .map(ccName => resolveClaudeToolName(ccName))
    .filter((n): n is string => n !== null);

  if (disallowedTriMMCNames.length === 0) return tools;

  return tools.filter(t => !disallowedTriMMCNames.includes(t.function.name));
}

/**
 * Build a tool catalog description string for an agent's system prompt.
 * Describes what tools the agent has access to.
 */
export function buildToolCatalog(tools: ToolDefinition[]): string {
  if (tools.length === 0) return 'No tools available.';

  const names = tools.map(t => {
    const desc = t.function.description?.split('.')[0] ?? t.function.name;
    return `- ${t.function.name}: ${desc}`;
  });

  return `Available tools:\n${names.join('\n')}`;
}
