// ── TriMMC Prompt Cache Control ──
// Phase 2 Tier 1: Cache annotation infrastructure absorbed from Claude Code 2.1.88.
//
// DeepSeek uses automatic prefix caching — no Anthropic cache_control markers needed.
// This module tracks system prompt + tool stability to ensure cache consistency
// and provides observability. Future Anthropic provider will use explicit
// cache_control markers on content blocks via getCacheControlConfig().
//
// Claude Code sources:
//   vendor/claude-code/claude.ts: getCacheControl(), should1hCacheTTL(),
//     buildSystemPromptBlocks(), addCacheBreakpoints()
//   vendor/claude-code/promptCacheBreakDetection.ts: recordPromptState(),
//     checkResponseForCacheBreak()

import { createHash } from 'node:crypto';
import type { Message, ToolDefinition } from 'trimodel';

// ── Types ──

export interface CacheState {
  /** SHA256 hash of system prompt content (null if no system prompt) */
  systemPromptHash: string | null;
  /** SHA256 hash of canonical tool definitions (null if no tools) */
  toolsHash: string | null;
  /** Turn number when state was last updated */
  lastTurn: number;
  /** True if system prompt changed since previous update (false on first) */
  systemPromptChanged: boolean;
  /** True if tools changed since previous update (false on first) */
  toolsChanged: boolean;
  /** Previous turn's prompt_tokens for cache-hit estimation */
  prevPromptTokens: number | null;
}

export interface CacheMetrics {
  turn: number;
  promptTokens: number;
  /** Whether this turn likely hit provider-side prefix cache */
  estimatedCacheHit: boolean;
  /** Estimated tokens saved by caching (0 if no hit detected) */
  estimatedSavedTokens: number;
  /** True if system prompt or tools changed this turn (cache invalidated) */
  cacheInvalidated: boolean;
}

// ── Hash Utilities ──

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Compute SHA256 hash of the system prompt content (first system-role message). */
export function computeSystemPromptHash(messages: Message[]): string | null {
  const systemMsg = messages.find((m) => m.role === 'system');
  if (!systemMsg || systemMsg.content === null) return null;
  return sha256(systemMsg.content);
}

/** Compute SHA256 hash of serialized tool definitions (canonical key order). */
export function computeToolsHash(tools?: ToolDefinition[]): string | null {
  if (!tools || tools.length === 0) return null;
  // Canonical: sort keys within each tool definition for stable serialization
  const canonical = JSON.stringify(
    tools.map((t) => {
      const sorted: Record<string, unknown> = {};
      const keys = Object.keys(t).sort();
      for (const key of keys) {
        sorted[key] = (t as unknown as Record<string, unknown>)[key];
      }
      return sorted;
    }),
  );
  return sha256(canonical);
}

// ── State Management ──

/** Create a fresh CacheState (all fields null/zero/false). */
export function createCacheState(): CacheState {
  return {
    systemPromptHash: null,
    toolsHash: null,
    lastTurn: 0,
    systemPromptChanged: false,
    toolsChanged: false,
    prevPromptTokens: null,
  };
}

/**
 * Update cache state with current messages and tools.
 * Compares hashes to detect system prompt / tool changes.
 * On first call (no baseline), change flags remain false.
 */
export function updateCacheState(
  state: CacheState,
  messages: Message[],
  tools?: ToolDefinition[],
  turn?: number,
): void {
  const newSystemHash = computeSystemPromptHash(messages);
  const newToolsHash = computeToolsHash(tools);

  // Only report change when we have a previous baseline (skip first update)
  state.systemPromptChanged =
    state.systemPromptHash !== null && newSystemHash !== state.systemPromptHash;
  state.toolsChanged =
    state.toolsHash !== null && newToolsHash !== state.toolsHash;

  state.systemPromptHash = newSystemHash;
  state.toolsHash = newToolsHash;
  if (turn !== undefined) {
    state.lastTurn = turn;
  }
}

// ── Cache Hit Estimation ──

/**
 * Estimate whether this turn benefited from provider-side prefix caching.
 *
 * Heuristic (mirrors Claude Code break-detection OR condition, inverted):
 *   Cache hit if prompt_tokens dropped >= 5% OR >= 2000 tokens vs previous turn,
 *   AND system prompt + tools are unchanged.
 *
 * On first turn or after cache invalidation: always returns no-hit.
 */
export function estimateCacheHit(
  state: CacheState,
  promptTokens: number,
): { hit: boolean; savedTokens: number } {
  // If system prompt or tools changed between turns, cache was invalidated
  if (state.systemPromptChanged || state.toolsChanged) {
    state.prevPromptTokens = promptTokens;
    return { hit: false, savedTokens: 0 };
  }

  const prev = state.prevPromptTokens;
  state.prevPromptTokens = promptTokens;

  // First turn — no baseline for comparison
  if (prev === null) {
    return { hit: false, savedTokens: 0 };
  }

  if (promptTokens < prev) {
    const saved = prev - promptTokens;
    // Mirror CC's "no-break" OR condition: report hit when either threshold is met
    if (saved >= 2000 || saved >= prev * 0.05) {
      return { hit: true, savedTokens: saved };
    }
  }

  return { hit: false, savedTokens: 0 };
}

/**
 * Build a CacheMetrics snapshot for the current turn.
 * Call after estimateCacheHit to get a stable metrics record.
 */
export function buildCacheMetrics(
  state: CacheState,
  promptTokens: number,
  turn: number,
): CacheMetrics {
  const { hit, savedTokens } = estimateCacheHit(state, promptTokens);
  return {
    turn,
    promptTokens,
    estimatedCacheHit: hit,
    estimatedSavedTokens: savedTokens,
    cacheInvalidated: state.systemPromptChanged || state.toolsChanged,
  };
}

// ── Future: Anthropic cache_control Config ──

/**
 * Cache control configuration for provider-specific annotation.
 *
 * DeepSeek: NO-OP (automatic prefix caching, no markers needed).
 * Anthropic (future): used to build cache_control: { type: 'ephemeral' } blocks.
 */
export interface CacheControlConfig {
  /** Whether explicit cache annotation is supported by the provider */
  enabled: boolean;
  /** Cache TTL hint (5min default; 1h for eligible sessions) */
  ttl: '5min' | '1h';
  /** Whether to annotate system prompt blocks */
  annotateSystemPrompt: boolean;
  /** Whether to place a breakpoint on the last message */
  annotateLastMessage: boolean;
}

/**
 * Get cache control configuration for the current provider.
 *
 * Claude Code equivalent: getCacheControl() returns cache_control metadata
 * based on model, user eligibility, and feature flags.
 *
 * Currently always returns NO-OP (DeepSeek-only). When Anthropic provider
 * is added through TriStaciss, this function will gate on provider type.
 */
export function getCacheControlConfig(
  _model: string,
  _opts?: { enable1hTTL?: boolean },
): CacheControlConfig {
  // DeepSeek: automatic prefix caching, no explicit markers needed.
  // Future: when Anthropic provider is active, return:
  //   { enabled: true, ttl: enable1hTTL ? '1h' : '5min', annotateSystemPrompt: true, annotateLastMessage: true }
  return {
    enabled: false,
    ttl: '5min',
    annotateSystemPrompt: false,
    annotateLastMessage: false,
  };
}

// ── Session Lifecycle ──

/** Reset cache state for a new session (clears all baselines). */
export function resetCacheStateForNewSession(state: CacheState): void {
  state.systemPromptHash = null;
  state.toolsHash = null;
  state.lastTurn = 0;
  state.systemPromptChanged = false;
  state.toolsChanged = false;
  state.prevPromptTokens = null;
}
