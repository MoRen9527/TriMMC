// ── TriMMC Context Builder ──
// CTO-004: Assembles project context (AGENTS.md, registry, tier capabilities)
// into an injectable Markdown block for agent system prompts.
// Pattern absorbed from Claude Code prompt.ts (AgentTool system prompt builder)
// and the CLAUDE.md injection convention.

import { type AgentTier, TIER_DESCRIPTIONS, getTierSummary } from '../agent-loop/permissions.js';

/** Sources available for context assembly. All fields optional — only present sources are included. */
export interface ContextSources {
  /** Module AGENTS.md content (module role, strategy delegation, fact sources) */
  agentsMd?: string;
  /** Registry code-state.md summary (repository map, code health, change tracking) */
  codeState?: string;
  /** Current agent tier — determines capability description */
  tier: AgentTier;
  /** Agent role/identity label (e.g. "CTO", "Code Explorer", "Test Runner") */
  role?: string;
  /** Additional user-provided context lines */
  extraContext?: string[];
}

// ── Section Builders ──

function buildTierSection(tier: AgentTier): string {
  const summary = getTierSummary();
  const info = summary[tier];
  const desc = TIER_DESCRIPTIONS[tier];
  return [
    '## Agent Capabilities',
    `- **Tier**: \`${tier}\``,
    `- **Available Tools** (${info.count}): ${info.tools.join(', ')}`,
    `- ${desc}`,
  ].join('\n');
}

function buildRoleSection(role: string): string {
  return [
    '## Agent Role',
    `You are acting as: **${role}**.`,
    'Focus on your assigned responsibilities. Delegate outside your scope.',
  ].join('\n');
}

function buildAgentsMdSection(content: string): string {
  const trimmed = content.trim();
  return ['## Module Context (AGENTS.md)', trimmed].join('\n');
}

function buildCodeStateSection(content: string): string {
  const trimmed = content.trim();
  return ['## Code State', trimmed].join('\n');
}

function buildExtraSection(lines: string[]): string {
  return ['## Additional Context', ...lines].join('\n');
}

// ── Main API ──

/**
 * Build a context block for injection into an agent's system prompt.
 * Sections are ordered: Role → Tier → Module Context → Code State → Extra.
 * Only sections with provided sources are included.
 *
 * @returns A Markdown-formatted string ready for system prompt injection.
 *          Returns empty string if no sources beyond tier are provided and no meaningful output.
 */
export function buildContext(sources: ContextSources): string {
  const sections: string[] = [];

  if (sources.role) {
    sections.push(buildRoleSection(sources.role));
  }

  sections.push(buildTierSection(sources.tier));

  if (sources.agentsMd) {
    sections.push(buildAgentsMdSection(sources.agentsMd));
  }

  if (sources.codeState) {
    sections.push(buildCodeStateSection(sources.codeState));
  }

  if (sources.extraContext && sources.extraContext.length > 0) {
    sections.push(buildExtraSection(sources.extraContext));
  }

  return sections.join('\n\n');
}

/**
 * Merge user-provided systemPrompt with context injection.
 * Context block comes first (as a prefix), followed by the user's system prompt.
 * This matches the Claude Code pattern: system prompt prefix (cached) + user instructions.
 */
export function mergeContextWithPrompt(
  context: string,
  systemPrompt?: string,
): string {
  const parts: string[] = [];
  if (context) {
    parts.push(context);
  }
  if (systemPrompt) {
    parts.push(systemPrompt);
  }
  return parts.join('\n\n---\n\n');
}
