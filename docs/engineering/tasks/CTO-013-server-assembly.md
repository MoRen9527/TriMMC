# CTO-013: Server Assembly — Pipeline wired into HTTP API

## Status: COMPLETE

## Overview

Wire the four v0.2.0 orchestration components (Soul Loader, Memory Injector, Context Builder, Tool Gater) into the `POST /internal/v1/agent` HTTP endpoint via a production-grade pipeline assembler module.

## Deliverables

- [x] `src/pipeline/assemble.ts` — Pipeline assembler module
- [x] `src/server/app.ts` — Updated `/internal/v1/agent` with contract-based pipeline
- [x] `src/config/env.ts` — Added `cwd` and `memdirPath` to TriMMCEnv
- [x] `docs/registry/code-state.md` — Updated

## Architecture

```
POST /internal/v1/agent { contract: AgentContract }
  → assemblePipelineOptions()
    → Soul Loader: contract → systemPrompt + ContextSources
    → Memory Injector: contract → SoulMemory → memdir/ (if TRIMC_MEMDIR set)
    → Context Builder: merge context into prompt
    → Tool Gater: toolSpecs passed through
    → AgentLoopOptions → agentLoop()
```

### Backward Compatibility

Without `contract` field → existing behavior (model/systemPrompt/messages directly to agentLoop).

### Memory Injection (Optional)

Controlled by `TRIMC_MEMDIR` env var. When set, injects soul memory, episodic memories, colleagues, and social graph into memdir/. When unset, memory layer is skipped entirely.

## Files Changed

| File | Change |
|------|--------|
| `src/pipeline/assemble.ts` | NEW — Pipeline assembler (112 lines) |
| `src/server/app.ts` | MODIFIED — Agent endpoint now supports `contract` field |
| `src/config/env.ts` | MODIFIED — Added `cwd` and `memdirPath` fields |

## Gate Result

- 240/240 tests passing
- tsc --noEmit: clean
