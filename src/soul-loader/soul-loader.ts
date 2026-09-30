// ── TriMMC Soul Loader ──
// CTO-005: Converts AgentContract (six-element Schema v1) into structured system prompts.
// Feeds into Context Builder's pipeline: contract → prompt → ContextSources → agentLoop.
//
// The "soul" is the agent's identity + behavioral contract — what it is, what it does,
// what it can decide, who it works with, and how it should behave.

import type { AgentContract } from '../contracts/agent-contract.js';
import type { ContextSources } from '../context-builder/context-builder.js';
import type { AgentTier } from '../agent-loop/permissions.js';

// ── Section Builders ──

function buildIdentitySection(contract: AgentContract): string {
  const lines: string[] = [
    '## Identity',
    `- **Name**: ${contract.identity.display_name}`,
    `- **Role**: ${contract.identity.role}`,
    `- **Family**: ${contract.identity.family}`,
  ];
  if (contract.identity.user_invocable) {
    lines.push('- **Invocation**: user-invocable (can be directly dispatched)');
  } else {
    lines.push('- **Invocation**: NOT user-invocable (only dispatchable by supervisor)');
  }
  lines.push(`- **Description**: ${contract.identity.description}`);
  return lines.join('\n');
}

function buildResponsibilitiesSection(contract: AgentContract): string {
  if (!contract.responsibilities || contract.responsibilities.length === 0) return '';

  const lines: string[] = ['## Responsibilities'];
  for (const resp of contract.responsibilities) {
    const priorityTag = resp.priority ? ` [${resp.priority.toUpperCase()}]` : '';
    lines.push(`- ${resp.description}${priorityTag}`);
  }
  return lines.join('\n');
}

function buildDecisionRightsSection(contract: AgentContract): string {
  const dr = contract.decision_rights;
  const lines: string[] = ['## Decision Rights'];
  if (dr.approve.length > 0) {
    lines.push(`- **Approve**: ${dr.approve.join(', ')}`);
  }
  if (dr.freeze && dr.freeze.length > 0) {
    lines.push(`- **Freeze**: ${dr.freeze.join(', ')}`);
  }
  if (dr.escalate.length > 0) {
    lines.push(`- **Escalate**: ${dr.escalate.join(', ')}`);
  }
  if (dr.forbidden.length > 0) {
    lines.push(`- **Forbidden**: ${dr.forbidden.join(', ')}`);
  }
  return lines.join('\n');
}

function buildCollaboratorsSection(contract: AgentContract): string {
  const lines: string[] = ['## Collaborators'];
  lines.push(`- **Reports to**: ${contract.collaborators.reports_to}`);
  if (contract.collaborators.peers.length > 0) {
    lines.push(`- **Peers**: ${contract.collaborators.peers.join(', ')}`);
  }
  if (contract.collaborators.supervises.length > 0) {
    lines.push(`- **Supervises**: ${contract.collaborators.supervises.join(', ')}`);
  }
  return lines.join('\n');
}

function buildInstructionsSection(contract: AgentContract): string {
  if (!contract.instructions || contract.instructions.trim().length === 0) return '';
  return ['## Behavioral Instructions', contract.instructions.trim()].join('\n');
}

function buildToolsSection(contract: AgentContract): string {
  if (!contract.tools || contract.tools.length === 0) return '';

  const lines: string[] = ['## Authorized Tools'];
  for (const tool of contract.tools) {
    const approvalTag = tool.requires_approval ? ' ⚠️ requires approval' : '';
    const riskTag = tool.risk_level !== 'low' ? ` [${tool.risk_level} risk]` : '';
    lines.push(`- **${tool.name}**${riskTag}${approvalTag}`);
  }
  return lines.join('\n');
}

// ── Public API ──

/**
 * Convert an AgentContract into a structured Markdown system prompt block.
 * Sections are ordered: Identity → Responsibilities → Decision Rights → Collaborators → Instructions → Tools.
 * Only sections with content are included.
 *
 * @param contract A validated AgentContract (six-element Schema v1)
 * @returns Markdown string suitable for system prompt injection
 */
export function contractToPrompt(contract: AgentContract): string {
  const sections: string[] = [];

  sections.push(buildIdentitySection(contract));

  const resp = buildResponsibilitiesSection(contract);
  if (resp) sections.push(resp);

  sections.push(buildDecisionRightsSection(contract));
  sections.push(buildCollaboratorsSection(contract));

  const instr = buildInstructionsSection(contract);
  if (instr) sections.push(instr);

  const tools = buildToolsSection(contract);
  if (tools) sections.push(tools);

  return sections.join('\n\n');
}

/**
 * Convert an AgentContract into ContextSources ready for agentLoop injection.
 * The soul prompt becomes the role label (display_name) plus extra context (the full prompt).
 * This composes with Context Builder: role from the contract, tier capabilities, AGENTS.md, code-state.
 *
 * @param contract A validated AgentContract
 * @param tier The agent's permission tier
 * @returns ContextSources ready for AgentLoopOptions.context
 */
export function contractToContextSources(
  contract: AgentContract,
  tier: AgentTier,
): ContextSources {
  const prompt = contractToPrompt(contract);
  return {
    tier,
    role: contract.identity.display_name,
    extraContext: prompt.split('\n'),
  };
}
