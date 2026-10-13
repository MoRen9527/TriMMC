// ── TriMMC Sub-Agent Types ──
// P3T1: Agent definition system absorbed from Claude Code Phase 3 Tier 1.
// Maps Claude Code sub-agent architecture to TriMMC agent loop.

import type { ToolDefinition, Message } from 'trimodel';
import type { PermissionMode } from '../permissions-engine/types.js';
import type { ProcessSupervisor } from '@tricompany/agent-core';

// ── Agent Identity ──

/** Built-in sub-agent types (Tier 1 — 4 agents from Claude Code catalog) */
export type AgentType = 'general-purpose' | 'explore' | 'plan' | 'verification';

// ── Agent Definition ──

/**
 * AgentDefinition defines a sub-agent's full configuration.
 * Absorbed from Claude Code's BaseAgentDefinition/BuiltInAgentDefinition.
 */
export interface AgentDefinition {
  /** Unique agent type identifier */
  agentType: AgentType;
  /** When to use this agent (displayed to parent agent) */
  whenToUse: string;
  /** System prompt for the sub-agent */
  systemPrompt: string;
  /**
   * Claude Code-compatible tool declarations.
   * Examples: "Read", "Bash(git:*)", "Glob", "Write", "Edit"
   * '*' = all tools available at subagent tier
   */
  tools: string[];
  /** Explicitly disallowed tools (overrides tools list) */
  disallowedTools?: string[];
  /** Permission mode override for this agent (undefined = inherit from parent) */
  permissionMode?: PermissionMode;
  /** Default max turns for this agent */
  maxTurns?: number;
  /** Whether this agent runs in background (only Verification in Tier 1) */
  background?: boolean;
  /** Whether to omit CLAUDE.md / project context (Explore agent) */
  omitContext?: boolean;
  /** Model override for this agent (undefined = inherit from parent) */
  model?: string;
}

// ── Spawn Configuration ──

/** Input configuration for spawning a sub-agent */
export interface AgentSpawnConfig {
  /** Agent type to spawn */
  agentType: AgentType;
  /** Task description for the sub-agent */
  prompt: string;
  /** Short description (3-5 words) for logging */
  description: string;
  /** Parent agent's permission mode (sub-agent inherits if no override) */
  parentPermissionMode?: PermissionMode;
  /** Parent agent's permission rules (sub-agent inherits) */
  parentPermissionRules?: import('../permissions-engine/types.js').PermissionRule[];
  /** Parent agent's working directory */
  cwd?: string;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
  /** Optional ProcessSupervisor for lifecycle management */
  supervisor?: ProcessSupervisor;
  /** Scope key passed to supervisor for scope-based cancellation */
  supervisorScopeKey?: string;
  /** Max turns override */
  maxTurns?: number;
  /** Model override */
  model?: string;
}

// ── Spawn Result ──

/** Result returned when a sub-agent completes */
export interface AgentSpawnResult {
  /** Unique agent instance ID (generated at spawn) */
  agentId: string;
  /** Agent type that was spawned */
  agentType: AgentType;
  /** Task description */
  description: string;
  /** Final content output from sub-agent */
  content: string | null;
  /** Number of tool calls made by sub-agent */
  toolCallsMade: number;
  /** Total number of turns executed */
  turnsExecuted: number;
  /** Error message if spawn failed */
  error?: string;
  /** Final finish reason */
  finishReason?: string;
}

// ── Sub-Agent Events ──

/** Events emitted during sub-agent execution */
export type SubAgentEvent =
  | { type: 'subagent_start'; agentId: string; agentType: AgentType; description: string }
  | { type: 'subagent_delta'; agentId: string; delta: string }
  | { type: 'subagent_tool_call'; agentId: string; toolName: string }
  | { type: 'subagent_tool_result'; agentId: string; toolName: string; isError?: boolean }
  | { type: 'subagent_done'; agentId: string; result: AgentSpawnResult }
  | { type: 'subagent_error'; agentId: string; error: string };
