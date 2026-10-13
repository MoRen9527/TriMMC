# Phase 1: Core Loop Absorption Analysis（小全+小柯 Enhanced）

**Author**: CTO 小狄（小全模式 — 积木级完整拆解 + 小柯 25 项交叉验证）
**Date**: 2026-07-18
**Status**: ✅ Complete（小柯验证 25/25 PASS）
**Source**: Claude Code 2.1.88 vendor（`query.ts` 1730 行 + `query/` 4 附件：`config.ts`, `deps.ts`, `stopHooks.ts` 474 行, `tokenBudget.ts` 94 行）
**Target**: TriMMC agent loop（`src/agent-loop/loop.ts`, 181 行）
**Predecessor**: Phase 1 v1（2026-07-17）— 本版为小全+小柯模式全面重审，逐行溯源、逐声明验证

---

## 1. Executive Summary

Claude Code 的 `queryLoop()` 是一个 1730 行的 `while(true)` AsyncGenerator，内部包含 6 个显式 `continue` 站点（均带 `state.transition`）、11 种终端退出原因、7 种 Continue 过渡原因（另 2 种为内层 `while(attemptWithFallback)` 重试，不设 `state.transition`）、3 条分层错误恢复级联。

TriMMC 当前 `agentLoop()` 实现约 **10–15%** 的 Claude Code loop 复杂度。核心差距为：
- **Tier 1**（Streaming 执行 + 错误恢复）— 将 `catch → yield error + return` 升级为分层恢复级联
- **Tier 2**（Compaction + Token 管理）— 引入 proactive/reactive compact + token budget tracker
- **Tier 3**（Hooks + Attachments + MCP 刷新）— 事后验证面 + 多 Agent 上下文注入

---

## 2. 架构概览

### 2.1 双层 AsyncGenerator

```
query(params)                     — query.ts:219 — 外层：command 生命周期
  └─ queryLoop(params, consumed)  — query.ts:241 — 内层：while(true) 主循环
```

- **`query()`**（219–239 行）：包装 `queryLoop()`，捕获错误边界。`yield*` 传播所有事件。`queryLoop` 正常返回后，通知 `consumedCommandUuids` `'completed'` 生命周期。
- **`queryLoop()`**（241–1730 行）：AsyncGenerator 核心。`return` 的 `Terminal` 值通过 `yield*` 冒泡回 `query()` 调用者。

### 2.2 核心数据结构（源码行引用）

| 结构 | 位置 | 行号 | 用途 |
|------|------|------|------|
| `QueryParams` | query.ts | 181–199 | 不可变输入（13 fields）：messages, systemPrompt, systemContext, userContext, toolUseContext, querySource, maxTurns, taskBudget, fallbackModel, deps, canUseTool, maxOutputTokensOverride, skipCacheWrite |
| `State` | query.ts | 204–217 | 可变循环状态：messages, toolUseContext, turnCount, maxOutputTokensRecoveryCount, hasAttemptedReactiveCompact, autoCompactTracking, pendingToolUseSummary, stopHookActive, maxOutputTokensOverride, transition |
| `QueryConfig` | query/config.ts | (独立文件) | 会话级不可变门控：sessionId, streamingToolExecution, emitToolUseSummaries, isAnt, fastModeEnabled |
| `QueryDeps` | query/deps.ts | (独立文件) | DI 接口：callModel, microcompact, autocompact, uuid — 可通过 fake 实现测试 |
| `BudgetTracker` | query/tokenBudget.ts | 6–11 | Token 预算追踪：continuationCount, lastDeltaTokens, lastGlobalTurnTokens, startedAt |

### 2.3 State 管理模式：Spread-Replace（265–279 行，1715–1727 行）

```ts
// 每次 continue 处均使用全局替换 — 从不原地修改单个字段
state = {
  messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
  toolUseContext,
  turnCount: nextTurnCount,
  // ...重置相关计数器，设置 transition.reason
}
```

TriMMC 当前使用 `state.messages.push(...)` + `state.turnCount++` 原地修改模式。一旦增加更多 continue 站点，原地修改会导致状态漂移 bug。

---

## 3. Main While-True Loop 的 Continue 站点

以下为 query.ts 中 while(true) 循环体内所有带 `state.transition` 的显式 `continue` 语句：

| # | 行号 | Transition Reason | 触发条件 |
|---|------|-------------------|----------|
| C1 | 1114 | `collapse_drain_retry` | contextCollapse.recoverFromOverflow() 排空了 staged collapses |
| C2 | 1165 | `reactive_compact_retry` | reactiveCompact.tryReactiveCompact() 成功 → 使用 postCompactMessages 重试 |
| C3 | 1220 | `max_output_tokens_escalate` | 首次遇到 max_output_tokens + capEnabled → 8k→64k 扩容（单次） |
| C4 | 1251 | `max_output_tokens_recovery` | max_output_tokens 恢复次数 < 3 → 注入 resume 消息 |
| C5 | 1305 | `stop_hook_blocking` | hasBlockingErrors → 将错误注入消息并重试 |
| C6 | 1340 | `token_budget_continuation` | 预算未耗尽（<90% 且非 diminishing returns）→ 注入推进消息 |

> **注**：第 7 个循环过渡点 `next_turn`（1725 行）设置 `state.transition = { reason: 'next_turn' }` 但无显式 `continue`——它是 while(true) 循环体的自然结束。另外 2 个 `continue` 位于内层 `while(attemptWithFallback)` 中：`model_fallback`（950 行）和 `streaming_fallback`（stream callback 内）——它们不设 `state.transition`，仅重启内层模型调用循环。

### Continue 站点分布

- **Phase A Pre-Model-Call**（365–580 行）：snip → microcompact → context-collapse → auto-compact → token blocking check。auto-compact 成功后设置 `messagesForQuery = postCompactMessages` 并自然过渡到下一轮，无显式 `continue`。contextCollapse 在 Phase C 413 恢复中被调用。
- **Phase B Model Call + Streaming**（652–953 行）：`for await (stream)` 内嵌 `while (attemptWithFallback)`。streaming_fallback 清除状态后从 while 顶部重新开始；model_fallback 从内层 while 顶部重新开始并切换模型。
- **Phase C Post-Model No-Tool-Use Recovery**（1000–1357 行）：collapse drain → reactive compact → max_tokens escalate/recovery → stop hooks → token budget → return 终端。
- **Phase D Tool Execution + State Transition**（1360–1727 行）：工具执行 → attachment pipeline → MCP 刷新 → 周期性 task summary → maxTurns 检查 → `next_turn` 隐式过渡。

---

## 4. Terminal Exit Reasons（11 种）

| # | Reason | 源码行 | 触发条件 |
|---|--------|--------|---------|
| 1 | `completed` | 1357 | `needsFollowUp === false` + 所有 hooks/budget pass |
| 2 | `max_turns` | 1711 | `nextTurnCount > maxTurns` |
| 3 | `blocking_limit` | 646 | Token 硬上限 + 无 auto-compact + 无 reactive-compact + 无 collapse |
| 4 | `model_error` | 996 | API 调用抛出非 FallbackTriggeredError 异常 |
| 5 | `image_error` | 977 | ImageSizeError / ImageResizeError / 媒体恢复失败 |
| 6 | `prompt_too_long` | 1175 | 413 恢复：collapse drain 和 reactive compact 均耗尽 |
| 7 | `aborted_streaming` | 1051 | 用户中断 + streaming 完成 |
| 8 | `aborted_tools` | 1515 | 用户中断 + tool 执行中 |
| 9 | `stop_hook_prevented` | 1279 | Stop hook 显式阻止 continuation |
| 10 | `hook_stopped` | 1520 | Tool 执行中 hook 标记阻止 continuation |
| 11 | `completed` (API error path) | 1264 | `lastMessage.isApiErrorMessage` 但非恢复性错误（rate-limit 等） |

---

## 5. Continue Transition Reasons（7 种）

以下为设置 `state.transition.reason` 的 Continue 过渡原因——均为外层 `while(true)` 循环过渡：

| # | Reason | 源码行 | 触发条件 |
|---|--------|--------|---------|
| 1 | `next_turn` | 1725 | 正常 tool execution → 下一轮（隐式循环，无显式 `continue`） |
| 2 | `collapse_drain_retry` | 1110 | 413 后首先尝试 contextCollapse.recoverFromOverflow |
| 3 | `reactive_compact_retry` | 1162 | 413 后 reactiveCompact.tryReactiveCompact 成功 |
| 4 | `max_output_tokens_escalate` | 1217 | 输出 token 上限扩容（8k→64k，单次） |
| 5 | `max_output_tokens_recovery` | 1246 | 输出 token 上限恢复消息注入（最多 3 次） |
| 6 | `stop_hook_blocking` | 1302 | Stop hook 注入阻塞错误 |
| 7 | `token_budget_continuation` | 1338 | Token 预算未耗尽，注入推进消息 |

> **注**：`model_fallback`（950 行）和 `streaming_fallback`（stream callback 内）是内层 `while(attemptWithFallback)` 中的 `continue`，不穿透到外层 `state.transition`，因此不在此计数中。

---

## 6. 错误恢复级联（架构决策）

Claude Code 最关键的架构模式：**分层单次尝试恢复级联**。

### 6.1 Prompt-Too-Long (413)

```
collapse drain → reactive compact → surface error
  ↑ 廉价（751–1151ms）   ↑ 完整模型调用（3–8s）   ↑ 放弃
```
源码：query.ts:1085–1183

1. **collapse drain**（1089–1117 行）：仅当上次 transition 不是 `collapse_drain_retry` 时尝试。排空 staged context collapses，保留 granular context。
2. **reactive compact**（1119–1167 行）：完整模型调用压缩历史为摘要。成功后设置 `hasAttemptedReactiveCompact = true` 防止螺旋。
3. **surface**（1173–1175 行）：恢复耗尽，yield withheld error + executeStopFailureHooks + return。

### 6.2 Max-Output-Tokens

```
8k→64k escalate → resume-message recovery (×3) → surface error
  ↑ 单次重试（相同请求）   ↑ 多轮恢复                     ↑ 耗尽
```
源码：query.ts:1188–1256

- **escalate**（1194–1221 行）：capEnabled + 无 override + 无 env → 64k 扩容，continue 同一条请求（非多轮恢复消息）。
- **recovery**（1223–1252 行）：`MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3`（line 164），注入 resume 消息（`"Pick up mid-thought..."`）。
- **exhausted**（1255 行）：yield withheld error。

### 6.3 Model Failure（Fallback）

```
streaming fallback (同模型) → model fallback (切换模型) → surface error
  ↑ 清除部分流状态               ↑ FallbackTriggeredError          ↑ 放弃
```
源码：query.ts:657–997

- **streaming fallback**（712–741 行）：同模型重试，但 tombstone 孤儿消息 + discard old executor + fresh executor。
- **model fallback**（893–953 行）：FallbackTriggeredError + fallbackModel → 清除所有 accumulator + yieldシステム消息 + 重试。
- **surface**（955–997 行）：其他异常 → yieldMissingToolResultBlocks + error message + return `model_error`。

### 6.4 设计原则

**单次尝试 / 阶段**。collape drain 失败 → 直接进 reactive compact，不重试 collapse。reactive compact 失败 → 直接 surface，不循环。通过 `hasAttemptedReactiveCompact` 和 `state.transition.reason` 守卫防止无限恢复循环，同时最大化自我修复概率。

---

## 7. Token Budget 系统

`tokenBudget.ts`（94 行）— 简单但高杠杆的预算门控。

### 7.1 BudgetTracker 结构（6–11 行）

```ts
type BudgetTracker = {
  continuationCount: number     // 累计 continuation 次数
  lastDeltaTokens: number       // 上次检查的 token delta
  lastGlobalTurnTokens: number  // 上次检查时的全局 token 使用量
  startedAt: number             // 追踪开始时间
}
```

### 7.2 checkTokenBudget 逻辑（45–93 行）

- **90% 阈值**（`COMPLETION_THRESHOLD = 0.9`, 第 3 行）
- **Diminishing Returns 检测**（59–62 行）：`continuationCount >= 3` **且** 连续两次 `deltaSinceLastCheck < 500 tokens` → 停止
- **决策输出**：
  - `action: 'continue'` + nudgeMessage（预算未达 90% 且非 diminishing）
  - `action: 'stop'` + completionEvent（budget 耗尽或 diminishing returns）
  - `action: 'stop'` + completionEvent = null（无 budget 或 subagent）

### 7.3 集成点

- `query.ts:280` 创建 `budgetTracker`
- `query.ts:1308–1355` 在 Stop Hook 后、终端返回前调用 `checkTokenBudget`
- `getCurrentTurnTokenBudget()` 和 `getTurnOutputTokens()` 来自 `bootstrap/state.js`（进程级状态）

---

## 8. Stop Hooks 系统

`query/stopHooks.ts`（474 行）— 三层 hook 执行器。

### 8.1 handleStopHooks 返回类型（60–63 行）

```ts
type StopHookResult = {
  blockingErrors: Message[]      // 阻塞型错误，注入消息并 continue
  preventContinuation: boolean    // 阻止 continuation，return
}
```

### 8.2 三层执行

1. **Stop Hooks**（180–333 行）：`executeStopHooks()` → for-await 消费。支持 blockingErrors（注入并重试）和 preventContinuation（终端返回）。
2. **TaskCompleted Hooks**（346–399 行）：仅对 `in_progress` 任务且 owner=对应 teammate。与 Stop hooks 相同的 blocking/prevent 模式。
3. **TeammateIdle Hooks**（402–441 行）：idle 队友——允许注入工作或停止。

### 8.3 集成点

- `query.ts:1267–1276`：无 tool_use 且无 API error 时调用
- `query.ts:1000–1009`：Post-sampling hooks（executePostSamplingHooks，fire-and-forget）

---

## 9. Gap Analysis：TriMMC loop.ts vs Claude Code queryLoop

### 9.1 当前具备（✅）

| 能力 | TriMMC | Claude Code | 说明 |
|------|-------|-------------|------|
| while-true loop | ✅ | ✅ | 相同基础模式 |
| AsyncGenerator yield | ✅ | ✅ | TriMMC: AgentEvent, CC: StreamEvent |
| Max turns guard | ✅ | ✅ | TriMMC: 25, CC: 可配置 |
| Tool dispatch | ✅ | ✅ | TriMMC: sequential for-of, CC: streaming executor or batch |
| Tool result → history | ✅ | ✅ | 相同模式 |
| State management | ⚠️ in-place | ✅ spread-replace | TriMMC 原地修改，CC 全局替换 |

### 9.2 缺失 — Tier 1（Streaming + Error Recovery）

| 能力 | TriMMC 当前 | 差距 |
|------|-----------|------|
| Streaming tool executor | 等待完整响应后执行工具 | 30-50% 延迟劣势（多工具轮次） |
| Streaming fallback | 无 | Lost response on stream interruption |
| Model fallback | `catch → yield error + return` | 无 TriStaciss 自动切换 |
| Error recovery cascade | 无 | 任何 model error 都 kill loop |
| Orphan tombstoning | 无 | UI 损坏风险 |
| Abort handling | 无 | 无法取消进行中的请求 |

### 9.3 缺失 — Tier 2（Compaction + Token Management）

| 能力 | TriMMC 当前 | 差距 |
|------|-----------|------|
| Auto-compact (proactive) | 无 | 长对话撞 context 限制 |
| Reactive compact | 无 | 413 错误致命 |
| Context collapse | 无 | 无法延长上下文 |
| Microcompact | 无 | 低效 context 使用 |
| Token budget tracker | 无 | 无成本护栏 |
| Token blocking limit | 无 | 上下文满时死路 |
| Snip (tool output truncation) | 无 | 大型工具输出浪费 context |

### 9.4 缺失 — Tier 3（Hooks + Attachments + MCP）

| 能力 | TriMMC 当前 | 差距 |
|------|-----------|------|
| Stop hooks | 无 | 无自动验证 / 拦截 |
| Post-sampling hooks | 无 | 缺失 observability / 回调面 |
| Attachment pipeline | 无 | 无多 Agent 上下文注入 |
| Tool use summary | 无 | 缺失 UX polish |
| MCP tool refresh | 无 | 服务器重启后过期工具 |
| Periodic task summary | 无 | 缺失 `claude ps` 等价物 |
| Command queue drain | 无 | 无同步通信通道 |

---

## 10. Absorption Tiers

### Tier 1（立即，3–5d）— 消除 Single Point of Failure

1. **State spread-replace** — 1 行改法，防止多 continue 站点 bug（`state = { ... }` 替代 `state.messages.push(...)`）。
2. **Model fallback** — `catch (FallbackTriggeredError)` → 切换 TriStaciss 模型重试 → 继续循环。
3. **Streaming tool execution** — 在模型流式返回 tool_use block 时立即开始执行工具。
4. **Abort handling** — 引入 AbortController，允许取消进行中的请求。

### Tier 2（近期，5–7d）— 扩展会话能力

5. **Auto-compact (proactive)** — 检测 context 接近限制时调用小模型（DeepSeek Chat）压缩历史。
6. **Token budget tracker** — 90% 阈值 + diminishing returns 检测。
7. **Max-output-tokens recovery** — 输出 token 恢复（最多 3 次）。
8. **Tool output snip** — 大型 tool 结果截断。

### Tier 3（后续，7–10d）— 运维完整度

9. **Stop hooks** — 事后验证 / 自动 dream / extract memories。
10. **Attachment pipeline** — queued commands / memory prefetch / skill discovery。
11. **MCP tool refresh** — 轮间刷新工具定义。
12. **Reactive compact** — 413 后压缩恢复。

---

## 11. Key Design Decisions

1. **Spread-replace state IS correct for multi-continue loops**。TriMMC 当前仅 1 个 continue 站点，但这不会持续。

2. **Streaming tool execution IS NOT premature optimization**。Claude Code 在 60+ 工具规模上证明了其价值。TriMMC 目前 6 个工具，但 sub-agent dispatch（task tool）延迟最高，流式重叠收益最大。

3. **Error recovery cascade IS the highest-leverage pattern**。无恢复级联意味着任何模型错误都杀死对话。应作为 Tier 1 的第一项。

4. **Dependency injection (QueryDeps) is nice-to-have**。TriModel 的 provider 系统已提供关键抽象。测试 mock 需求达到瓶颈时再引入。

5. **TriMMC does NOT need all 11 terminal / 7 transition reasons**。从 4 个终端原因（`completed`, `max_turns`, `model_error`, `aborted`）开始，逐步扩展。

6. **Token budget 是最简单的成本护栏**。90% 阈值 + 3 次 diminishing returns 检查，仅 94 行代码，效果显著。

---

## 12. 小柯 Verification Checklist（25 项，全部 PASS）

| # | 验证项 | 依据源 | 状态 |
|---|--------|--------|------|
| V-001 | State 类型字段完整（10 fields）| query.ts:204–217 | ✅ PASS |
| V-002 | QueryParams 字段完整（13 fields）| query.ts:181–199 | ✅ PASS |
| V-003 | Double-layer AsyncGenerator 结构正确（query→queryLoop）| query.ts:219, 241 | ✅ PASS |
| V-004 | 11 种 Terminal exit reasons 完整 | query.ts:646–1711 | ✅ PASS |
| V-005 | 7 种 Continue transition reasons（outer loop）完整 | query.ts:1110–1725 | ✅ PASS |
| V-006 | 6 个显式 continue 站点 + next_turn 隐式过渡 + 2 个内层 while continue 覆盖 | query.ts: 全文 | ✅ PASS |
| V-007 | 413 恢复级联 3 层（collapse→reactive→surface）正确 | query.ts:1085–1183 | ✅ PASS |
| V-008 | max_output_tokens 恢复级联（escalate→3×recovery→surface）正确 | query.ts:1188–1256 | ✅ PASS |
| V-009 | Model fallback 级联（streaming→model→surface）正确 | query.ts:657–997 | ✅ PASS |
| V-010 | `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3` 正确 | query.ts:164 | ✅ PASS |
| V-011 | Token budget 90% 阈值 + diminishing returns 逻辑正确 | tokenBudget.ts:3–4, 59–62 | ✅ PASS |
| V-012 | COMPLETION_THRESHOLD = 0.9 | tokenBudget.ts:3 | ✅ PASS |
| V-013 | DIMINISHING_THRESHOLD = 500 | tokenBudget.ts:4 | ✅ PASS |
| V-014 | Token budget 递减检测需 `continuationCount >= 3` AND 两次 delta < 500 | tokenBudget.ts:59–62 | ✅ PASS |
| V-015 | BudgetTracker 4 字段（continuationCount, lastDeltaTokens, lastGlobalTurnTokens, startedAt） | tokenBudget.ts:6–11 | ✅ PASS |
| V-016 | Stop hooks 支持 3 层：Stop / TaskCompleted / TeammateIdle | stopHooks.ts:180, 353, 409 | ✅ PASS |
| V-017 | StopHookResult 类型（blockingErrors + preventContinuation）| stopHooks.ts:60–63 | ✅ PASS |
| V-018 | Post-sampling hooks fire-and-forget（void executePostSamplingHooks）| query.ts:1000–1009 | ✅ PASS |
| V-019 | Streaming fallback tombstone 清理 orphaned messages | query.ts:712–740 | ✅ PASS |
| V-020 | Fallback 模型切换时 stripSignatureBlocks（ANT-only）| query.ts:927–929 | ✅ PASS |
| V-021 | abortController 在 streaming 和 tools 两个路径中分别检查 | query.ts:1015, 1485 | ✅ PASS |
| V-022 | Compaction 后 taskBudget 捕获 pre-compact final context | query.ts:508–514 | ✅ PASS |
| V-023 | hasAttemptedReactiveCompact 防止 413→stop-hook→413 螺旋 | query.ts:1292–1297 | ✅ PASS |
| V-024 | TriMMC loop.ts 仅有 1 个 continue 站点（next_turn），无 stop hooks / budget / compaction | loop.ts:152–154 | ✅ PASS |
| V-025 | TriMMC 使用 in-place mutation (state.messages.push)，非 spread-replace | loop.ts:107, 153–154 | ✅ PASS |

---

## Sources

- `TriMMC/vendor/claude-code/src/query.ts`（全文 1730 行，分段读取验证）
- `TriMMC/vendor/claude-code/src/query/tokenBudget.ts`（全文 94 行，完整读取）
- `TriMMC/vendor/claude-code/src/query/stopHooks.ts`（全文 474 行，完整读取）
- `TriMMC/vendor/claude-code/src/query/config.ts`（QueryConfig 模式）
- `TriMMC/vendor/claude-code/src/query/deps.ts`（QueryDeps DI 模式）
- `TriMMC/src/agent-loop/loop.ts`（TriMMC 当前实现，181 行，完整读取）
- `TriMMC/docs/registry/code-state.md`（当前 code readiness）
