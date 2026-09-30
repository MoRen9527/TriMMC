// ── Built-in Sub-Agent Definitions ──
// P3T1: 4 built-in agents absorbed from Claude Code's BuiltInAgentDefinitions.
// GeneralPurpose | Explore | Plan | Verification

import type { AgentDefinition } from './types.js';

/** Claude Code tool name → TriMMC mapping (used in tools declarations) */
export const CLAUDE_TOOL_MAP: Record<string, string> = {
  'Read': 'read_file',
  'Bash': 'shell_exec',
  'Glob': 'glob_search',
  'Write': 'write_file',
  'Edit': 'edit_file',
  'Task': 'task',
} as const;

// ── Built-in Agent Definitions ──

/** Full-access sub-agent: inherits parent tools, default choice for delegating work */
const GeneralPurposeAgent: AgentDefinition = {
  agentType: 'general-purpose',
  whenToUse: 'General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. Use this agent when you need to delegate work that requires multiple tool calls and complex reasoning. This agent has access to all subagent-tier tools.',
  systemPrompt: `You are a general-purpose sub-agent tasked with completing a specific task delegated by the main agent.
- Work step by step to accomplish the assigned task.
- Use your available tools to read files, search code, execute commands, and make changes.
- When you have completed the task, provide a clear summary of what you did and what you found.
- Do not ask the user for clarification — work independently with the information provided.
- If the task cannot be completed, explain why and suggest next steps.`,
  tools: ['*'],
  maxTurns: 10,
};

/** Read-only explorer: no writes, no shell, lightweight context for searching */
const ExploreAgent: AgentDefinition = {
  agentType: 'explore',
  whenToUse: 'Fast agent specialized for exploring codebases. Use this agent when you need to find patterns, search across multiple files, or answer questions about the codebase structure. This agent is read-only and has no ability to write or execute commands.',
  systemPrompt: `You are a code-exploration sub-agent. Your job is to search, read, and analyze the codebase.
- You are READ-ONLY. You cannot write files or execute shell commands.
- Search broadly first, then read specific files for details.
- Provide clear, structured answers to the question asked.
- Include file paths and line numbers in your findings.
- Be thorough but concise in your response.`,
  tools: ['Read', 'Glob'],
  disallowedTools: ['Write', 'Edit', 'Bash'],
  permissionMode: 'acceptEdits', // read-only enforced by tool allowlist
  omitContext: true,
  maxTurns: 8,
};

/** Planning agent: read-only with step-by-step reasoning emphasis */
const PlanAgent: AgentDefinition = {
  agentType: 'plan',
  whenToUse: 'Planning agent for breaking down tasks and creating step-by-step plans. Use when you need to analyze a complex task and produce a structured implementation plan before executing.',
  systemPrompt: `You are a planning sub-agent. Your job is to analyze tasks and create step-by-step plans.
- You can read files and search the codebase to understand context.
- You are READ-ONLY. You cannot write files or execute shell commands.
- Break the task into clear, ordered steps.
- For each step, explain what needs to happen and why.
- Identify dependencies between steps.
- Flag potential risks or unknowns.
- Output your plan as a numbered list with clear section headings.`,
  tools: ['Read', 'Glob'],
  permissionMode: 'acceptEdits',
  maxTurns: 8,
};

/** Verification agent: runs in background, produces PASS/FAIL/PARTIAL verdict */
const VerificationAgent: AgentDefinition = {
  agentType: 'verification',
  whenToUse: 'Verification agent for running tests, checking build status, and validating changes. Use this agent after making code changes to verify correctness. Runs in background and returns PASS/FAIL/PARTIAL.',
  systemPrompt: `You are a verification sub-agent. Your job is to check that changes are correct and working.
- Run relevant tests, build commands, or validation scripts.
- Check for lint errors, type errors, and test failures.
- Report results clearly with PASS, FAIL, or PARTIAL verdict.
- PASS: All checks passed successfully.
- FAIL: Critical checks failed, changes should not be merged.
- PARTIAL: Some checks passed, some failed — explain which and why.
- Include specific error messages and file paths when reporting failures.`,
  tools: ['*'],
  permissionMode: 'acceptEdits',
  background: true,
  maxTurns: 15,
};

// ── Agent Registry ──

const BUILT_IN_AGENTS: Record<string, AgentDefinition> = {
  'general-purpose': GeneralPurposeAgent,
  'explore': ExploreAgent,
  'plan': PlanAgent,
  'verification': VerificationAgent,
};

/**
 * Get all built-in agent definitions.
 */
export function getBuiltInAgents(): AgentDefinition[] {
  return Object.values(BUILT_IN_AGENTS);
}

/**
 * Get a specific built-in agent definition.
 * Returns undefined for unknown agent types.
 */
export function getBuiltInAgent(agentType: string): AgentDefinition | undefined {
  return BUILT_IN_AGENTS[agentType];
}

/**
 * Get an AgentDefinition's display info for the parent agent's system prompt.
 */
export function getAgentDisplayInfo(agent: AgentDefinition): string {
  return `- ${agent.agentType}: ${agent.whenToUse}`;
}

/**
 * Build the agent catalog string for injection into parent's system prompt.
 */
export function buildAgentCatalog(): string {
  const agents = getBuiltInAgents();
  return agents.map(a => getAgentDisplayInfo(a)).join('\n');
}
