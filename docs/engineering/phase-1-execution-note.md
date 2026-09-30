# TriMMC Phase 1 & 2 CTO Execution Note

**Author**: CTO 小狄
**Date**: 2026-07-13 (Phase 1) / 2026-07-14 (Phase 2)
**Status**: Phase 2 Complete
**Reference**: CPO+CTO Joint Review (2026-07-13)

---

## Executive Summary

Phase 1 delivered TriMMC's own while-true agent loop, absorbed from Claude Code 2.1.88 vendor pattern, using TriModel/DeepSeek as the model provider with tool-calling support. Six built-in tools registered. Agent endpoint wired into TriMMC server. Zero Anthropic SDK dependencies across both TriMMC and TriModel codebases.

---

## Deliverables

### 1. Agent Loop (`src/agent-loop/loop.ts`)
- `agentLoop()` async generator following Claude Code `queryLoop` pattern
- Uses TriModel `modelClient.chat()` with `tools` array (Anthropic-compatible schema)
- State management: messages, turnCount, maxTurns (default 25)
- Emits 8 event types via `AsyncGenerator<AgentEvent>`
- `runAgentLoop()` convenience wrapper for non-streaming use

### 2. Built-in Tool Registry (`src/agent-loop/tools.ts`)
6 tools registered:
| Tool | Description | Execution |
|------|-------------|-----------|
| `read_file` | Read file contents | `fs.readFile` |
| `write_file` | Create/overwrite file | `fs.writeFile` with parent dir creation |
| `edit_file` | String replacement in file | Read → replace (unique match) → write |
| `shell_exec` | Run shell command | `child_process.execSync` (30s timeout) |
| `glob_search` | File pattern search | `glob` library |
| `task` | Delegate to sub-agent | Placeholder warning (future) |

### 3. Agent Endpoint (`POST /internal/v1/agent`)
- Route: `POST /internal/v1/agent`
- Body: `{ model?, systemPrompt?, messages?, maxTurns? }`
- Response: JSON array of all agent events (non-streaming for Phase 1)

### 4. TriModel Fixes (Pre-existing Regressions)
- `ToolCall` and `ToolDefinition` re-exported from `src/index.ts`
- `DeepSeekProvider` constructor call fixed in `client.ts` (config → config.deepseekApiKey, config.deepseekBaseUrl)
- Test constructor arg + null-safe content access fixed

---

## Verification Results

| Gate | Result |
|------|--------|
| TriModel build (`tsc -p tsconfig.json`) | ✅ Pass |
| TriMMC build (`tsc -p tsconfig.json`) | ✅ Pass |
| TriMMC tests (10 suites, 34 tests) | ✅ All pass |
| Agent tools tests (11 tests) | ✅ All pass |
| De-anthropic audit — TriMMC | ✅ Zero references found |
| De-anthropic audit — TriModel | ✅ Protocol format refs only (TriStaciss compat), no SDK |

---

## Architecture Decisions

1. **No Anthropic SDK**: TriMMC uses TriModel (DeepSeek provider), not Anthropic. The Claude Code 2.1.88 vendor absorption is pattern-level only (while-true loop, tool dispatching), not SDK-level.
2. **OpenAI function-calling format**: Tools use Anthropic-compatible `ToolDefinition` schema at the API layer; TriModel's DeepSeek provider translates to OpenAI function-calling format internally.
3. **Non-streaming Phase 1**: Agent endpoint returns JSON array, not SSE. Streaming planned for later phase.

---

## CPO Joint Review — Captured Outcomes

Per CPO (小乔) review:
- **L4 临时验证器**: Inserted into 4 IPD gateway types. Destruction condition: 10 IPD flows without use → decision to admit permanently or destroy. (Relaxed from original 5 IPD flows per CPO review.)
- **测试岗位 (Test Engineer)**: Personality-type agent, CTO subordinate. Reports to CTO acting until formal handoff. Not a registry agent — has personality, judgment, and collaborative character.
- **P0 (IPD gate unblock)**: Contract resolver + agent contracts → DONE
- **P1 (本月)**: Agent loop + tools + endpoint → DONE (this note)
- **P2 (后续迭代)**: Streaming, task delegation, policy gate hardening → not started

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `shell_exec` tool has no sandbox | High | High | Phase 2: policy gate whitelist/blacklist |
| `task` tool is placeholder | Certain | Low | Phase 2: implement sub-agent dispatch |
| No SSE streaming on agent endpoint | N/A | Medium | Phase 2: add SSE event stream |
| TriModel single-provider (DeepSeek) | Medium | Medium | Phase 2: add TriStaciss/fallback providers |

---

## Next Steps (Phase 2)

1. SSE streaming on agent endpoint
2. `task` tool implementation (sub-agent dispatch)
3. `shell_exec` policy gate integration
4. TriModel provider fallback (TriStaciss Anthropic-compatible endpoint)
5. Test engineer agent contract initialization under CTO acting

---

## Phase 2 Completion (2026-07-14)

### P2-1: SSE Streaming (`GET /internal/v1/agent/stream`)
- SSE event stream on agent endpoint using `asyncGeneratorToSSE()` adapter
- Generates `data:` frames with `event:` annotations (agent, tool, loop, chat, and error events)
- Includes `X-TriMMC-Stream-Version: 1` header in responses
- Resolves system prompt injection through `systemPrompt?.trim()` check
- 3 tests passing via HTTP fetch with AbortController cleanup

### P2-2: Task Tool Sub-Agent Dispatch
- `task` tool upgraded from placeholder to functional sub-agent dispatch
- Renamed `system.prompt.task` → `system/prompt/task` for filesystem-safe layout
- Creates independent agent loop with shared conversation snapshot
- Handles `agent.refusal` event as sub-agent polite decline
- 11 agent loop tests passing

### P2-3: Shell Exec Policy Gate
- `shellExecPolicy(from: string)` function with declarative allow-list
- Default `denyAll` gate returns `{allowed: false, reason: "Policy not configured"}`
- `duringTest` gate runs allow-list with `echo`, `node`, and `tsx` commands
- Factory pattern: `shellExecPolicyFor(callerId: string)`
- Denied commands: `rm `, `rmdir`, `del `, `format`, `> /dev/`, `/dev/null`
- 13 tool tests passing

### P2-4: TriModel TriStaciss Provider Fallback
- `TriStacissProvider` added to TriModel provider registry
- Cross-provider fallback: DeepSeek → TriStaciss (Anthropic-compatible) with 3-retry logic
- `maxRetries` and `retryDelay` config options on TriModel client
- `modelId` passthrough to provider for full control
- 15 TriModel tests passing

### P2-5: TestEngineer Agent Contract
- Source-side 5-file kit: `TriCompany/.github/source-agents/test-engineer/`
  - soul.md (小柯 — meticulous, quality-focused)
  - memory.md (memory layer contract)
  - colleagues.md (reports to CTO acting, peers with RAndDTrainer)
  - social.md (social layer contract)
  - agent.md (main source-side agent definition)
- Contract YAML: `TriCompany/docs/registry/TestEngineer.contract.yaml`
  - Identity: 小柯, Test Engineer
  - Tools: read(low), search(low), edit(medium, approval), execute(high, CTO approval, scoped to test runners)
  - Decision: PASS / CONDITIONAL_PASS / FAIL
- Host binding: `TriCompany/.github/binding-profiles/test-engineer.json`
- Live entry: `TriMetaverse/.github/agents/test-engineer.agent.md`
  - `tools: [read, search, edit, execute]`
  - `user-invocable: true`

### Server Lifecycle Fixes
- `createTriMMCApp()` now returns `{ start, stop, port }` with clean server lifecycle
- Tests use `port: 0` (OS-assigned) + `app.port` getter + `await app.stop()` in async `after()` hooks
- `--test-concurrency=1` serializes test files to prevent port conflicts
- All 55 tests pass consistently

### Verification Results (Final)

| Gate | Result |
|------|--------|
| TriMMC tests (12 suites, 55 tests) | ✅ 55/55 pass, 0 fail |
| SSE streaming | ✅ 3 tests |
| Agent loop + tools | ✅ 11 tests |
| Shell exec policy | ✅ 13 tests |
| Chat endpoint | ✅ 4 tests |
| Contract resolver | ✅ 3 tests (CTO + batch + edge, TestEngineer loads correctly) |
| TriModel tests (5 suites, 15 tests) | ✅ 15/15 pass, 0 fail |
| Contract resolver: TestEngineer contract | ✅ Loaded, identity.display_name: "小柯" |
| 5 C-level contracts (display_name补齐) | ✅ 待命名（源侧soul.md未命名，CEO/CPO后续正式命名） |

### Risk Register Update

| Risk | Before (Phase 1) | After (Phase 2) |
|------|-----------|------------|
| `shell_exec` sandbox | No sandbox | Policy gate with allow-list in place |
| `task` tool placeholder | Placeholder | Functional sub-agent dispatch |
| No SSE streaming | JSON only | SSE event stream live |
| Single provider | DeepSeek only | TriStaciss fallback with 3-retry |

---

## Sources

- `D:\OneDrive\Code\ai\TriMMC\src\agent-loop\loop.ts`
- `D:\OneDrive\Code\ai\TriMMC\src\agent-loop\tools.ts`
- `D:\OneDrive\Code\ai\TriMMC\src\server\app.ts`
- `D:\OneDrive\Code\ai\TriModel\src\types.ts`
- `D:\OneDrive\Code\ai\TriModel\src\providers\deepseek.ts`
- CPO+CTO Joint Review, 2026-07-13
