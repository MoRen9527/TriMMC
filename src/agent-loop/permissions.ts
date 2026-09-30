// ── TriMMC Tool Permission System ──
// CTO-008-C Phase C2: Re-exports from @tricompany/agent-core shared truth,
// plus TriMMC-specific additions (TIER_DESCRIPTIONS, backward-compatible helpers).
// agent-core uses a level-based permission model:
//   coordinator=0 < subagent=1 < main=2
//   Subagent = read-only by default (read_file, glob_search, list_directory, search_code).
//   This replaces TriMMC's old Set-based model.

import {
  type AgentTier,
  listTools,
  canUseTool,
} from '@tricompany/agent-core';

// ── Re-export from agent-core (shared truth) ──
export {
  type AgentTier,
  type PermissionResult,
  TOOL_TIER_ALLOWLIST,
  filterToolsForTier,
  getTierToolCounts,
  canUseTool,
} from '@tricompany/agent-core';

// agent-core's getTierSummary(tier) → string — alias to avoid conflict
export { getTierSummary as getTierSummaryForTier } from '@tricompany/agent-core';

// ── TriMMC-specific additions ──

/** Human-readable tier descriptions for debugging/logging/context-building. */
export const TIER_DESCRIPTIONS: Record<AgentTier, string> = {
  main: 'All tools available. Full access for the primary agent loop.',
  subagent: 'Restricted tool set. Read-only files and code search. No sub-agent spawning.',
  coordinator: 'Minimal tool set. Only task (spawn sub-agents). No file I/O or shell. Pure orchestrator mode.',
  heartbeat: 'Scheduled/background agent — read + write allowed, NO shell. REQ-20260805-006.',
};

/**
 * Get tool names available at a given tier.
 * Only returns registered tools that pass the canUseTool check
 * (including anti-recursion guard).
 */
export function getToolNamesForTier(tier: AgentTier): Set<string> {
  const tools = new Set<string>();
  for (const name of listTools()) {
    if (canUseTool(name, tier).allowed) {
      tools.add(name);
    }
  }
  return tools;
}

/**
 * Debug utility: count available tools per tier with tool names.
 * Backward-compatible with TriMMC's original getTierSummary() — no arguments,
 * returns tool name lists (used by context-builder for system prompt injection).
 */
export function getTierSummary(): Record<AgentTier, { count: number; tools: string[] }> {
  const tiers: AgentTier[] = ['main', 'subagent', 'coordinator'];
  const summary = {} as Record<AgentTier, { count: number; tools: string[] }>;

  for (const tier of tiers) {
    const names = [...getToolNamesForTier(tier)].sort();
    summary[tier] = { count: names.length, tools: names };
  }

  return summary;
}
