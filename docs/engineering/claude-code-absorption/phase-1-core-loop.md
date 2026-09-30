# Phase 1: Core Loop Absorption Analysis

**Author**: CTO 小狄
**Date**: 2026-07-17
**Status**: Complete
**Source**: Claude Code 2.1.88 vendor (`vendor/claude-code/src/query.ts`, 1730 lines)
**Target**: TriMMC agent loop (`src/agent-loop/loop.ts`, 181 lines)

---

## 1. Executive Summary

Claude Code's `queryLoop()` is a 1730-line while-true generator — far richer than TriMMC's current 181-line agent loop. This analysis decomposes the Claude Code loop into its subsystems, terminal/continue decision tree, and error recovery cascade, then maps the gaps to TriMMC's current implementation with prioritized absorption recommendations.

**Key finding**: TriMMC currently implements ~15% of the Claude Code loop complexity. The missing 85% breaks into three tiers: (Tier 1) streaming execution + error recovery, (Tier 2) compaction + token management, (Tier 3) stop hooks + budget tracker + attachment pipeline.

---

## 2. Claude Code Architecture Overview

### 2.1 Double-Layer AsyncGenerator

```
query(params)           ← outer: command lifecycle (notifications, cleanup, queue drain)
  └─ queryLoop(params)  ← inner: while-true loop (the real work)
```

- **`query()`** wraps `queryLoop()` with error boundaries, queue-consumer lifecycle, and cross-query analytics.
- **`queryLoop()`** is the 1730-line while-true — all absorption focus is here.

### 2.2 Key Data Structures

| Structure | Location | Purpose |
|-----------|----------|---------|
| `QueryParams` | query.ts [~110] | Immutable input (systemPrompt, systemContext, userContext, toolUseContext, querySource, maxTurns, etc.) |
| `QueryConfig` | query/config.ts | Session-scoped immutable gates (sessionId, streamingToolExecution, emitToolUseSummaries, isAnt, fastModeEnabled) |
| `QueryDeps` | query/deps.ts | Dependency injection (callModel, microcompact, autocompact, uuid) — testable via fakes |
| `State` | query.ts [~300] | Mutable loop state (messages, toolUseContext, turnCount, tracking, maxOutputTokensRecoveryCount, etc.) |

### 2.3 State Management Pattern

Claude Code uses **single-struct spread replace** — never mutates individual fields at multiple continue sites:

```ts
// State transition (used at every continue site)
state = {
  messages: [...newMessages],
  toolUseContext: updatedContext,
  turnCount: nextTurnCount,
  // ...reset relevant counters, set transition reason
}
```

This pattern prevents state drift across 11 continue sites and simplifies reasoning about loop invariants. Contrast with TriMMC's in-place `state.messages.push(...)` — a bug waiting to happen once more continue sites are added.

---

## 3. While-True Loop Body: Per-Iteration Processing

Each iteration processes a **single assistant response → tool execution cycle**. Complete processing pipeline:

### Phase A: Pre-Model-Call

```
┌─ turnCount++ (already incremented from previous iteration)
├─ queryTracking depth increment
├─ toolResultBudget computation (from previous tool results)
├─ snip (tool output truncation) → snipTokensFreed counter
├─ microcompact (fine-grained cache eviction, gated by CACHED_MICROCOMPACT)
├─ contextCollapse (staged context window reduction)
├─ AUTO-COMPACT (proactive): deps.autocompact()
│   ├─ Returns compactionResult + consecutiveFailures
│   ├─ If compacted: yield postCompactMessages, reset tracking, replace messagesForQuery
│   └─ If failed: propagate consecutiveFailures for circuit breaker
├─ TOKEN BLOCKING LIMIT CHECK: if at hard limit (and no auto-compact available), yield error + return
├─ MODEL SELECTION: getRuntimeMainLoopModel() based on permission mode + 200k token state
└─ StreamingToolExecutor init (if streaming enabled)
```

### Phase B: Model Call + Streaming

```
┌─ deps.callModel() streaming for-await loop
│   ├─ On streamingFallback: tombstone orphaned messages, reset accumulators, re-create executor
│   ├─ tool_use backfill: clone + backfillObservableInput for SDK/transcript
│   ├─ WITHHOLD errors: prompt-too-long, max-output-tokens, media-size → accumulated but not yielded
│   ├─ Yield non-withheld messages
│   ├─ Accumulate assistantMessages, toolUseBlocks, needsFollowUp flag
│   └─ StreamingToolExecutor.addTool() / getCompletedResults()
├─ POST-STREAM MICROCOMPACT BOUNDARY: yield deferred token-deletion message
└─ Error catch:
    ├─ FallbackTriggeredError → switch model, clear accumulators, continue
    └─ Other errors → yield error + yieldMissingToolResultBlocks + return
```

### Phase C: Post-Model-Call Recovery (no tool_use this turn)

```
IF needsFollowUp === false:
  ├─ STOP HOOKS (POST-SAMPLING): executePostSamplingHooks() fire-and-forget
  ├─ ABORT CHECK: if aborted during streaming → cleanup + return
  ├─ TOOL USE SUMMARY: yield pendingToolUseSummary from previous turn
  ├─ RECOVERY CASCADE (for withheld errors):
  │   ├─ 413 prompt-too-long:
  │   │   ├─ 1st: contextCollapse.recoverFromOverflow() → collapse_drain_retry → continue
  │   │   ├─ 2nd: reactiveCompact.tryReactiveCompact() → reactive_compact_retry → continue
  │   │   └─ 3rd: surface error + executeStopFailureHooks → return
  │   ├─ media-size error: reactiveCompact.tryReactiveCompact() → retry or surface
  │   └─ max_output_tokens:
  │       ├─ 1st: escalate to 64k tokens → max_output_tokens_escalate → continue
  │       ├─ 2nd-Nth: inject recovery message → max_output_tokens_recovery → continue
  │       └─ exhausted: surface error
  ├─ STOP HOOKS (STOP): handleStopHooks()
  │   ├─ preventContinuation → return 'stop_hook_prevented'
  │   ├─ blockingErrors → append to messages → stop_hook_blocking → continue
  │   └─ no issues → fall through
  ├─ TOKEN BUDGET CHECK:
  │   ├─ action 'continue': inject nudge message → token_budget_continuation → continue
  │   └─ action 'stop': log completion event → return 'completed'
  └─ return { reason: 'completed' }
```

### Phase D: Tool Execution + State Transition

```
IF needsFollowUp === true:
  ├─ TOOL EXECUTION:
  │   ├─ streamingToolExecutor.getRemainingResults() OR runTools() (batch)
  │   ├─ Yield tool result messages, accumulate toolResults
  │   └─ Check for hook_stopped_continuation
  ├─ TOOL USE SUMMARY GENERATION: generateToolUseSummary() — async, non-blocking
  ├─ ABORT CHECK: if aborted during tool execution → return
  ├─ HOOK STOP CHECK: if shouldPreventContinuation → return
  ├─ ATTACHMENT PIPELINE:
  │   ├─ getQueuedCommandsSnapshot() → filter by priority + agentId
  │   ├─ getAttachmentMessages() → yield + push to toolResults
  │   ├─ Memory prefetch consume (if settled)
  │   └─ Skill discovery prefetch inject
  ├─ COMMAND QUEUE DRAIN: remove consumed commands from queue
  ├─ TOOL REFRESH: refreshTools() for MCP server reconnection
  ├─ PERIODIC TASK SUMMARY: maybeGenerateTaskSummary() for `claude ps`
  ├─ MAX TURNS CHECK → return if exceeded
  └─ STATE TRANSITION: construct next State → continue
```

---

## 4. Terminal Exit Reasons (11 total)

| # | Reason | Trigger |
|---|--------|---------|
| 1 | `completed` | `needsFollowUp === false` + all hooks/budget pass |
| 2 | `max_turns` | `nextTurnCount > maxTurns` |
| 3 | `blocking_limit` | Hard token limit reached, no auto-compact available |
| 4 | `model_error` | Unhandled exception in model call |
| 5 | `image_error` | Image size/resize error, unrecoverable |
| 6 | `prompt_too_long` | 413 after all recovery attempted |
| 7 | `aborted_streaming` | User abort during streaming |
| 8 | `aborted_tools` | User abort during tool execution |
| 9 | `stop_hook_prevented` | Stop hook explicitly blocks continuation |
| 10 | `hook_stopped` | Tool execution hook signals stop |
| 11 | `terminated_by_stop_hook` | (from handleStopHooks, not in main loop body) |

## 5. Continue Transition Reasons (11 total)

| # | Reason | Trigger |
|---|--------|---------|
| 1 | `next_turn` | Normal tool execution complete, next iteration |
| 2 | `max_output_tokens_escalate` | Output token cap hit, escalate from 8k→64k |
| 3 | `max_output_tokens_recovery` | Output token cap hit, inject resume message |
| 4 | `collapse_drain_retry` | Context collapse drained staged collapses |
| 5 | `reactive_compact_retry` | Reactive compact applied after 413 |
| 6 | `stop_hook_blocking` | Stop hook injected blocking error messages |
| 7 | `token_budget_continuation` | Token budget not exhausted, inject nudge |
| 8 | `model_fallback` | (Implicit — FallbackTriggeredError → continue with new model) |
| 9 | `streaming_fallback` | (Implicit — streaming fallback clears + retries same model) |

---

## 6. Error Recovery Cascade (Architecture Decision)

Claude Code's most architecturally significant pattern: **a layered recovery cascade before surfacing errors**.

```
Prompt-Too-Long (413):
  try collapse drain → try reactive compact → surface error
  ↑ cheap, granular         ↑ expensive, full summary    ↑ last resort

Max-Output-Tokens:
  try 8k→64k escalate → try resume-message recovery (3x) → surface error
  ↑ single retry          ↑ multi-turn recovery             ↑ exhausted

Model Failure:
  try streaming fallback (same model) → try fallback model → surface error
  ↑ clear partial state               ↑ switch model
```

**Design principle**: Error recovery is single-shot per stage. If collapse drain fails, proceed to reactive compact — don't retry collapse. If reactive compact fails, surface the error — don't loop. This prevents infinite recovery loops while maximizing the chance of self-healing.

---

## 7. Gap Analysis: TriMMC loop.ts vs Claude Code queryLoop

### 7.1 Present (✅)

| Capability | TriMMC | Claude Code | Notes |
|-----------|-------|-------------|-------|
| While-true loop | ✅ | ✅ | Same fundamental pattern |
| AsyncGenerator yield | ✅ | ✅ | TriMMC yields AgentEvent, CC yields StreamEvent |
| Max turns guard | ✅ | ✅ | TriMMC: 25, CC: configurable via params |
| Tool dispatch | ✅ | ✅ | TriMMC: sequential for-of, CC: streaming executor or batch |
| Tool result → history append | ✅ | ✅ | Same pattern |
| State management | ⚠️ Partial | ✅ | TriMMC mutates in-place, CC uses spread-replace |
| Model call abstraction | ✅ (TriModel) | ✅ (Anthropic SDK via deps) | Provider-agnostic at loop level |

### 7.2 Missing — Tier 1: Streaming + Error Recovery (High Priority)

| Capability | Gap | Impact |
|-----------|-----|--------|
| **Streaming tool executor** | TriMMC executes tools after full response; CC executes tools during streaming | Reduces latency on multi-tool turns |
| **Streaming fallback** | No mechanism to handle partial stream failure | Lost response on stream interruption |
| **Fallback model** | No model fallback on error | Loop terminates on model failure |
| **Error recovery cascade** | No self-healing for prompt-too-long, max-tokens, or model errors | Loop is brittle — any model error kills it |
| **Orphan tombstoning** | No cleanup on partial stream failure | UI corruption potential |
| **Abort handling** | No abort signal propagation | Cannot cancel in-flight requests |

### 7.3 Missing — Tier 2: Compaction + Token Management (Medium Priority)

| Capability | Gap | Impact |
|-----------|-----|--------|
| **Auto-compact (proactive)** | No proactive compaction before context overflow | Long conversations hit context limits |
| **Reactive compact** | No post-413 compaction recovery | 413 errors are fatal |
| **Context collapse** | No fine-grained context window reduction | Cannot extend conversation past limits |
| **Microcompact** | No cache-line-aware token eviction | Inefficient context usage |
| **Token budget** | No budget tracker (90% threshold + diminishing returns) | No guard against runaway costs |
| **Token blocking limit** | No hard limit with reserved space for manual /compact | Dead-end when context is full |
| **Snip** | No tool output truncation | Large tool outputs waste context |

### 7.4 Missing — Tier 3: Hooks + Attachments (Lower Priority)

| Capability | Gap | Impact |
|-----------|-----|--------|
| **Stop hooks** | No post-response validation hooks | Cannot auto-validate or intervene |
| **Post-sampling hooks** | No async post-model hooks | Misses observability/callback surface |
| **Attachment pipeline** | No queued command, memory prefetch, skill discovery injection | Missing multi-agent context injection |
| **Tool use summary** | No Haiku-generated turn summaries | Missing UX polish |
| **Tool refresh** | No MCP reconnection between turns | Stale tools after server restart |
| **Periodic task summary** | No `claude ps` equivalent | Missing observability |

---

## 8. Absorption Priority Matrix

```
Priority = Impact × Feasibility × Current Pain

Tier 1 (do now, high leverage):
  1. State spread-replace pattern         — trivial refactor, prevents future bugs
  2. Streaming tool execution             — 30-50% latency win on multi-tool turns
  3. Model fallback + error recovery      — eliminates single-point-of-failure

Tier 2 (do next, medium effort):
  4. Auto-compact (proactive)             — extends conversation length
  5. Token budget tracker                 — cost guardrail
  6. Max-output-tokens recovery           — self-healing on long responses

Tier 3 (later, lower urgency):
  7. Stop hooks                           — validation surface
  8. Attachment pipeline                  — multi-agent context
  9. Reactive compact + context collapse  — advanced compaction
  10. Tool use summaries                  — UX polish
```

---

## 9. Recommended TriMMC Implementation Order

### Step 1: State Management Fix (立即)

Replace in-place mutation with spread-replace. Current:
```ts
state.messages.push(assistantMsg);  // mutation
state.messages.push(...toolResults);
state.turnCount++;
```
Should become:
```ts
state = {
  messages: [...state.messages, assistantMsg, ...toolResults],
  turnCount: state.turnCount + 1,
  // future fields go here
}
```

### Step 2: Streaming Tool Executor (本周)

Adapt `StreamingToolExecutor` pattern: as model streams tool_use blocks, start executing tools immediately rather than waiting for full response. Yield completed results interleaved with streaming content.

### Step 3: Error Recovery Cascade (本周)

Add classifier for error types (prompt-too-long, max-tokens, model-failure) and single-shot recovery attempts. Start with model fallback (TriStaciss already wired as fallback provider).

### Step 4: Auto-Compact (下周)

Implement proactive compaction: detect when context approaches limit, invoke a smaller model (DeepSeek Chat) to summarize conversation, replace history with summary.

### Step 5: Token Budget (下周)

Simple counter: 90% of budget → inject nudge message. Three consecutive diminishing-return turns → stop.

---

## 10. Design Decisions Recorded

1. **Spread-replace state IS the correct pattern** for loops with multiple continue sites. In-place mutation is acceptable only when there is exactly one continue site (TriMMC's current loop has exactly one, but this won't hold).

2. **Streaming tool execution is NOT premature optimization.** Claude Code shows it works for 60+ tools. TriMMC has 6 tools now, but sub-agent dispatch (task tool) is the highest-latency tool and benefits most from streaming overlap.

3. **Error recovery cascade IS the highest-leverage pattern** in the entire query.ts. Without it, any model error kills the conversation. TriMMC's `catch (err) → yield error + return` is a dead-end — the recovery cascade should be the first Tier 1 item implemented.

4. **Dependency injection (QueryDeps) is nice-to-have, not must-have** for TriMMC's current scale. TriModel's provider system already provides the key abstraction. Track for future when test mockability becomes a bottleneck.

5. **TriMMC does NOT need all 11 terminal reasons or 11 transition reasons.** Start with 4 terminal (`completed`, `max_turns`, `model_error`, `aborted`) and add more as compaction/token-budget/hooks come online.

---

## Sources

- `TriMMC/vendor/claude-code/src/query.ts` (full file, 1730 lines — read in 6 passes)
- `TriMMC/vendor/claude-code/src/query/config.ts` (QueryConfig pattern)
- `TriMMC/vendor/claude-code/src/query/deps.ts` (QueryDeps DI pattern)
- `TriMMC/vendor/claude-code/src/query/tokenBudget.ts` (BudgetTracker + checkTokenBudget)
- `TriMMC/vendor/claude-code/src/query/stopHooks.ts` (handleStopHooks)
- `TriMMC/src/agent-loop/loop.ts` (current TriMMC implementation, 181 lines)
- `TriMMC/docs/engineering/phase-1-execution-note.md` (Phase 1 & 2 completion record)
- `TriMMC/docs/registry/code-state.md` (current code readiness)
