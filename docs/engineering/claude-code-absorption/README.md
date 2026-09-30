# Claude Code Absorption Analysis

> **Owner**: CTO 小狄 (CTO-003)
> **Status**: Phase 1–4 Complete (25/25 PASS each, 小全+小柯 verified)
> **Source**: Claude Code 2.1.88 vendor (`TriMMC/vendor/claude-code/src/`)
> **Target**: TriMMC agent architecture (`TriMMC/src/agent-loop/`)

## Overview

| Phase | Document | Lines | v2? | Status |
|-------|----------|-------|-----|--------|
| 1 | [Core Loop](./phase-1-core-loop-v2.md) | ~550 | ✅ | 25/25 PASS |
| 2 | [Prompt Cache](./phase-2-prompt-cache-v2.md) | ~650 | ✅ | 25/25 PASS |
| 3 | [Sub-Agent Tree](./phase-3-subagent-tree-v2.md) | ~320 | ✅ | 25/25 PASS |
| 4 | [Tool & Permission](./phase-4-tool-permission.md) | ~500 | — | Complete |

## Absorption Tiers

```
Tier 1 (MVP)           Tier 2 (Optimize)        Tier 3 (Observe)         Tier 4 (Extend)
─────────────────────  ───────────────────────  ───────────────────────  ───────────────────────
Phase 1: Loop core     Phase 1: Compaction      Phase 1: Hooks/Attach    —
Phase 2: Cache annot.  Phase 2: Break detect    Phase 2: cache_edits     —
Phase 3: Agent spawn   Phase 3: Fork+Worktree   Phase 3: Memory/Resume   Phase 3: Custom/Plugin
Phase 4: Tool registry Phase 4: Auto-approve    Phase 4: —               Phase 4: Plugin tools
```

## Key Findings

1. **TriMMC currently at 0–15% of Claude Code's agent infrastructure**
   - Loop: ~10-15% (basic while-true, no streaming/compaction/hooks)
   - Cache: 0% (no cache_control markers)
   - Sub-agent: 0% (no AgentTool, no spawn router)
   - Tools: ~30% (6 basic tools, no permission/approval system)

2. **Fork sub-agent = key architectural insight**
   - Shares parent's system prompt + cached prefix → zero extra token cost
   - Uses `buildForkedMessages()` with FORK_PLACEHOLDER_RESULT for byte-level cache alignment

3. **3-layer prompt cache architecture**
   - Annotation (cache_control markers) → Detection (pre/post snapshot delta) → Deletion (cache_edits)

4. **6-continue-site loop with hierarchical error recovery**
   - Tier 1: model hiccup retry → Tier 2: model swap fallback → Tier 3: session terminate

## Source Map

```
vendor/claude-code/src/
├── query.ts (1730 lines)                  — Phase 1: main agent loop
├── query/
│   ├── config.ts                          — Phase 1: loop configuration
│   ├── deps.ts                            — Phase 1: dependency injection
│   ├── stopHooks.ts (474 lines)           — Phase 1: stop hook system
│   └── tokenBudget.ts (94 lines)          — Phase 1: token budget tracking
├── services/api/
│   ├── claude.ts (3419 lines)             — Phase 2: cache annotation + API layer
│   └── promptCacheBreakDetection.ts (726) — Phase 2: cache break detection
├── services/compact/
│   └── cachedMicrocompact.ts              — Phase 2: cache_edits (Layer 3)
├── utils/systemPrompt.ts                  — Phase 2: system prompt splitting
├── tools/AgentTool/
│   ├── AgentTool.tsx (1200+ lines)        — Phase 3: agent spawn router
│   ├── runAgent.ts (900+ lines)           — Phase 3: agent execution
│   ├── loadAgentsDir.ts                   — Phase 3: agent loading pipeline
│   ├── agentToolUtils.ts                  — Phase 3: tool pool resolution
│   ├── forkSubagent.ts (211 lines)        — Phase 3: fork cache sharing
│   ├── agentMemory.ts (175 lines)         — Phase 3: agent memory
│   ├── agentMemorySnapshot.ts (160+ lines)— Phase 3: memory snapshots
│   ├── resumeAgent.ts                     — Phase 3: transcript + resume
│   ├── prompt.ts                          — Phase 3: system prompt builder
│   ├── builtInAgents.ts (72 lines)        — Phase 3: built-in catalog
│   └── built-in/*.ts                      — Phase 3: 6 built-in agents
└── constants/tools.ts                     — Phase 4: tool permission constants
```

## Method

All v2 documents use the **小全+小柯** method:
- **小全**: Complete source re-read with line-level tracing
- **小柯**: 25-item verification checklist with source-line cross-references
