// ── TriMMC Agent Loop (Thin Shell) ──
// CTO-008-C Phase C2: Delegates to @tricompany/agent-core shared agent loop.
// TriMMC-specific modules (context-builder, prompt-cache, tool-gater) are wired
// via AgentLoopDeps factory and injected into agent-core's agentLoop.
//
// All while-loop logic, error recovery cascade, tool dispatch, permission gating,
// and streaming now live in agent-core. TriMMC is just the DI layer + re-exports.
//
// Preserved TriMMC-specific types (AgentLoopOptions, AgentEvent with TriMMC
// ContextSources) for backward compatibility with all existing callers.

import {
  agentLoop as coreAgentLoop,
  type AgentEvent as CoreAgentEvent,
  type AgentLoopDeps,
} from '@tricompany/agent-core';
import { type Message, type UsageSummary } from 'trimodel';
import { type AgentTier } from './permissions.js';
import { buildContext, mergeContextWithPrompt, type ContextSources } from '../context-builder/context-builder.js';
import { checkToolPermission, type ToolSpec } from '../tool-gater/gater.js';
import {
  createCacheState,
  updateCacheState,
  buildCacheMetrics,
  getCacheControlConfig,
} from '../prompt-cache/index.js';
import { PermissionEngine } from './permissions-engine/index.js';
import type { PermissionMode, PermissionRule } from './permissions-engine/types.js';

// ── Agent Loop Options (TriMMC-specific, preserves ContextSources) ──

export interface AgentLoopOptions {
  model?: string;
  fallbackModel?: string;
  maxTurns?: number;
  systemPrompt?: string;
  messages?: Message[];
  cwd?: string;
  context?: ContextSources;
  tier?: AgentTier;
  toolSpecs?: ToolSpec[];
  permissionMode?: PermissionMode;
  permissionRules?: PermissionRule[];
  permissionEngine?: PermissionEngine;
  signal?: AbortSignal;
}

// ── Agent Event (re-export from agent-core for backward compatibility) ──

export type AgentEvent = CoreAgentEvent;

// ── TriMMC Deps Factory ──
// Wires TriMMC service modules into agent-core's AgentLoopDeps contract.
// ContextSources type differs between TriMMC and agent-core but is
// compatible at runtime (index-signature interfaces).

function createTriMMCDeps(): AgentLoopDeps {
  return {
    buildContext: (sources) => buildContext(sources as ContextSources),
    mergeContextWithPrompt: (contextBlock, systemPrompt) =>
      mergeContextWithPrompt(contextBlock, systemPrompt),
    // Cache types diverge between TriMMC and agent-core (different field names)
    // but are compatible at runtime — explicit boundary casts via unknown.
    createCacheState: createCacheState as unknown as AgentLoopDeps['createCacheState'],
    updateCacheState: updateCacheState as unknown as AgentLoopDeps['updateCacheState'],
    buildCacheMetrics: buildCacheMetrics as unknown as AgentLoopDeps['buildCacheMetrics'],
    getCacheControlConfig: (model) => getCacheControlConfig(model) as unknown as Record<string, unknown> | undefined,
    checkToolPermission: checkToolPermission as AgentLoopDeps['checkToolPermission'],
  };
}

// ── TriMMC agentLoop (thin shell → agent-core) ──

export async function* agentLoop(options: AgentLoopOptions): AsyncGenerator<AgentEvent> {
  // Wire TriMMC deps into agent-core's agentLoop. All while-loop logic
  // (streaming, error recovery, tool dispatch, permission gating) is
  // handled by agent-core. TriMMC only provides the DI layer.
  yield* coreAgentLoop({
    model: options.model,
    fallbackModel: options.fallbackModel,
    maxTurns: options.maxTurns,
    systemPrompt: options.systemPrompt,
    messages: options.messages,
    cwd: options.cwd,
    context: options.context as Record<string, unknown> | undefined,
    tier: options.tier,
    // TriMMC ToolSpec / PermissionEngine types diverge from agent-core (field naming)
    // but are runtime-compatible. Boundary casts at the DI layer.
    toolSpecs: options.toolSpecs as any,
    permissionMode: options.permissionMode as any,
    permissionRules: options.permissionRules as any,
    permissionEngine: options.permissionEngine as any,
    signal: options.signal,
    deps: createTriMMCDeps(),
  });
}

// ── Run agent loop to completion (non-streaming convenience) ──

export async function runAgentLoop(options: AgentLoopOptions): Promise<{
  events: AgentEvent[];
  finalMessage: string | null;
  usageSummary: UsageSummary | undefined;
}> {
  const events: AgentEvent[] = [];
  let finalMessage: string | null = null;
  let usageSummary: UsageSummary | undefined;

  for await (const event of agentLoop(options)) {
    events.push(event);
    if (event.type === 'assistant_message' && event.content) {
      finalMessage = event.content;
    }
    if (event.type === 'loop_end' && 'usageSummary' in event) {
      usageSummary = event.usageSummary;
    }
  }

  return { events, finalMessage, usageSummary };
}
