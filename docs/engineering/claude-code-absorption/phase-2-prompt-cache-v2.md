# Phase 2: Prompt Cache Absorption Analysis (v2 — 小全+小柯)

**Author**: CTO 小狄
**Date**: 2026-07-15
**Status**: Complete (小全 source re-read + 小柯 25-item cross-verification)
**Source**: Claude Code 2.1.88 vendor
- `src/services/api/claude.ts` (3419 lines) — `getCacheControl()`, `should1hCacheTTL()`, `buildSystemPromptBlocks()`, `addCacheBreakpoints()`, `userMessageToMessageParam()`, `assistantMessageToMessageParam()`
- `src/services/api/promptCacheBreakDetection.ts` (726 lines) — `recordPromptState()`, `checkResponseForCacheBreak()`, `notifyCacheDeletion()`, `notifyCompaction()`, `cleanupAgentTracking()`, `resetPromptCacheBreakDetection()`
- `src/services/compact/cachedMicrocompact.ts` — Layer 3 cache_edits system
- `src/utils/systemPrompt.ts` — `splitSysPromptPrefix()` with `cacheScope` metadata
- `src/bootstrap/state.ts` — `getPromptCache1hEligible()` / `setPromptCache1hEligible()`

**Target**: TriMMC (currently **zero caching infrastructure** — confirmed: no cache-related source files or annotations)

**v2 Changes vs v1**: Source re-read with line-level traceability; corrected break detection threshold from AND→OR; corrected line counts; added sanitization, exclusion model, and betas-latching analysis; expanded verification checklist from 11→25 items.

---

## 1. Executive Summary

Claude Code's prompt caching subsystem is a **three-layer architecture**:

```
Layer 1 (Annotation): cache_control markers on system prompt + last message
Layer 2 (Detection): two-phase pre-call snapshot → post-call delta analysis
Layer 3 (Deletion):  cache_edits for reclaiming cached context without full cache break
```

It instruments **every dimension** that can invalidate the Anthropic server-side KV cache — system prompt, tools, model, betas, effort, fast mode, global cache strategy, and extra body params — and surfaces human-readable explanations when cache breaks occur.

**Key finding**: TriMMC currently implements **0%** of Claude Code's prompt caching infrastructure. Every TriMMC API call re-sends the full system prompt + tool schemas without any cache reuse. For a typical session of 30+ turns at ~85% cache hit rate, this translates to roughly **80% fewer input tokens** for system+tools per cached call (~20K tokens saved per call).

**Two significant corrections from v1**:
1. **Break detection threshold** uses **OR**, not AND: `(cacheReadTokens >= 95% of prev) || (tokenDrop < 2000)` → no break (promptCacheBreakDetection.ts L486-488). The v1 description incorrectly stated both conditions must be met.
2. **claude.ts is 3419 lines**, not ~3240 as stated in v1.

**Recommended absorption order**: Cache annotation (immediate ROI) → break detection (observability) → cache_edits (advanced optimization, post-Phase 3).

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

### 2.2 Layer 1: Cache Annotation (claude.ts)

#### 2.2.1 `getCacheControl()` — Single Source of Truth (L358–374)

```ts
export function getCacheControl({
  scope,
  querySource,
}: {
  scope?: CacheScope
  querySource?: QuerySource
} = {}): {
  type: 'ephemeral'
  ttl?: '1h'
  scope?: CacheScope
} {
  return {
    type: 'ephemeral',
    ...(should1hCacheTTL(querySource) && { ttl: '1h' }),
    ...(scope === 'global' && { scope }),
  }
}
```

Returns `{ type: 'ephemeral' }` as the base. Conditionally adds `ttl: '1h'` and `scope: 'global'`.

#### 2.2.2 `should1hCacheTTL()` — TTL Decision Tree (L376–435)

**Eligibility gates** (L393–435):
1. **Bedrock 3P shortcut** (L396–401): `ENABLE_PROMPT_CACHING_1H_BEDROCK` env var → 1h TTL (no GrowthBook gating)
2. **User eligibility** (L406–412): `USER_TYPE === 'ant'` OR (`isClaudeAISubscriber()` AND NOT `isUsingOverage`). **Latched session-stable** via `setPromptCache1hEligible()` — prevents mid-session TTL flips that would bust the server-side prompt cache (~20K tokens per flip).
3. **GrowthBook allowlist** (L415–430): Latched in bootstrap state (`getPromptCache1hAllowlist()`). Supports `*` wildcard patterns (e.g., `repl_main_thread*`, `agent:*`).
4. **Pattern match** (L427–431): `pattern.endsWith('*') ? querySource.startsWith(pattern.slice(0, -1)) : querySource === pattern`

**Default TTL**: 5 minutes (Anthropic server-side default when no `ttl` field sent).

**Session stability invariant**: Both user eligibility and GrowthBook allowlist are latched — prevents mid-session `cache_control` TTL flips that would invalidate the server-side KV cache.

#### 2.2.3 `buildSystemPromptBlocks()` — Per-Block Scope Annotation (L3213–3237)

```ts
export function buildSystemPromptBlocks(
  systemPrompt: SystemPrompt,
  enablePromptCaching: boolean,
  options?: {
    skipGlobalCacheForSystemPrompt?: boolean
    querySource?: QuerySource
  },
): TextBlockParam[] {
  return splitSysPromptPrefix(systemPrompt, {
    skipGlobalCacheForSystemPrompt: options?.skipGlobalCacheForSystemPrompt,
  }).map(block => ({
    type: 'text' as const,
    text: block.text,
    ...(enablePromptCaching &&
      block.cacheScope !== null && {
        cache_control: getCacheControl({
          scope: block.cacheScope,
          querySource: options?.querySource,
        }),
      }),
  }))
}
```

**Key mechanics**:
- `splitSysPromptPrefix()` (from `src/utils/systemPrompt.ts`) splits the system prompt into blocks, each carrying `cacheScope: 'global' | null`
- Blocks with `cacheScope !== null` get `cache_control` annotation
- `skipGlobalCacheForSystemPrompt` option suppresses global-scope caching (used for advisor sub-agents — `claude.ts` L1388-1389: advisor toggles only churn the small suffix, not the cached prefix)
- Each block is annotated independently via `getCacheControl({ scope: block.cacheScope })`

#### 2.2.4 `userMessageToMessageParam()` / `assistantMessageToMessageParam()` — Per-Message Annotation (L588–674)

Both functions follow the same pattern:
- If `addCache` is true, place `cache_control` on the **last content block** of the message
- `assistantMessageToMessageParam` skips `thinking`/`redacted_thinking`/connector text blocks when finding the last block (L658–661)
- When `addCache` is false, the message is returned without cache_control (but content arrays are shallow-cloned to prevent mutation — L622–629)

#### 2.2.5 `addCacheBreakpoints()` — Exactly One Marker Per Request (L3063–3211)

This is the orchestrator that decides **which message** gets the cache_control marker.

**Single-marker invariant** (L3078–3088):
```
Exactly one message-level cache_control marker per request. Mycro's
turn-to-turn eviction (page_manager/index.rs: Index::insert) frees
local-attention KV pages at any cached prefix position NOT in
cache_store_int_token_boundaries. With two markers the second-to-last
position is protected and its locals survive an extra turn even though
nothing will ever resume from there — with one marker they're freed
immediately.
```

**Breakpoint placement** (L3089):
```ts
const markerIndex = skipCacheWrite
  ? messages.length - 2   // fire-and-forget fork: marker on second-to-last
  : messages.length - 1   // normal: marker on last message
```

**Fire-and-forget fork handling** (L3084–3088): When `skipCacheWrite` is true, the marker shifts to the second-to-last message. The write becomes a no-op merge on Mycro (entry already exists), and the fork doesn't pollute the KVCC.

**cache_reference on tool_result blocks** (L3164–3207):
- All `tool_result` blocks **strictly before** the last cache_control marker get `cache_reference: block.tool_use_id`
- Uses cloned arrays + `Object.assign` (never mutates in-place) to avoid contaminating blocks reused by secondary queries (L3185–3186)
- `for (let i = 0; i < lastCCMsg; i++)` — strict "before" not "before or on" (L3188)

**cache_edits insertion** (L3108–3162):
- Pinned edits from previous calls are re-inserted at their original positions (L3128–3139)
- New cache_edits go into the **last user message**, after tool results (L3142–3161)
- Deduplication: `seenDeleteRefs` set prevents duplicate `cache_reference` deletions across blocks (L3113–3125)

#### 2.2.6 Global Cache Strategy (L1207–1229)

```ts
const globalCacheStrategy: GlobalCacheStrategy = useGlobalCacheFeature
  ? needsToolBasedCacheMarker
    ? 'none'       // MCP tools exist → dynamic tool section → can't globally cache
    : 'system_prompt'
  : 'none'
```

- `prompt_caching_scope` beta header is added when global cache is enabled (L1216–1221)
- MCP tools force `'none'` strategy because they're per-user and render dynamically (L1210–1213)

### 2.3 Layer 2: Cache Break Detection (promptCacheBreakDetection.ts, 726 lines)

#### 2.3.1 Two-Phase Protocol

```
Phase 1 (pre-call): recordPromptState(snapshot)
  → Compute hashes of system, tools, cache_control, betas, effort, extra body
  → Compare with PreviousState → populate PendingChanges
  → Store new state (with LRU eviction: MAX_TRACKED_SOURCES = 10)

Phase 2 (post-call): checkResponseForCacheBreak(...)
  → If cacheDeletionsPending → expected drop, reset baseline, return
  → If cacheReadTokens >= 95% of prev OR drop < 2000 tokens → no break
  → Otherwise: build human-readable explanation from PendingChanges
  → If no client-side changes: classify as TTL expiry or server-side routing/eviction
  → Fire tengu_prompt_cache_break analytics event
  → Write diff file for debugging (--debug mode)
```

**Critical correction from v1**: The "no break" condition uses **OR**, not AND:
```ts
// promptCacheBreakDetection.ts L486–488
if (
  cacheReadTokens >= prevCacheRead * 0.95 ||  // <5% drop → no break
  tokenDrop < MIN_CACHE_MISS_TOKENS            // <2000 absolute tokens → no break
) {
  state.pendingChanges = null
  return  // ← no break
}
```
A break is reported **only when** `(drop >= 5% AND drop >= 2000 tokens)`.

#### 2.3.2 PreviousState (20 fields, L28–69)

| # | Field | Purpose | Break Condition |
|---|-------|---------|-----------------|
| 1 | `systemHash` | System prompt content hash (cache_control stripped) | Content changed |
| 2 | `toolsHash` | Tool schema aggregate hash (cache_control stripped) | Tool added/removed/changed |
| 3 | `cacheControlHash` | Hash of cache_control annotations only (L279–281) | TTL or scope flipped |
| 4 | `toolNames` | Tool name list | Tool added/removed |
| 5 | `perToolHashes` | Per-tool schema hash (L187–196, lazy per L284–286) | Which specific tool changed |
| 6 | `systemCharCount` | System prompt character count (L198–204) | Size delta reported |
| 7 | `model` | Model name | Model switched |
| 8 | `fastMode` | Fast mode flag | Mode toggled |
| 9 | `globalCacheStrategy` | `'tool_based'` \| `'system_prompt'` \| `'none'` | Strategy changed |
| 10 | `betas` | Sorted beta header list | Beta headers added/removed |
| 11 | `autoModeActive` | AFK mode beta header | **Tracked but explicitly NOT break cause** (L47–48) |
| 12 | `isUsingOverage` | Overage state | **Tracked but explicitly NOT break cause** (L50–51) |
| 13 | `cachedMCEnabled` | Cache-editing beta header | **Tracked but explicitly NOT break cause** (L53–55) |
| 14 | `effortValue` | Resolved effort (env → options → model default) | Effort changed |
| 15 | `extraBodyHash` | `getExtraBodyParams()` hash (L293–294) | Extra body params changed |
| 16 | `callCount` | Turn counter | Reported in analytics |
| 17 | `pendingChanges` | `PendingChanges \| null` | Populated by recordPromptState, consumed by checkResponseForCacheBreak |
| 18 | `prevCacheReadTokens` | Previous cache read count | Baseline for delta |
| 19 | `cacheDeletionsPending` | Pending cachedMC deletion flag | Expected drop, not a real break |
| 20 | `buildDiffableContent` | Lazy-built full prompt+tools text (L206–222) | Diff file generation |

**Why `autoModeActive`, `isUsingOverage`, `cachedMCEnabled` are tracked but NOT break causes**: These are latched session-stable in `claude.ts` (L1407: "toggles don't change the server-side cache key and bust ~50-70K tokens"). Tracking verifies the latch fix is working — if they ever change mid-session despite the latch, the analytics event will show it without falsely blaming them.

#### 2.3.3 `recordPromptState()` — Phase 1: Pre-Call Snapshot (L247–430)

**Flow**:
1. Get tracking key via `getTrackingKey()` (L264). Returns `null` for untracked sources → early return.
2. `stripCacheControl()` (L267–272): Removes `cache_control` from system and tools before hashing — but preserves a separate `cacheControlHash` computed from the full system array (L279–281) to catch scope/TTL flips.
3. Compute hashes: `systemHash`, `toolsHash`, `cacheControlHash` (L274–281)
4. **First call for key** (L298–328): Initialize `PreviousState` with all fields + LRU eviction if at capacity. `perToolHashes` is eagerly computed (L325).
5. **Subsequent calls** (L330–430): Compare all fields; if any changed → populate `PendingChanges`. Per-tool hashes computed lazily only when aggregate tool hash changed (L284–286, L369–377).
6. **Always update** (L412–426): Store new values regardless of whether anything changed — next call needs the new baseline.

**`getTrackingKey()`** (L149–158):
- `'compact'` → `'repl_main_thread'` (shared cache)
- `'repl_main_thread*'`, `'sdk'`, `'agent:*'` → `agentId || querySource`
- All others (speculation, session_memory, prompt_suggestion) → `null` (untracked)

**LRU eviction** (L300–303): `while (previousStateBySource.size >= MAX_TRACKED_SOURCES) { delete oldest }`. Uses `Map.keys().next().value` which returns the first-inserted key (JavaScript Map insertion order).

#### 2.3.4 `checkResponseForCacheBreak()` — Phase 2: Post-Call Delta (L437–666)

**5-level break classification** (L578–588):
1. **cacheDeletionsPending** (L473–481): Expected drop from cache_edits → reset flag, return
2. **Client-side changes** (L496–562): Human-readable explanation composed from PendingChanges parts
3. **TTL > 1h** (L580): No client changes, `timeSinceLastAssistantMsg > 1h` → "possible 1h TTL expiry"
4. **TTL > 5min** (L582): No client changes, `timeSinceLastAssistantMsg > 5min` → "possible 5min TTL expiry"
5. **Server-side** (L584): No client changes, `< 5min` → "likely server-side (prompt unchanged, <5min gap)" — accounts for ~90% of unexplained breaks per BQ analysis (L573–576)

**Time-based TTL detection** (L458–463): Finds the last assistant message in the messages array, computes `Date.now() - lastAssistantMsg.timestamp`.

**`isExcludedModel()`** (L129–131): Haiku models have different caching behavior and are excluded from break detection:
```ts
function isExcludedModel(model: string): boolean {
  return model.includes('haiku')
}
```

**Analytics event** `tengu_prompt_cache_break` (L590–644): Fires 31 fields covering all PendingChanges dimensions. Tool names are sanitized via `sanitizeToolName()` (L183–185):
```ts
function sanitizeToolName(name: string): string {
  return name.startsWith('mcp__') ? 'mcp' : name
}
```
MCP tools collapse to `'mcp'` because their names are user-configured and may leak filepaths. Built-in names are a fixed vocabulary.

**Diff file** (L649–655, L708–726): Written to `getClaudeTempDir()/cache-break-XXXX.diff` using the `diff` library's `createPatch()`. The path is included in the summary log line (L658).

#### 2.3.5 Compaction Integration Functions (L668–706)

| Function | Lines | Purpose |
|----------|-------|---------|
| `notifyCacheDeletion(querySource, agentId?)` | L673–682 | Sets `cacheDeletionsPending = true` — next drop is expected |
| `notifyCompaction(querySource, agentId?)` | L689–698 | Sets `prevCacheReadTokens = null` — baseline reset |
| `cleanupAgentTracking(agentId)` | L700–702 | Removes agent from tracking Map on termination |
| `resetPromptCacheBreakDetection()` | L704–706 | Full reset (clears entire Map) |

#### 2.3.6 `recordPromptState()` Call Site (claude.ts L1460–1486)

The call site captures everything that could affect the server-side cache key:
```ts
if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
  const toolsForCacheDetection = allTools.filter(
    t => !('defer_loading' in t && t.defer_loading),
  )
  recordPromptState({
    system,
    toolSchemas: toolsForCacheDetection,
    querySource: options.querySource,
    model: options.model,
    agentId: options.agentId,
    fastMode: fastModeHeaderLatched,     // ← latched, not live
    globalCacheStrategy,
    betas,
    autoModeActive: afkHeaderLatched,    // ← latched, not live
    isUsingOverage: currentLimits.isUsingOverage ?? false,
    cachedMCEnabled: cacheEditingHeaderLatched,  // ← latched, not live
    effortValue: effort,
    extraBodyParams: getExtraBodyParams(),
  })
}
```

**Critical detail**: `defer_loading` tools are excluded from `toolsForCacheDetection` (L1465–1467) — the API strips them from the prompt, so they never affect the actual cache key. Including them would cause false-positive "tool schemas changed" breaks when tools are discovered or MCP servers reconnect.

#### 2.3.7 `checkResponseForCacheBreak()` Call Site (claude.ts L2382–2392)

```ts
if (feature('PROMPT_CACHE_BREAK_DETECTION')) {
  void checkResponseForCacheBreak(
    options.querySource,
    usage.cache_read_input_tokens,
    usage.cache_creation_input_tokens,
    messages,
    options.agentId,
    streamRequestId,
  )
}
```

Uses `void` — fire-and-forget, doesn't block the response path.

### 2.4 Layer 3: Cache Edit System (Cached Microcompact)

**Purpose**: Delete specific cached content blocks without a full cache break. Anthropic's `cache_edits` feature allows removing content from the KV cache by referencing `cache_reference` IDs.

**Architecture** (`cachedMicrocompact.ts`):
- Fine-grained cache eviction via `cache_edits` blocks
- **Pinned edits**: Deletions sent at specific positions are remembered and re-sent at the same position in subsequent calls (via `pinCacheEdits`, called at `addCacheBreakpoints` L3153)
- **Deduplication**: `cache_reference` IDs tracked across blocks via `seenDeleteRefs` Set (L3113)
- **Insertion point**: New deletions go into the last user message, after tool results (L3142–3161)

**Configuration gates** (`cachedMCConfig.ts`):
- GrowthBook feature flag: `CACHED_MICROCOMPACT`
- Model allowlist: `isModelSupportedForCacheEditing(model)` (L1194–1199)
- Both feature flag AND model support must be true (L1200)

**Beta header latching** (claude.ts L1431–1439):
```ts
let cacheEditingHeaderLatched = getCacheEditingHeaderLatched() === true
if (
  !cacheEditingHeaderLatched &&
  cachedMCEnabled &&
  !betasParams.includes(cacheEditingBetaHeader)
) {
  cacheEditingHeaderLatched = true
  setCacheEditingHeaderLatched(true)
}
```
Once latched, the beta header stays for the session — prevents mid-session toggles from busting the cache.

**Interaction with break detection**:
- Before sending cache_edits: calls `notifyCacheDeletion()` → next API response's lower cache read is expected
- After compaction: calls `notifyCompaction()` → resets baseline so reduced message count doesn't trigger false break

---

## 3. Gap Analysis: TriMMC vs Claude Code

### 3.1 Current State: Zero Caching

TriMMC has **no prompt caching infrastructure whatsoever** — confirmed by code search: no `cache_control`, `cacheControl`, or `promptCache` references in `TriMMC/src/`. The only `__pycache__` directory found is Python bytecode cache from the heartbeat module.

| Capability | Claude Code | TriMMC | Gap |
|------------|-------------|-------|-----|
| cache_control annotation | Full: TTL, scope, per-block | None | **Critical** |
| System prompt cache blocks | `splitSysPromptPrefix` + `cacheScope` | None | **Critical** |
| Last-message breakpoint | Exactly one marker | None | **Critical** |
| cache_reference on tool_results | All blocks before last marker | None | High |
| Pre-call state recording | `recordPromptState()` 183 lines | None | High |
| Post-call break detection | `checkResponseForCacheBreak()` 229 lines | None | High |
| Break explanation + diff | Human-readable + file diff | None | Medium |
| cache_edits deletion | Full: pin, dedup, insert | None | Low (post-Phase 3) |
| Compaction cache integration | `notifyCompaction`/`notifyCacheDeletion` | N/A (no compaction) | Phase 3 |
| TTL management | 5min/1h, latched session-stable | None | Medium |
| Per-source state isolation | tracking key + 10-source LRU | None | Medium |
| Analytics | `tengu_prompt_cache_break` (31 fields) | None | Medium |

### 3.2 Cost Impact Estimate

For a typical 30-turn session:
- **Claude Code**: System prompt (~15K tokens) + tools (~5K tokens) cached after first call → ~28 turns × 20K = **560K tokens saved**
- **TriMMC**: Full system + tools re-sent every turn → **0 tokens saved**
- At Anthropic cache write pricing (25% premium) and cache read pricing (10% of base): **~60% net input cost reduction** for cached turns

### 3.3 Implementation Complexity (Corrected Counts)

| Component | Actual Lines (CC) | Est. TriMMC Lines | Difficulty | Dependency |
|-----------|-------------------|------------------|------------|------------|
| `getCacheControl` + `should1hCacheTTL` | ~60 | ~50 | Low | Config system |
| `buildSystemPromptBlocks` | ~25 | ~60 | Low | System prompt structure |
| `addCacheBreakpoints` (full) | ~148 | ~80 | Medium | Message format |
| `userMessageToMessageParam` + `assistantMessageToMessageParam` (cache parts) | ~40 | ~30 | Low | Message format |
| `recordPromptState` | ~183 | ~150 | Medium | Hash utilities |
| `checkResponseForCacheBreak` | ~229 | ~200 | Medium | Analytics |
| Per-source state + LRU eviction | ~60 | ~40 | Low | Map data structure |
| Write diff for debugging | ~30 | ~20 | Low | File I/O |
| cache_edits system | ~500+ | ~300 | High | API feature gate |
| Compaction integration | ~20 | ~10 | Low | After Phase 3 |

**Total estimated**: ~1,295 lines in CC; ~940 lines for TriMMC full, ~570 lines for Tier 1+2 only.

---

## 4. Absorption Recommendations

### 4.1 Priority Order

```
Tier 1 (Immediate ROI — absorb first)
├─ P2.1: cache_control annotation on system prompt
├─ P2.2: cache_control breakpoint on last message
├─ P2.3: cache_reference on tool_result blocks
└─ P2.4: TTL decision logic (5min default, env-configurable 1h)

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
1. **`getCacheControl()` equivalent**: Return `{ type: 'ephemeral' }` for all calls initially; add TTL/scope later
2. **System prompt block splitting**: Add `cacheScope` metadata to system prompt blocks; mark global-scope blocks with `cache_control`
3. **Last-message breakpoint**: Place exactly one `cache_control: { type: 'ephemeral' }` on the last message's last non-thinking content block
4. **cache_reference**: Add `cache_reference: tool_use_id` to all tool_result blocks before the last cache_control marker

**Simplifications vs Claude Code**:
- Skip scope/org distinction initially (TriMMC has no org concept)
- Skip 1h TTL initially (5min default covers rapid-turn sessions)
- Skip Mycro-specific single-marker reasoning (not applicable to non-Mycro backends, but the pattern is still correct)
- Skip fire-and-forget fork handling (no forked agents in TriMMC yet)
- Skip GrowthBook integration (env vars for TTL gating)

### 4.3 Tier 2: Break Detection (P2.5–P2.7)

**What to absorb**:
1. **`recordPromptState()`** — hash system prompt, tool schemas, model before each API call. Use `crypto.createHash('sha256')` (Node.js native) instead of Bun.hash.
2. **`checkResponseForCacheBreak()`** — compare cache read tokens to previous baseline: report break when `(drop >= 5%) AND (drop >= 2000 tokens)`. Log break events.
3. **Per-source state map** — simple `Map<string, PreviousState>` with source-based keying and 10-entry LRU cap.

**Simplifications vs Claude Code**:
- Skip per-tool hashes initially (aggregate tool hash sufficient)
- Skip betas, effort, extraBody tracking (add as TriMMC gains those features)
- Skip diff file writing (structured console log sufficient)
- Skip `defer_loading` filtering (no MCP tools yet)
- Skip `isExcludedModel()` (no haiku usage planned)
- Skip `sanitizeToolName()` (no MCP tools → no user-controlled tool names)

### 4.4 Tier 3: cache_edits (P2.8–P2.9)

**Deferred** — requires:
1. Anthropic `cache_edits` API feature gate availability
2. Phase 3 compaction subsystem (need compacted context to know what to delete)
3. Pinned-edit state management across turns

### 4.5 What NOT to Absorb

| Claude Code Feature | Reason to Skip |
|---------------------|----------------|
| `Bun.hash()` / Bun-specific fallback | TriMMC uses Node.js; use `crypto.createHash('sha256')` |
| GrowthBook feature flag gating | TriMMC uses env vars or config |
| Mycro-specific single-marker reasoning | Non-Mycro backend, but the single-marker pattern is still correct API usage |
| `autoModeActive` / `isUsingOverage` / `cachedMCEnabled` tracking | Claude Code-specific features |
| `AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS` type branding | Claude Code's analytics privacy type; TriMMC can use plain strings |
| Agent/sub-agent tracking key isolation | No sub-agents in TriMMC yet; add when Phase 3 absorbed |
| Fire-and-forget fork handling (`skipCacheWrite`) | No forked queries in TriMMC yet |
| `sanitizeToolName()` for MCP tools | No MCP tools in TriMMC yet |
| `isExcludedModel()` for haiku | No haiku usage planned |

---

## 5. Key Design Decisions

1. **Start with 5min TTL only**: 1h requires user eligibility logic (ant/subscriber detection) that TriMMC doesn't have. 5min covers the common case of rapid turns within a session.

2. **Skip scope/org caching**: TriMMC has no org/multi-user concept. All cache is per-user (no scope annotation needed initially).

3. **Aggregate tool hash before per-tool**: Claude Code computes per-tool hashes lazily — only when the aggregate tool hash changed (L284–286). TriMMC can start with aggregate-only and add per-tool later.

4. **Console log before analytics**: Claude Code fires `tengu_prompt_cache_break` to BQ with 31 fields. TriMMC should start with structured console logging and add analytics sink later.

5. **cache_edits deferred to post-Phase 3**: Deleting cached content requires knowing what to compact, which requires the compaction subsystem (Phase 3). The cache annotation + break detection layers are independently valuable.

6. **Use `crypto.createHash('sha256')` not Bun.hash**: Claude Code uses `Bun.hash()` with a `djb2Hash` fallback (L171–178). TriMMC should use Node.js native `crypto.createHash('sha256')` — cryptographically stronger and doesn't need Bun.

7. **OR threshold is correct API behavior**: The "no break" condition `(cacheReadTokens >= 95% of prev) OR (tokenDrop < 2,000)` means only report a break when **both** the percentage drop is significant **and** the absolute token count is meaningful. This prevents noise from small absolute drops (e.g., 50% of a 100-token baseline) and from large-but-proportional fluctuations.

---

## 6. Risk Analysis

| Risk | Probability | Impact | Mitigation |
|------|------------|--------|------------|
| Anthropic API rejects cache_control on model not supporting it | Low | Medium | Feature-detect model support; skip annotation for unsupported models |
| Incorrect breakpoint placement causes cache misses | Medium | Low | Start with last-message-only; validate with `cache_read_input_tokens > 0` |
| cache_reference on wrong blocks causes 400 errors | Low | High | Strict "before last cache_control" boundary; test with small message arrays |
| State tracking Map memory leak | Low | Low | 10-source LRU cap (same as Claude Code) |
| 1h TTL causes unexpected breaks when session pauses > 1h | Low | Low | Start with 5min TTL only; add 1h when config system matures |
| OR threshold over-suppresses real breaks | Low | Medium | The 2000-token floor prevents real large breaks from being missed; the 95% threshold catches proportional drops |
| Missing `defer_loading` filtering causes false tool-change breaks | N/A (no MCP) | Low | Add filtering when MCP tools are introduced |

---

## 7. Dependencies

### Upstream (must absorb first)
- None — cache annotation is a leaf capability that modifies only the API request format

### Downstream (blocked by this)
- **Phase 3 (Sub-Agent Tree)**: Sub-agents share the main thread's cache; break detection per-source isolation needed
- **Cost optimization**: All future input-token cost analysis depends on cache hit rate baselines
- **Performance observability**: Cache break events are essential for debugging API call cost variance

### Co-requisites
- **Phase 1 (Core Loop)**: Cache annotation happens inside the loop body; Phase 1 must be partially complete for integration
- **Observability infrastructure**: Cache break events need a logging sink

---

## 8. Source File Index

| File | Lines | Role in Cache System |
|------|-------|---------------------|
| `claude.ts` | 3419 | `getCacheControl()` L358–374, `should1hCacheTTL()` L376–435, `buildSystemPromptBlocks()` L3213–3237, `addCacheBreakpoints()` L3063–3211, `userMessageToMessageParam()` L588–631, `assistantMessageToMessageParam()` L633–674, `recordPromptState` call L1460–1486, `checkResponseForCacheBreak` call L2382–2392, global cache strategy L1207–1229, cachedMC latching L1431–1439 |
| `promptCacheBreakDetection.ts` | 726 | `recordPromptState()` L247–430, `checkResponseForCacheBreak()` L437–666, `notifyCacheDeletion()` L673–682, `notifyCompaction()` L689–698, `cleanupAgentTracking()` L700–702, `resetPromptCacheBreakDetection()` L704–706, `getTrackingKey()` L149–158, `computeHash()` L170–179, `sanitizeToolName()` L183–185, `isExcludedModel()` L129–131 |
| `cachedMicrocompact.ts` | ~200 | Fine-grained cache eviction via cache_edits; `isCachedMicrocompactEnabled()`, `isModelSupportedForCacheEditing()` |
| `cachedMCConfig.ts` | ~50 | GrowthBook feature flags for cached microcompact |
| `timeBasedMCConfig.ts` | ~50 | Time-based triggering thresholds |
| `bootstrap/state.ts` | ~250 | `getPromptCache1hEligible()` / `setPromptCache1hEligible()`, `getPromptCache1hAllowlist()` / `setPromptCache1hAllowlist()` |
| `utils/systemPrompt.ts` | ~200 | `splitSysPromptPrefix()` — splits system prompt into cacheable blocks with `cacheScope` metadata |

---

## 9. 小柯 Verification Checklist

| ID | Claim | Source Reference | Status |
|----|-------|-----------------|--------|
| V-001 | `getCacheControl()` returns `{ type: 'ephemeral', ttl?: '1h', scope?: 'global' }` | claude.ts L358–374 | ✅ |
| V-002 | `should1hCacheTTL()` gates on USER_TYPE ant OR subscriber w/o overage | claude.ts L406–412 | ✅ |
| V-003 | 1h TTL eligibility is latched session-stable via bootstrap state | claude.ts L403–406, L415–416 | ✅ |
| V-004 | GrowthBook allowlist supports `*` wildcard prefix matching | claude.ts L427–431 | ✅ |
| V-005 | Default TTL is 5min (Anthropic server-side, no `ttl` field in cache_control) | claude.ts L369 (only ttl when should1h true) | ✅ |
| V-006 | `buildSystemPromptBlocks()` applies per-block `cache_control` via `splitSysPromptPrefix` cacheScope | claude.ts L3221–3236 | ✅ |
| V-007 | `skipGlobalCacheForSystemPrompt` suppresses global-scope blocks | claude.ts L3222–3223 | ✅ |
| V-008 | `addCacheBreakpoints()` places exactly ONE cache_control marker per request | claude.ts L3078–3089 | ✅ |
| V-009 | Marker on last message for normal calls, second-to-last for `skipCacheWrite` forks | claude.ts L3089 | ✅ |
| V-010 | `cache_reference` on tool_result blocks strictly BEFORE last cache_control marker | claude.ts L3180–3188 (`i < lastCCMsg`) | ✅ |
| V-011 | Tool_result annotation creates new objects (never mutates in-place) | claude.ts L3185–3186, L3197–3204 | ✅ |
| V-012 | `assistantMessageToMessageParam` skips thinking/connector blocks for last-block detection | claude.ts L658–661 | ✅ |
| V-013 | Global cache strategy: `'none'` when MCP tools exist, `'system_prompt'` otherwise | claude.ts L1225–1229 | ✅ |
| V-014 | `prompt_caching_scope` beta header added when global cache enabled | claude.ts L1216–1221 | ✅ |
| V-015 | `recordPromptState()` captures 15-dimension snapshot before API call | promptCacheBreakDetection.ts L247–295 | ✅ |
| V-016 | `checkResponseForCacheBreak()` uses **OR** threshold: `(>= 95%) OR (< 2000 token drop)` → no break | promptCacheBreakDetection.ts L486–488 | ✅ Corrected from v1 |
| V-017 | `cacheDeletionsPending` flag prevents false-positive on cache_edits-induced drop | promptCacheBreakDetection.ts L473–481 | ✅ |
| V-018 | Time-based TTL detection uses last assistant message timestamp | promptCacheBreakDetection.ts L458–463 | ✅ |
| V-019 | 5-level break classification: cacheDeletions → client changes → 1h TTL → 5min TTL → server-side | promptCacheBreakDetection.ts L578–588 | ✅ |
| V-020 | `tengu_prompt_cache_break` fires 31-field analytics event | promptCacheBreakDetection.ts L590–644 | ✅ |
| V-021 | MCP tool names sanitized to `'mcp'` in analytics (prevents path leakage) | promptCacheBreakDetection.ts L183–185, L608–622 | ✅ |
| V-022 | Haiku models excluded from break detection via `isExcludedModel()` | promptCacheBreakDetection.ts L129–131, L453 | ✅ |
| V-023 | `autoModeActive`, `isUsingOverage`, `cachedMCEnabled` tracked but NOT break causes | promptCacheBreakDetection.ts L47–55 | ✅ |
| V-024 | `notifyCompaction()` resets `prevCacheReadTokens = null` | promptCacheBreakDetection.ts L689–698 | ✅ |
| V-025 | LRU eviction: 10-source cap with Map insertion order (`keys().next().value`) | promptCacheBreakDetection.ts L107, L300–303 | ✅ |

**Final: 25/25 ✅ PASS**

---

*小全分析完成。小柯逐行交叉验证通过。所有claim均可追溯到源文件行号。*
