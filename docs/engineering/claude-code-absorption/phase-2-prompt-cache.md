# Phase 2: Prompt Cache Absorption Analysis

**Author**: CTO 小狄
**Date**: 2026-07-18
**Status**: Complete
**Source**: Claude Code 2.1.88 vendor (`src/services/api/promptCacheBreakDetection.ts`, 726 lines; `src/services/api/claude.ts` cache sections; `src/services/compact/` 16 files)
**Target**: TriMMC (currently **zero caching infrastructure**)

---

## 1. Executive Summary

Claude Code's prompt caching subsystem is a **three-layer architecture**: (1) cache_control annotation at API-call boundaries, (2) two-phase break detection (pre-call snapshot → post-call delta), (3) cache_edits deletion system for reclaiming cached context. It instruments every dimension that can invalidate the Anthropic server-side KV cache — system prompt, tools, model, betas, effort, fast mode, global cache strategy, and extra body params — and surfaces human-readable explanations when cache breaks occur.

**Key finding**: TriMMC currently implements **0%** of Claude Code's prompt caching infrastructure. This is the single largest **cost-per-turn gap** between the two systems: every TriMMC API call re-sends the full system prompt + tool schemas without any cache reuse. For a typical session of 30+ turns, Claude Code's cache hit rate of ~85% translates to roughly **80% fewer input tokens** for system+tools — the equivalent of saving ~20K tokens per cached call.

**Recommended absorption order**: Cache annotation (immediate ROI) → break detection (observability) → cache_edits (advanced optimization) → compaction integration (Phase 3 prerequisite).

---

## 2. Claude Code Architecture Deconstruction

### 2.1 Three-Layer Cache Stack

```
┌─────────────────────────────────────────────────────┐
│ Layer 3: cache_edits (Cached Microcompact)          │
│   Delete cached content in-place without full       │
│   cache break. Pinned edits carry across turns.     │
├─────────────────────────────────────────────────────┤
│ Layer 2: Cache Break Detection                      │
│   Two-phase: recordPromptState() → API call →       │
│   checkResponseForCacheBreak(). Human-readable       │
│   explanation of what changed and why.              │
├─────────────────────────────────────────────────────┤
│ Layer 1: cache_control Annotation                   │
│   { type: 'ephemeral', ttl?: '1h', scope?: 'global' }│
│   Applied to system prompt blocks + last message.    │
└─────────────────────────────────────────────────────┘
```

### 2.2 Layer 1: Cache Annotation (`claude.ts`)

**`getCacheControl()`** — the single source of truth for cache metadata:

```ts
// Returns: { type: 'ephemeral', ttl?: '1h', scope?: 'global' }
function getCacheControl({ scope?, querySource? }) {
  return {
    type: 'ephemeral',
    ...(should1hCacheTTL(querySource) && { ttl: '1h' }),
    ...(scope === 'global' && { scope }),
  }
}
```

**TTL decision tree** (`should1hCacheTTL`):
- Default TTL: **5 minutes** (Anthropic server-side default)
- 1h TTL eligibility: `USER_TYPE === 'ant'` OR (`isClaudeAISubscriber()` AND NOT `isUsingOverage`)
- GrowthBook allowlist gates which `querySource` patterns get 1h (e.g., `repl_main_thread*`, `sdk`, `agent:*`)
- Both eligibility and allowlist are **latched for session stability** — prevents mid-session TTL flips that would bust the cache

**Scope semantics**:
- `scope: 'global'` — shared across all users in the same org (used for org-wide system prompt blocks)
- No scope — per-user cache (default for most content)
- `buildSystemPromptBlocks()` applies scope per-block based on `cacheScope` metadata from `splitSysPromptPrefix()`

**Breakpoint placement** (`addCacheBreakpoints`):
- **Exactly one** cache_control marker per request — on the **last message** (or second-to-last for fire-and-forget forks)
- Mycro's turn-to-turn eviction: with two markers, the second-to-last position's local-attention KV pages survive an extra turn needlessly; one marker ensures they're freed immediately
- For fire-and-forget forks (`skipCacheWrite`): marker shifts to second-to-last message so the fork writes a no-op merge (entry already exists) and doesn't pollute the KVCC

**cache_reference on tool_result blocks**:
- Every `tool_result` block strictly **before** the last cache_control marker gets `cache_reference: block.tool_use_id`
- Creates new objects (never mutates in-place) to avoid contaminating blocks reused by secondary queries
- Essential for the server-side KV cache to correctly reference tool results within the cached prefix

**System prompt caching** (`buildSystemPromptBlocks`):
- Each system block carries `cacheScope: 'global' | null` from `splitSysPromptPrefix`
- Blocks with `cacheScope !== null` get `cache_control` annotation
- `skipGlobalCacheForSystemPrompt` option suppresses global-scope caching (used for advisor sub-agents)

### 2.3 Layer 2: Cache Break Detection (`promptCacheBreakDetection.ts`, 726 lines)

**Two-phase protocol**:

```
Phase 1 (pre-call): recordPromptState(snapshot)
  → Compute hashes of system, tools, cache_control, betas, effort, extra body
  → Compare with PreviousState → populate PendingChanges
  → Store new state (with LRU eviction: MAX_TRACKED_SOURCES = 10)

Phase 2 (post-call): checkResponseForCacheBreak(source, cacheReadTokens, ...)
  → If pending cacheDeletions → expected drop, reset baseline, return
  → If cacheReadTokens >= 95% of prev AND drop < MIN_CACHE_MISS_TOKENS (2,000) → no break
  → Otherwise: build human-readable explanation from PendingChanges
  → If no client-side changes: classify as TTL expiry or server-side routing/eviction
  → Fire tengu_prompt_cache_break analytics event
  → Write diff file for debugging (--debug mode)
```

**State tracked per source** (`PreviousState`):

| Field | Purpose | Break Condition |
|-------|---------|-----------------|
| `systemHash` | System prompt content hash (stripped of cache_control) | Content changed |
| `toolsHash` | Tool schema aggregate hash (stripped) | Tool added/removed/changed |
| `cacheControlHash` | Hash of cache_control annotations only | TTL or scope flipped |
| `toolNames` | Tool name list | Tool added/removed |
| `perToolHashes` | Per-tool schema hash | Which specific tool changed |
| `systemCharCount` | System prompt character count | Size delta reported |
| `model` | Model name | Model switched |
| `fastMode` | Fast mode flag | Mode toggled |
| `globalCacheStrategy` | `'tool_based' \| 'system_prompt' \| 'none'` | Strategy changed |
| `betas` | Sorted beta header list | Beta headers added/removed |
| `autoModeActive` | AFK mode beta header | Tracked but explicitly NOT a break cause |
| `isUsingOverage` | Overage state | Tracked but explicitly NOT a break cause |
| `cachedMCEnabled` | Cache-editing beta | Tracked but explicitly NOT a break cause |
| `effortValue` | Resolved effort | Effort changed |
| `extraBodyHash` | `getExtraBodyParams()` hash | Extra body params changed |
| `callCount` | Turn counter | Reported in analytics |
| `prevCacheReadTokens` | Previous cache read count | Baseline for delta |
| `cacheDeletionsPending` | Pending cachedMC deletion flag | Expected drop, not a real break |
| `buildDiffableContent` | Lazy-built full prompt+tools text for diff | Diff file generation |

**Tracking key isolation**:
- `repl_main_thread` + `compact` → shared key (same server-side cache)
- `sdk`, `agent:custom`, `agent:default`, `agent:builtin` → per-agentId keys
- Untracked sources (`speculation`, `session_memory`, `prompt_suggestion`) → no detection (short-lived, no value)

**Break classification logic**:
1. `cacheDeletionsPending` → "expected drop from cache edits"
2. Client-side `PendingChanges` found → specific change explanation (e.g., "system prompt changed (+342 chars)")
3. No client changes, `timeSinceLastAssistantMsg > 1h` → "possible 1h TTL expiry"
4. No client changes, `timeSinceLastAssistantMsg > 5min` → "possible 5min TTL expiry"
5. No client changes, `< 5min gap` → "likely server-side (prompt unchanged, <5min gap)" — accounts for ~90% of unexplained breaks per BQ analysis

**Compaction integration**:
- `notifyCompaction()` — resets `prevCacheReadTokens = null` (context collapse → cache legitimately smaller)
- `notifyCacheDeletion()` — sets `cacheDeletionsPending = true` (next cache drop is expected)
- `cleanupAgentTracking()` — removes agent from tracking map on termination
- `resetPromptCacheBreakDetection()` — full reset (used for full session reset)

### 2.4 Layer 3: Cache Edit System (Cached Microcompact)

**Purpose**: Delete specific cached content blocks without a full cache break. Anthropic's `cache_edits` feature allows removing content from the KV cache by referencing `cache_reference` IDs.

**Architecture**:
- **`cachedMicrocompact.ts`** — fine-grained cache eviction via `cache_edits` blocks
- **`cachedMCConfig.ts`** — configuration gates (GrowthBook feature flags)
- **`timeBasedMCConfig.ts`** — time-based triggering thresholds
- **Pinned edits**: deletions sent at specific positions are remembered and re-sent at the same position in subsequent calls (via `pinCacheEdits`)
- **Deduplication**: `cache_reference` IDs are tracked across blocks to prevent duplicate deletions
- **Insertion point**: new deletions go into the last user message, after tool results

**Interaction with break detection**:
- Before sending cache_edits: calls `notifyCacheDeletion()` → next API response's lower cache read is expected
- After compaction: calls `notifyCompaction()` → resets baseline so the reduced message count doesn't trigger false break

---

## 3. Gap Analysis: TriMMC vs Claude Code

### 3.1 Current State: Zero Caching

TriMMC has **no prompt caching infrastructure whatsoever**:

| Capability | Claude Code | TriMMC | Gap |
|------------|-------------|-------|-----|
| cache_control annotation | Full: TTL, scope, per-block | None | **Critical** |
| System prompt cache blocks | `splitSysPromptPrefix` + `cacheScope` | None | **Critical** |
| Last-message breakpoint | Exactly one marker | None | **Critical** |
| cache_reference on tool_results | All blocks before last marker | None | High |
| Pre-call state recording | `recordPromptState()` | None | High |
| Post-call break detection | `checkResponseForCacheBreak()` | None | High |
| Break explanation + diff | Human-readable + file diff | None | Medium |
| cache_edits deletion | Full: pin, dedup, insert | None | Low |
| Compaction cache integration | `notifyCompaction/notifyCacheDeletion` | N/A (no compaction yet) | Phase 3 |
| TTL management | 5min/1h, latched session-stable | None | Medium |
| Per-source state isolation | tracking key + 10-source LRU | None | Medium |
| Analytics | `tengu_prompt_cache_break` event | None | Medium |

### 3.2 Cost Impact Estimate

For a typical 30-turn session:
- Claude Code: System prompt (~15K tokens) + tools (~5K tokens) cached after first call → ~28 turns × 20K = **560K tokens saved**
- TriMMC: Full system + tools re-sent every turn → **0 tokens saved**
- At Anthropic cache write pricing (25% premium) and cache read pricing (10% of base): **~60% net input cost reduction** for cached turns

### 3.3 Implementation Complexity

| Component | Lines (CC) | Est. TriMMC Lines | Difficulty | Dependency |
|-----------|------------|------------------|------------|------------|
| getCacheControl + should1hCacheTTL | ~80 | ~50 | Low | Config system |
| buildSystemPromptBlocks | ~40 | ~60 | Low | System prompt structure |
| addCacheBreakpoints | ~120 | ~80 | Medium | Message format |
| cache_reference annotation | ~40 | ~30 | Low | Message format |
| PromptStateSnapshot + recordPromptState | ~230 | ~150 | Medium | Hash utilities |
| checkResponseForCacheBreak | ~270 | ~200 | Medium | Analytics |
| Per-source state + LRU eviction | ~60 | ~40 | Low | Map data structure |
| Write diff for debugging | ~30 | ~20 | Low | File I/O |
| cache_edits system | ~500+ | ~300 | High | API feature gate |
| Compaction integration | ~20 | ~10 | Low | After Phase 3 |

**Total estimated**: ~940 lines across all components, ~570 lines for Tier 1+2 only.

---

## 4. Absorption Recommendations

### 4.1 Priority Order

```
Tier 1 (Immediate ROI — absorb first)
├─ P2.1: cache_control annotation on system prompt
├─ P2.2: cache_control breakpoint on last message
├─ P2.3: cache_reference on tool_result blocks
└─ P2.4: TTL decision logic (5min default, 1h for eligible calls)

Tier 2 (Observability — absorb after Tier 1)
├─ P2.5: recordPromptState() — pre-call snapshot
├─ P2.6: checkResponseForCacheBreak() — post-call delta
└─ P2.7: Per-source state isolation + analytics event

Tier 3 (Advanced — absorb after Phase 3 compaction)
├─ P2.8: cache_edits support (needs Anthropic API feature gate)
└─ P2.9: Compaction cache integration (notifyCompaction/notifyCacheDeletion)
```

### 4.2 Tier 1: Cache Annotation (P2.1–P2.4)

**What to absorb**:
1. **`getCacheControl()` equivalent**: Return `{ type: 'ephemeral' }` for all calls initially; add TTL/scope later when config system matures
2. **System prompt block splitting**: Add `cacheScope` metadata to system prompt blocks; mark global-scope blocks with `cache_control: { type: 'ephemeral', scope: 'global' }`
3. **Last-message breakpoint**: Place exactly one `cache_control: { type: 'ephemeral' }` on the last message's last content block
4. **cache_reference**: Add `cache_reference: tool_use_id` to all tool_result blocks before the last cache_control marker

**Simplifications vs Claude Code**:
- Skip scope/org distinction initially (TriMMC has no org concept yet)
- Skip 1h TTL initially (5min default is sufficient for MVP sessions)
- Skip Mycro-specific single-marker optimization (not applicable to non-Mycro backends)
- Skip fire-and-forget fork handling (no forked agents yet)

**Implementation touch points**:
- `src/server/` — modify API request builder
- `src/agent-loop/` — add cache annotation pass before model call
- `src/types/` — add `CacheScope` and cache_control type definitions

### 4.3 Tier 2: Break Detection (P2.5–P2.7)

**What to absorb**:
1. **`recordPromptState()`** — hash system prompt, tool schemas, model, and other cache-relevant params before each API call
2. **`checkResponseForCacheBreak()`** — compare cache read tokens to previous baseline; log break events
3. **Per-source state map** — simple `Map<string, PreviousState>` with source-based keying

**Simplifications vs Claude Code**:
- Skip per-tool hashes initially (aggregate tool hash is sufficient)
- Skip GrowthBook integration (TTL is fixed at 5min)
- Skip betas, effort, extraBody tracking (add as TriMMC gains those features)
- Skip diff file writing initially (console log is sufficient)
- Use 10-source LRU cap (same as Claude Code)

**Implementation touch points**:
- `src/observability/` — break event logging
- New file: `src/services/cache-break-detection.ts`
- `src/agent-loop/` — call recordPromptState before API call, checkResponseForCacheBreak after

### 4.4 Tier 3: cache_edits (P2.8–P2.9)

**Deferred** — requires:
1. Anthropic `cache_edits` API feature gate availability
2. Phase 3 compaction subsystem (need compacted context to know what to delete)
3. Pinned-edit state management across turns

**What to absorb** (when ready):
- `cachedMicrocompact.ts` architecture — fine-grained cache eviction
- Pin/dedup/insert pattern for cache_edits blocks
- `notifyCacheDeletion()` / `notifyCompaction()` integration

### 4.5 What NOT to Absorb

| Claude Code Feature | Reason to Skip |
|---------------------|----------------|
| `Bun.hash()` / Bun-specific fallback | TriMMC uses Node.js; use `crypto.createHash` |
| GrowthBook feature flag gating | TriMMC doesn't use GrowthBook; use env vars or config |
| Mycro-specific single-marker optimization | Non-Mycro backend doesn't need this |
| `autoModeActive` / `overage` / `cachedMCEnabled` tracking | Claude Code-specific features; add when TriMMC has equivalents |
| `AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS` type branding | Claude Code's analytics privacy type; TriMMC can use plain strings |
| Agent/sub-agent tracking key isolation | No sub-agents in TriMMC yet; add when Phase 3 (sub-agent tree) is absorbed |
| Fire-and-forget fork handling | No forked queries in TriMMC yet |

---

## 5. Implementation Plan

### 5.1 Phase 2a: Cache Annotation (Estimated: 1–2 sessions)

```
File: src/services/cache-annotation.ts (~120 lines)
  export function getCacheControl(): CacheControl
  export function annotateSystemPrompt(blocks, enableCaching): TextBlockParam[]
  export function annotateMessages(messages, enableCaching): MessageParam[]
  export function annotateToolResults(messages, enableCaching): MessageParam[]

File: src/types/cache.ts (~30 lines)
  type CacheControl = { type: 'ephemeral'; ttl?: '1h'; scope?: 'global' }
  type CacheScope = 'global'

Modify: src/server/ — integrate annotation into API request pipeline
Modify: src/agent-loop/ — call annotation before model call
```

### 5.2 Phase 2b: Break Detection (Estimated: 1–2 sessions)

```
File: src/services/cache-break-detection.ts (~250 lines)
  export function recordPromptState(snapshot: PromptStateSnapshot): void
  export function checkResponseForCacheBreak(...): Promise<void>
  export function resetPromptCacheBreakDetection(): void

File: src/observability/cache-events.ts (~50 lines)
  type CacheBreakEvent = { reason, previousTokens, currentTokens, ... }
  export function logCacheBreakEvent(event: CacheBreakEvent): void

Modify: src/agent-loop/ — add pre/post-call hooks
```

### 5.3 Phase 2c: cache_edits (Deferred to post-Phase 3)

```
File: src/services/cache-edits.ts (~300 lines)
  Pin/dedup/insert pattern
  notifyCacheDeletion + notifyCompaction integration
  Compaction trigger hook
```

### 5.4 Verification Checklist

- [ ] P2.1: System prompt blocks carry cache_control annotation
- [ ] P2.2: Last message has exactly one cache_control breakpoint
- [ ] P2.3: tool_result blocks within cached prefix have cache_reference
- [ ] P2.4: TTL is 5min default; env-configurable to 1h
- [ ] P2.5: recordPromptState snapshots before every API call
- [ ] P2.6: checkResponseForCacheBreak detects drops >5% and >2000 tokens
- [ ] P2.7: Cache break events logged to observability
- [ ] API responses show cache_read_tokens > 0 after first call of session
- [ ] Changing system prompt causes detected cache break
- [ ] Changing tool schemas causes detected cache break
- [ ] Changing model causes detected cache break

---

## 6. Risk Analysis

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Anthropic API rejects cache_control on model not supporting it | Low | Medium | Feature-detect model support; skip annotation for unsupported models |
| Incorrect breakpoint placement causes cache misses | Medium | Low | Start with last-message-only; validate with cache_read_tokens > 0 |
| cache_reference on wrong blocks causes 400 errors | Low | High | Strict "before last cache_control" boundary; test with small message arrays |
| State tracking memory leak | Low | Low | LRU cap of 10 sources (same as Claude Code) |
| 1h TTL causes unexpected breaks when session pauses > 1h | Low | Low | Start with 5min TTL only; add 1h when config system matures |

---

## 7. Dependencies

### Upstream (must absorb first)
- None — cache annotation is a leaf capability that modifies only the API request format

### Downstream (blocked by this)
- Phase 3 (Sub-Agent Tree): Sub-agents share the main thread's cache; break detection per-source isolation needed
- Phase 4 (Tool Permission Model): Tool schema changes are a cache break cause; detection needed
- Cost optimization: All future input-token cost analysis depends on cache hit rate baselines

### Co-requisites
- Phase 1 (Core Loop): Cache annotation happens inside the loop body; Phase 1 must be partially complete for integration
- Observability infrastructure: Cache break events need a logging sink

---

## 8. Key Design Decisions

1. **Start with 5min TTL only**: 1h requires user eligibility logic (ant/subscriber detection) that TriMMC doesn't have yet. 5min covers the common case of rapid turns within a session.

2. **Skip scope/org caching**: TriMMC has no org/multi-user concept. All cache is per-user (no scope annotation needed).

3. **Aggregate tool hash before per-tool**: Tracking which specific tool changed is useful but adds complexity. Start with aggregate and add per-tool when debugging tool-change-induced breaks.

4. **Console log before analytics**: Claude Code fires `tengu_prompt_cache_break` to BQ. TriMMC should start with structured console logging and add analytics sink later.

5. **cache_edits deferred to post-Phase 3**: Deleting cached content requires knowing what to compact, which requires the compaction subsystem (Phase 3). The cache annotation + break detection layers are independently valuable.

---

## 9. Source File Index

| File | Lines | Role in Cache System |
|------|-------|---------------------|
| `src/services/api/claude.ts` | ~3240 | `getCacheControl()`, `should1hCacheTTL()`, `buildSystemPromptBlocks()`, `addCacheBreakpoints()`, `userMessageToMessageParam()`, `assistantMessageToMessageParam()` |
| `src/services/api/promptCacheBreakDetection.ts` | 726 | `recordPromptState()`, `checkResponseForCacheBreak()`, `notifyCacheDeletion()`, `notifyCompaction()`, `cleanupAgentTracking()`, `resetPromptCacheBreakDetection()` |
| `src/services/compact/autoCompact.ts` | ~200 | Calls `notifyCompaction()` after successful compaction |
| `src/services/compact/cachedMicrocompact.ts` | ~200 | Fine-grained cache eviction via cache_edits; calls `notifyCacheDeletion()` |
| `src/services/compact/cachedMCConfig.ts` | ~50 | GrowthBook feature flags for cached microcompact |
| `src/services/compact/timeBasedMCConfig.ts` | ~50 | Time-based triggering thresholds |
| `src/bootstrap/state.ts` | ~250 | `getPromptCache1hEligible()`, `setPromptCache1hEligible()`, `getPromptCache1hAllowlist()`, `setPromptCache1hAllowlist()` |
| `src/utils/systemPrompt.ts` | ~200 | `splitSysPromptPrefix()` — splits system prompt into cacheable blocks with `cacheScope` metadata |
