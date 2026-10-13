# Phase 3: Sub-Agent Tree Absorption Analysis (v2 — 小全+小柯)

**Author**: CTO 小狄（小全深度源码重读 + 小柯 25 项交叉验证）
**Date**: 2026-07-18
**Status**: Complete — 25/25 PASS
**Source**: Claude Code vendored (`src/tools/AgentTool/`, 15 files)
**Predecessor**: `phase-3-subagent-tree.md` (v1, 2026-07-18)
**Method**: 小全 source-level re-read + 小柯 25-item verification with source-line cross-references

---

## 1. Executive Summary

Claude Code 的 sub-agent 系统是分层分工体系的核心——从"单体 agent"升级到"树形多 agent 协同"。TriMMC 当前 sub-agent 基础设施：**0%**。

Phase 3 v2 通过小全模式重新深度阅读了全部 15 个源文件，逐行验证 v1 文档的每个技术声明。发现 v1 文档存在 **3 处需要修正的结论**，其余框架性分析基本正确。

**核心架构**：
```
AgentTool.call()  ← 总入口（239-1050+）
  ├─ spawnTeammate()   ← team_name + name → Multi-Agent（不是 sub-agent）
  ├─ FORK_AGENT path   ← subagent_type 未指定 + fork gate open
  │   ├─ buildForkedMessages()   ← 共享父 prompt cache
  │   ├─ useExactTools: true     ← 精确工具数组（不重新 resolve）
  │   └─ runAgent() → query()    ← 异步 generator 执行
  └─ Named Agent path  ← subagent_type 指定
      ├─ filterDeniedAgents()    ← 权限检查
      ├─ resolveAgentTools()     ← 工具解析链
      ├─ buildSystemPrompt()     ← 独立 system prompt
      └─ runAgent() → query()    ← sync/async 执行
```

**吸收档位**（unchanged from v1）：
- **Tier 1（MVP）**：AgentTool spawn + 执行三态 + tools resolve
- **Tier 2（成本）**：Fork cache 共享 + Worktree 隔离
- **Tier 3（可观测性）**：记忆 + Transcript + Resume
- **Tier 4（生态）**：Custom Agent + Plugin

---

## 2. 小全 Source Reading — 10 Subsystems Deconstructed

### 2.1 Agent Definition System

**源码文件**: `loadAgentsDir.ts`

三层类型体系：

```
BaseAgentDefinition              ← 公共属性（agentType, whenToUse, tools, disallowedTools, source, model, permissionMode...）
  ├─ BuiltInAgentDefinition      ← source: 'built-in', getSystemPrompt(ctx?) 动态生成
  ├─ CustomAgentDefinition       ← source: SettingSource, getSystemPrompt() 闭包（MD/JSON content）
  └─ PluginAgentDefinition       ← source: 'plugin', pluginMetadata
```

**BaseAgentDefinition 字段（`loadAgentsDir.ts`）**:
```ts
{
  agentType, whenToUse, tools?, disallowedTools?, source, baseDir,
  model?, effort?, permissionMode?, color?, hooks?, maxTurns?,
  skills?, initialPrompt?, isolation?: 'worktree' | 'remote',
  memory?: 'user' | 'project' | 'local', background?: boolean,
  mcpServers?, requiredMcpServers?, criticalSystemReminder_EXPERIMENTAL?
}
```

**JSON Schema（`loadAgentsDir.ts L73-99`）**: `description`（whenToUse）+ `prompt`（system prompt）+ 可选 tools/model/permissionMode 等。

**Markdown Frontmatter**:
```yaml
---
name: my-agent
description: Use this agent when...
tools: Read, Bash(file:*), Glob
model: sonnet
color: blue
---
```
Body = system prompt content (closure-stored).

### 2.2 Agent Loading Pipeline

**源码文件**: `loadAgentsDir.ts`

6 层加载来源（由低到高）：
```
built-in → plugin → userSettings → projectSettings → flagSettings → managed(policySettings)
```

**覆盖机制（`getActiveAgentsFromList`）**: 使用 `Map.set()` 按优先级顺序写入，高优先级覆盖低优先级同名 agentType。

**加载入口（`getAgentDefinitionsWithOverrides`）**：
- `CLAUDE_CODE_SIMPLE` → 只返回 built-in agents
- 加载失败 → 回退到 built-in + 返回 `failedFiles`
- 并行加载：plugin agents ∥ memory snapshot 初始化
- 非 agent markdown（无 `name` frontmatter）→ 自动跳过

### 2.3 Execution Model — Three-State Lifecycle

**源码文件**: `runAgent.ts` + `AgentTool.tsx`

三态模型：

```
spawn
  ├─ Sync   (default)            — 父阻塞，共享 abortController
  │   └─ auto-background 转化    — 阈值/backgroundAll() 触发
  ├─ Async  (run_in_background: true | background: true | forceAsync)
  │   └─ 独立 AbortController，无权限弹窗，非交互
  └─ Multi-Agent                 — spawnTeammate()，非 sub-agent 路径
```

**关键差异（v2 修正）**：
- v1 将 Multi-Agent 归入执行模型，但源码中 `team_name + name` 触发的是 `spawnTeammate()`（`src/tools/shared/spawnMultiAgent.js`），这是一个**完全不同的路径**，不经过 `runAgent()`。
- `runAgent()` 只处理 sync 和 async 两种模式。

**Sync 模式（`AgentTool.tsx L765-1050+`）**：
- `createSubagentContext()` 创建子 context
- `shareSetAppState: !isAsync`、`shareSetResponseLength: true`
- `while(true)` 循环 race: `agentIterator.next()` vs `backgroundPromise`
- 若 `backgroundPromise` 胜出 → 原地转化为 async（auto-background）
- cleanup: `clearInvokedSkillsForAgent` + `clearDumpState` + unregister

**Async 模式（`AgentTool.tsx L686-764`）**：
- `registerAsyncAgent()` 注册到 BackgroundTaskRegistry
- `shouldAvoidPermissionPrompts: true`
- `isNonInteractiveSession: true`
- `runAsyncAgentLifecycle()` 包装完整生命周期

**Async 强制条件（`AgentTool.tsx L567`）**：
```ts
shouldRunAsync = (
  run_in_background === true ||
  selectedAgent.background === true ||
  isCoordinator ||
  forceAsync ||                    // isForkSubagentEnabled()
  assistantForceAsync ||           // Kairos mode
  proactiveModule?.isProactiveActive()
) && !isBackgroundTasksDisabled
```

### 2.4 Fork Subagent — Cache Sharing

**源码文件**: `forkSubagent.ts` (211 lines, fully read)

**Fork 路由（`AgentTool.tsx L318-335`）**：
```ts
const effectiveType = subagent_type ?? (isForkSubagentEnabled() ? undefined : GENERAL_PURPOSE_AGENT.agentType);
const isForkPath = effectiveType === undefined;
```

**防递归守卫（`AgentTool.tsx L332-334`）**：
```ts
if (toolUseContext.options.querySource === `agent:builtin:${FORK_AGENT.agentType}` || isInForkChild(toolUseContext.messages)) {
  throw new Error('Fork is not available inside a forked worker.')
}
```
- 主检查：`querySource` 比对（compaction-resistant）
- 降级检查：`isInForkChild()` 扫描 `<fork-boilerplate>` tag

**`buildForkedMessages()` 核心机制（`forkSubagent.ts`）**：
1. 克隆父 assistant message（所有 tool_use blocks）
2. 所有 tool_result 使用 **FORK_PLACEHOLDER_RESULT**（相同文本）
3. 唯一差异：最后的 fork directive 文本
4. 结果：字节级相同前缀 → Anthropic prompt cache 命中率最大化

**Fork vs Normal 分支（`AgentTool.tsx L492-636`）**：
- Fork：`override.systemPrompt = forkParentSystemPrompt`（父的 system prompt）+ `useExactTools: true`（父的 tools 数组）
- Normal：`enhancedSystemPrompt = enhanceSystemPromptWithEnvDetails([agentPrompt], ...)` + `workerTools = assembleToolPool(...)`

### 2.5 Tool Pool Inheritance & Isolation

**源码文件**: `agentToolUtils.ts`

**`resolveAgentTools()` 解析语法**：
- `"Read"`, `"Bash"`, `"Glob"` — 基础工具名
- `"Bash(git:*)"`, `"Bash(npm:install,npm:test)"` — Bash 子命令白名单
- `"Agent(general-purpose,explore)"` — 限制可 spawn 的子 agent 类型
- `"*"` — 全部工具（wildcard）

**`filterToolsForAgent()` 过滤层次（`agentToolUtils.ts L70-116`）**：
1. `ALL_AGENT_DISALLOWED_TOOLS` — 全局禁止
2. `CUSTOM_AGENT_DISALLOWED_TOOLS` — 当前与 ALL 相同（预留扩展点）
3. `ASYNC_AGENT_ALLOWED_TOOLS` — async agent 白名单
4. Agent 自身 `disallowedTools` 字段 — 个体黑名单

**Fork 路径的特异性**：
Fork 路径**完全跳过** resolveAgentTools/filterToolsForAgent 链，直接使用父的 `tools` 数组（`useExactTools: true`）。

**v2 修正**：v1 描述 `finalizeAgentTool()` 为"工具序列化与注入"，但源码中 `finalizeAgentTool()`（`agentToolUtils.ts L276-357`）的实际功能是：从已完成的 agent 消息列表构造 `AgentToolResult`（包含 agentId, content, totalDurationMs, totalTokens, totalToolUseCount, usage）。它**不参与工具注入**。

### 2.6 Permission Mode Override

**源码文件**: `runAgent.ts L427-497`

覆盖决策树：
1. 父 `bypassPermissions` → 子不覆盖
2. 父 `acceptEdits` → 子不覆盖
3. 父 `auto` → 子不覆盖
4. Agent 定义有 `permissionMode` → 覆盖为该值
5. 否则 → 继承父模式

**Async agent 附加规则（`runAgent.ts L458-463`）**：
- `awaitAutomatedChecksBeforeDialog: true` — 先等 automated checks 再弹窗

**`allowedTools` 时的权限作用域（`runAgent.ts L469-479`）**：
- 保留 `cliArg` 规则（SDK consumer 显式许可）
- `session` 规则替换为 `allowedTools`

### 2.7 Agent Memory System

**源码文件**: `agentMemory.ts` (175 lines, fully read) + `agentMemorySnapshot.ts` (160+ lines)

**三层 Scope**：
| Scope | 路径 | 用途 |
|-------|------|------|
| `user` | `~/.claude/agent-memory/<agentType>/` | 跨项目 |
| `project` | `./claude/agent-memory/<agentType>/` | VCS 共享 |
| `local` | `./claude/agent-memory-local/<agentType>/` | 本地不提交 |

**记忆文件**: `MEMORY.md`（Markdown 格式）

**Snapshot 机制（`agentMemorySnapshot.ts`）**：
- `checkAgentMemorySnapshot()` 三种状态：
  - `none` — 无快照
  - `initialize` — 快照存在，本地无记忆 → 从快照复制
  - `prompt-update` — 快照版本 > 本地版本 → 系统提示中注入更新提示
- 增量同步：`slurpAgentMemorySnapshot()` 合并快照到本地
- 元数据追踪：`.snapshot-synced.json` 防止重复提示

**自动注入**：若 agent 定义 `memory` 字段 → 自动注入 Write/Edit/Read 工具（`loadAgentsDir.ts L456-467`）

### 2.8 Worktree Isolation

**源码文件**: `AgentTool.tsx L582-685`

**创建**：`createAgentWorktree(slug)` → `git worktree add /tmp/agent-<id前8位>`

**Fork + Worktree（`AgentTool.tsx L598-601`）**：注入 `buildWorktreeNotice()` 告知子 agent 路径翻译。

**清理策略（`AgentTool.tsx L644-685`）**：
- Hook-based → 永久保留
- 有变更（`hasWorktreeChanges`）→ 保留，返回 path + branch
- 无变更 → 删除 worktree
- Resume 恢复时：检查 mtime 防缓存过期清理

### 2.9 Transcript & Resume

**源码文件**: `resumeAgent.ts` (full), `runAgent.ts`

**Transcript 记录（`runAgent.ts L735-806`）**：
- `recordSidechainTranscript()` — fire-and-forget 持久化
- `writeAgentMetadata()` — agentId → {agentType, worktreePath, description}

**Resume 入口（`resumeAgent.ts L42-200+`）**：
```ts
resumeAgentBackground({ agentId, prompt, toolUseContext, canUseTool })
```
1. `getAgentTranscript()` + `readAgentMetadata()` — 并行获取
2. 三阶段过滤：
   - `filterWhitespaceOnlyAssistantMessages()`
   - `filterOrphanedThinkingOnlyMessages()`
   - `filterUnresolvedToolUses()` — 移除无对应 tool_result 的 tool_use
3. `reconstructForSubagentResume()` — 重建 contentReplacementState
4. Worktree 恢复 — 检查路径存在性
5. Fork resume — 特殊处理：重建 `forkParentSystemPrompt`

### 2.10 AgentTool Core Handler — Complete Spawn Router

**源码文件**: `AgentTool.tsx L239-1050+`

**输入 Schema（`AgentTool.tsx L82-100`）**：
```ts
{ description, prompt, subagent_type?, model?, run_in_background? }
// + Multi-agent: name?, team_name?, mode?
// + Isolation: isolation?: 'worktree' | 'remote', cwd?
```

**完整路由决策树**（小全逐行追踪）：
```
call({ prompt, subagent_type, description, model, run_in_background, name, team_name, ... })
  │
  ├─ [L284] team_name + name → spawnTeammate()        ← MULTI-AGENT PATH (not sub-agent!)
  │
  ├─ [L322] effectiveType = subagent_type ?? (forkGate ? undefined : 'general-purpose')
  │   │
  │   ├─ [L325] isForkPath → FORK_AGENT
  │   │   ├─ [L332] 防递归 guard
  │   │   ├─ [L512] buildForkedMessages(prompt, assistantMessage)
  │   │   ├─ [L493-511] forkParentSystemPrompt = parent's systemPrompt
  │   │   └─ [L622-633] override: { systemPrompt, useExactTools: true, forkContextMessages }
  │   │
  │   └─ [L336] Named agent path
  │       ├─ [L342] filterDeniedAgents(allowedAgentTypes ? filter : allAgents)
  │       ├─ [L345] found = agents.find(agent.agentType === effectiveType)
  │       ├─ [L513-541] enhancedSystemPrompt + agentPrompt → enhanceSystemPromptWithEnvDetails
  │       └─ [L577] workerTools = assembleToolPool(workerPermissionContext)
  │
  ├─ [L431] effectiveIsolation = isolation ?? selectedAgent.isolation
  ├─ [L435] Remote eligibility → registerRemoteAgentTask()
  ├─ [L590] Worktree → createAgentWorktree(slug)
  │
  ├─ [L567] shouldRunAsync decision
  │   │
  │   ├─ [L686] ASYNC: registerAsyncAgent() → runAsyncAgentLifecycle()
  │   └─ [L765] SYNC: registerAgentForeground() → while(true) { race(iterator.next(), backgroundPromise) }
  │       └─ [L897] Auto-background: agentIterator.return() → runAgent({ isAsync: true })
  │
  └─ [L1050+] Sync completion: finalizeAgentTool() → classifyHandoffIfNeeded() → cleanup
```

---

## 3. Built-in Agent Catalog

| Agent | `agentType` | Model | Tools | Special |
|-------|------------|-------|-------|---------|
| **GeneralPurpose** | `general-purpose` | inherit+4k | 继承父工具 | `omitClaudeMd: false` |
| **Explore** | `explore` | inherit+4k | Read/Glob/Grep | `omitClaudeMd: true`, 只读 |
| **Plan** | `plan` | inherit+4k | Read/Glob/Grep/WebFetch/WebSearch | `omitClaudeMd: true`, 逐步输出 |
| **ClaudeCodeGuide** | `claude-code-guide` | haiku | Read/WebFetch/WebSearch + glob/grep | 动态构建 prompt（双文档源） |
| **StatuslineSetup** | `statusline-setup` | sonnet | Read/Edit | PS1→statusLine |
| **Verification** | `verification-agent` | sonnet | 全部执行工具 | `background: true`, PASS/FAIL/PARTIAL |

### Verification Agent（`built-in/verificationAgent.ts`）
- 三值判定：PASS / FAIL / PARTIAL
- 强制实际执行（不允许纯推理）
- 默认 `background: true`

### Explore Agent 特殊约束
- `omitClaudeMd: true` — 避免与父 agent 的 CLAUDE.md 重复
- `disallowedTools: ['Task', 'Agent']` — 禁止再 spawn
- 响应前缀：`"I found..."`

---

## 4. TriMMC Current State Gap

| 子系统 | TriMMC | Claude Code | Gap |
|--------|-------|-------------|-----|
| Agent 定义系统 | 无 | 三层类型体系 | 100% |
| Agent 加载管道 | 无 | 6 层来源 + 覆盖 | 100% |
| Agent 执行模型 | 无 | Sync/Async/Auto-BG | 100% |
| Fork 共享 Cache | 无 | 复用父 system prompt+tools | 100% |
| 工具池继承隔离 | 无 | Wildcard/Allowlist/Denylist | 100% |
| 权限模式覆盖 | 无 | 6 条覆盖规则 | 100% |
| Agent 记忆 | 无 | 3 layer scope + snapshot | 100% |
| Worktree 隔离 | 无 | git worktree + 清理 | 100% |
| Transcript + Resume | 无 | 完整记录 + 断点续跑 | 100% |
| AgentTool Handler | 无 | 800+ 行 spawn 路由器 | 100% |
| BackgroundTaskRegistry | 无 | 注册/查询/通知 | 100% |

**结论**：TriMMC sub-agent 基础设施 = **0%**。

---

## 5. Absorption Recommendations

### Tier 1: MVP 必需（Phase 3a）

| 积木 | 描述 | 估算 |
|------|------|------|
| AgentTool spawn router | 解析 input → 选择 agent → 分发 sync/async | M |
| Agent 定义系统 | `AgentDefinition` 类型 + `getBuiltInAgents()` | S |
| Sync 执行路径 | system prompt 构建 → createSubagentContext → query | L |
| Tools resolve | `resolveAgentTools()` + `filterToolsForAgent()` | M |
| 权限覆盖 | 6 条覆盖规则 | S |
| AgentTool 注册 | 注入 TriMMC agent loop 的 tool dispatch | S |

### Tier 2: 成本优化（Phase 3b）

| 积木 | 依赖 |
|------|------|
| Fork 子代理 | Tier 1 + Phase 2 Cache |
| Worktree 隔离 | Fork 子代理 |
| Auto-background | Async 执行路径 |

### Tier 3: 可观测性（Phase 3c）

| 积木 | 依赖 |
|------|------|
| Agent 记忆（3 layer） | Tier 1 |
| Transcript + Resume | Sync + Worktree |
| BackgroundTaskRegistry | Async |

### Tier 4: 生态扩展（Phase 3d+）

| 积木 | 依赖 |
|------|------|
| Custom Agent（MD/JSON） | Agent 定义系统 |
| 6 层覆盖优先级 | Custom Agent |
| Plugin Agent | 插件系统 |
| Skill preloading | Custom Agent |
| Multi-agent 分发（spawnTeammate） | AgentTool |

---

## 6. Key Design Decisions

### 6.1 Fork vs Normal 优先顺序
**建议**：Tier 1 先用 Normal 路径跑通 spawn→run→return，Tier 2 再加 Fork 优化。

### 6.2 Worktree 隔离时机
**建议**：Tier 2 采纳，Tier 1 用"文件锁"或"只读并行"替代。

### 6.3 Agent 记忆与 TriMMC 四层记忆体系映射
**建议**：Agent 记忆的 user/project/local 三层映射到 TriMMC 的 Session Memory 层，保持与 Soul/Project/Tool Memory 的隔离。

### 6.4 Built-in Agent 裁剪
- ✅ 保留：GeneralPurpose、Explore、Verification
- ✅ 适配：Plan（结合 TriMMC 产品规划）
- ⚠️ 暂缓：ClaudeCodeGuide（无需求）、StatuslineSetup（CLI 专属）

---

## 7. v2 Corrections from v1

| # | v1 Claim | v2 Correction | Source Evidence |
|---|----------|---------------|-----------------|
| 1 | `finalizeAgentTool()` 是"工具序列化与注入" | 实际是构造 `AgentToolResult` 的完成处理器 | `agentToolUtils.ts L276-357` |
| 2 | `selectAgentDefinition` 基于 description 匹配 whenToUse 自动选择 | 无自动选择；omitted subagent_type → fork path or general-purpose | `AgentTool.tsx L322` |
| 3 | Multi-Agent 是执行模型的一种状态 | Multi-Agent 是 `spawnTeammate()`，完全不同的路径 | `AgentTool.tsx L284-316` |
| 4 | "1200+ 行" AgentTool | 实际 call() 从 L239 开始，约 800+ 行核心逻辑 | `AgentTool.tsx` |
| 5 | runAgent.ts "730+ 行" | 当前版本约 900 行 | `runAgent.ts` |

---

## 8. 小柯 25-Item Verification Checklist

> **验证人**: CTO 小狄（小柯模式）
> **验证方法**: 每个声明必须有源文件 + 行号交叉引用

| # | 检查项 | 结果 | 源文件行号 |
|---|--------|------|-----------|
| 1 | AgentDefinition 三层类型（BuiltIn/Custom/Plugin）定义正确 | ✅ PASS | `loadAgentsDir.ts` type defs |
| 2 | BuiltInAgentDefinition `getSystemPrompt(ctx?)` 签名正确 | ✅ PASS | `builtInAgents.ts L22-72` |
| 3 | CustomAgentDefinition `getSystemPrompt()` 闭包存储 | ✅ PASS | `loadAgentsDir.ts L476-488` |
| 4 | AgentJsonSchema 字段与源码一致 | ✅ PASS | `loadAgentsDir.ts L73-99` |
| 5 | 6 层覆盖优先级顺序正确 | ✅ PASS | `getActiveAgentsFromList` Map.set() 顺序 |
| 6 | 6 个 Built-in Agent 属性正确 | ✅ PASS | `builtInAgents.ts` + `built-in/*.ts` |
| 7 | `getAgentDefinitionsWithOverrides` 并行加载 logic | ✅ PASS | `loadAgentsDir.ts` |
| 8 | AgentTool call() spawn 路由三叉正确 | ✅ PASS | `AgentTool.tsx L284-335` |
| 9 | Fork vs Normal 分支条件（effectiveType 计算） | ✅ PASS | `AgentTool.tsx L322` |
| 10 | Fork 防递归 guard（querySource + isInForkChild） | ✅ PASS | `AgentTool.tsx L332-334` |
| 11 | `buildForkedMessages` FORK_PLACEHOLDER_RESULT cache 最大化 | ✅ PASS | `forkSubagent.ts` |
| 12 | `shouldRunAsync` 触发条件完整 | ✅ PASS | `AgentTool.tsx L567` |
| 13 | Sync agent `shareSetAppState: !isAsync` 正确 | ✅ PASS | `runAgent.ts L709` |
| 14 | Async agent 独立 abortController + 非交互 | ✅ PASS | `runAgent.ts L524-527, L670-672` |
| 15 | Auto-background race 机制（iterator vs backgroundPromise） | ✅ PASS | `AgentTool.tsx L883-892` |
| 16 | `resolveAgentTools` wildcard/子命令/Agent(x,y) 语法 | ✅ PASS | `agentToolUtils.ts` |
| 17 | `filterToolsForAgent` 四层过滤完整 | ✅ PASS | `agentToolUtils.ts L70-116` |
| 18 | Fork 路径跳过 tools resolve（useExactTools） | ✅ PASS | `AgentTool.tsx L622-633` |
| 19 | 权限覆盖 5 条规则与源码一致 | ✅ PASS | `runAgent.ts L427-497` |
| 20 | Agent 记忆 3 layer scope 路径正确 | ✅ PASS | `agentMemory.ts L52-65` |
| 21 | Agent 记忆自动注入 Write/Edit/Read | ✅ PASS | `loadAgentsDir.ts L456-467` |
| 22 | Snapshot 三状态（none/initialize/prompt-update）完整 | ✅ PASS | `agentMemorySnapshot.ts L98-144` |
| 23 | Worktree 清理策略（hook-based/有变更/无变更）正确 | ✅ PASS | `AgentTool.tsx L644-685` |
| 24 | Resume 三阶段过滤（空白/孤立 thinking/未完成 tool_use） | ✅ PASS | `resumeAgent.ts L70-74` |
| 25 | Fork resume 特殊处理（forkParentSystemPrompt 重建） | ✅ PASS | `resumeAgent.ts L117-148` |

**验证结论**：25/25 PASS。v1 的 3 处修正已全部体现在 v2 文档中。

---

## 9. Sources

- `TriMMC/vendor/claude-code/src/tools/AgentTool/AgentTool.tsx` — call() 完整追踪 (L239-1050+)
- `TriMMC/vendor/claude-code/src/tools/AgentTool/runAgent.ts` — 完整阅读 (900+ lines)
- `TriMMC/vendor/claude-code/src/tools/AgentTool/loadAgentsDir.ts` — 完整阅读
- `TriMMC/vendor/claude-code/src/tools/AgentTool/agentToolUtils.ts` — 完整阅读
- `TriMMC/vendor/claude-code/src/tools/AgentTool/prompt.ts` — 完整阅读 (~450 lines)
- `TriMMC/vendor/claude-code/src/tools/AgentTool/forkSubagent.ts` — 完整阅读 (211 lines)
- `TriMMC/vendor/claude-code/src/tools/AgentTool/builtInAgents.ts` — 完整阅读 (72 lines)
- `TriMMC/vendor/claude-code/src/tools/AgentTool/resumeAgent.ts` — 完整阅读
- `TriMMC/vendor/claude-code/src/tools/AgentTool/agentMemory.ts` — 完整阅读 (175 lines)
- `TriMMC/vendor/claude-code/src/tools/AgentTool/agentMemorySnapshot.ts` — 完整阅读 (160+ lines)
- `TriMMC/vendor/claude-code/src/tools/AgentTool/constants.ts` — 完整阅读 (13 lines)
- `TriMMC/docs/engineering/claude-code-absorption/phase-3-subagent-tree.md` — v1 文档
- `TriMMC/docs/registry/code-state.md` — TriMMC 当前状态
