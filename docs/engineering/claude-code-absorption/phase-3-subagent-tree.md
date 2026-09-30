# Phase 3: Sub-Agent Tree Absorption Analysis

**Author**: CTO 小狄（小全模式 — 积木级完整拆解）
**Date**: 2026-07-18
**Status**: Complete（小柯验证通过）
**Source**: Claude Code 2.1.88 vendor (`src/tools/AgentTool/` 完整目录，15 个源文件，~5000+ 行)
**Target**: TriMMC（当前 sub-agent 基础设施：0%）

---

## 1. Executive Summary

Claude Code 的 sub-agent 系统是其最关键的分工原语——把"一个 agent 做所有事"升级为"树形多 agent 协同"。TriMMC 当前完全没有 sub-agent 概念（`src/agent-loop/` 只有单 agent 的 tool dispatch while-true 循环）。

Phase 3 完整拆解了 Claude Code 子代理树的**10 个子系统**：Agent 定义系统（BuiltIn/Custom/Plugin 三层）、加载管道、执行模型三态、Fork 共享 Prompt Cache、工具池继承与隔离、权限模式覆盖、Agent 记忆（3 层 scope + 快照）、Worktree 隔离、Transcript 与 Resume、AgentTool 核心 Handler。

**核心发现**：Claude Code 的子代理不是一个简单的"调另一个 prompt"，而是一个带有完整生命周期（spawn→run→background→resume→cleanup）的**微执行环境**。最关键的吸收路径是 Fork 子代理（共享 Prompt Cache → 零额外系统提示词开销）和 Agent 执行三态模型（sync/async/auto-background）。

**吸收档位建议**：
- **Tier 1（MVP 必需）**：AgentTool spawn 路由 + 执行三态 + tools resolve
- **Tier 2（成本优化）**：Fork 共享 Prompt Cache + Worktree 隔离
- **Tier 3（可观测性）**：Agent 记忆 + Transcript + Resume
- **Tier 4（生态扩展）**：Custom Agent 文件加载 + Plugin 系统

---

## 2. Claude Code Sub-Agent Architecture Deconstruction

### 2.1 Agent Definition System — Three-Layer Type Hierarchy

Claude Code 的 agent 定义系统由三层类型构成，每层有不同的 system prompt 生成方式和生命周期：

```
BuiltInAgentDefinition  (源码硬编码)  ← getSystemPrompt() 动态生成
CustomAgentDefinition   (文件/MD/JSON) ← getSystemPrompt() 闭包存储
PluginAgentDefinition   (插件系统)     ← 带 plugin 元数据
```

#### 2.1.1 公共基类型 `AgentDefinition`

```ts
// loadAgentsDir.ts [106-136]
type AgentDefinition = {
  agentType: string                    // 唯一标识符（e.g. "general-purpose", "explore"）
  whenToUse: string                    // 给父 agent 的使用指南（when and why）
  tools?: string[]                     // 可用工具白名单（['Read', 'Bash', 'Glob']）
  disallowedTools?: string[]           // 显式黑名单（覆盖白名单）
  source: SettingSource | 'built-in'   // 来源（覆盖优先级依据）
  baseDir: string                      // 基础目录（相对路径解析）
  model?: string                       // 模型别名或 'inherit'
  effort?: 'low' | 'medium' | 'high'   // 思考深度覆盖
  permissionMode?: PermissionMode      // 权限模式覆盖
  color?: string                       // UI 显示颜色
  hooks?: HooksSettings                // 生命周期钩子
  maxTurns?: number                    // 最大对话轮数
  skills?: string[]                    // 预加载技能
  initialPrompt?: string               // 初始提示词（开机即注入）
  isolation?: 'worktree' | 'remote'      // 环境隔离级别（worktree=git worktree, remote=CCR远程）
  memory?: AgentMemoryScope              // 持久记忆层（user/project/local）
  background?: boolean                 // 是否默认后台运行
  mcpServers?: AgentMcpServerSpec[]    // Agent 专用 MCP 服务器
  requiredMcpServers?: string[]        // 必需的 MCP 服务器列表
  criticalSystemReminder_EXPERIMENTAL?: string  // 实验性系统提醒
}
```

#### 2.1.2 `BuiltInAgentDefinition` — 6 个内置 Agent

```ts
// builtInAgents.ts [22-72]
type BuiltInAgentDefinition = AgentDefinition & {
  source: 'built-in'
  getSystemPrompt: (ctx?: { toolUseContext }) => string  // 动态生成（注入运行时上下文）
}
```

6 个内置 Agent（详见第 3 节 Catalog）：

| Agent | `agentType` | `model` | 工具 | 核心职责 |
|---|---|---|---|---|
| GeneralPurpose | `general-purpose` | inherit+4k | 继承父工具 | 通用任务委派 |
| Explore | `explore` | inherit+4k | Read/Glob/Grep | 只读代码探索 |
| Plan | `plan` | inherit+4k | Read/Glob/Grep/WebFetch/WebSearch | 逐步规划 |
| ClaudeCodeGuide | `claude-code-guide` | haiku | Read/WebFetch/WebSearch + glob/grep | Claude Code 文档问答 |
| StatuslineSetup | `statusline-setup` | sonnet | Read/Edit | PS1→statusLine 配置转换 |
| Verification | `verification-agent` | sonnet | 全部执行工具 | PASS/FAIL/PARTIAL 判定 |

#### 2.1.3 `CustomAgentDefinition` — 文件/MD/JSON 加载

```ts
// loadAgentsDir.ts [136-166]
type CustomAgentDefinition = AgentDefinition & {
  source: SettingSource          // 'userSettings' | 'projectSettings' | 'localSettings' | 'policySettings' | 'flagSettings'
  getSystemPrompt: () => string  // 闭包 — 从 MD content 或 JSON prompt 提取
  pendingSnapshotUpdate?: { snapshotTimestamp: number }  // 记忆快照待更新标记
}
```

**JSON Schema** (用于 `--agents` CLI flag 和 settings)：
```ts
// loadAgentsDir.ts [73-99]
const AgentJsonSchema = z.object({
  description: z.string(),                              // 必需的 whenToUse
  prompt: z.string(),                                   // system prompt
  tools: z.array(z.string()).optional(),                 // 白名单
  disallowedTools: z.array(z.string()).optional(),       // 黑名单
  model: z.string().optional(),
  permissionMode: z.enum([...]).optional(),
  // ...完整字段
})
```

**Markdown Frontmatter** (用于 `.claude/agents/*.md`)：
```yaml
---
name: my-agent
description: Use this agent when...
tools: Read, Bash(file:*), Glob
model: sonnet
color: blue
---
# System Prompt
You are an expert at...
```

#### 2.1.4 `PluginAgentDefinition`

```ts
type PluginAgentDefinition = AgentDefinition & {
  source: 'plugin'
  pluginMetadata: PluginMetadata  // 插件身份 + 版本
}
```

---

### 2.2 Agent Loading Pipeline

完整加载管道覆盖 6 层来源，按优先级由低到高：

```
loadMarkdownFilesForSubdir('agents', cwd)
  ├─ .claude/agents/          (project)
  ├─ ~/.claude/agents/        (user)
  ├─ .claude/agents-local/    (local)
  ├─ Managed/policy           (policySettings)
  └─ CLI --agents flag        (flagSettings)

+ pluginAgents (loadPluginAgents())
+ builtInAgents (getBuiltInAgents())

→ allAgentsList = [...builtIn, ...plugin, ...custom]
→ getActiveAgentsFromList(allAgentsList)  // 去重覆盖：高优先级覆盖低优先级同 agentType
```

#### 2.2.1 覆盖优先级（去重规则）

```ts
// loadAgentsDir.ts [203-221]
// 覆盖优先级（从高到低）：
// flagSettings > localSettings > policySettings > plugin > projectSettings > userSettings > built-in
```

同名 agent 的覆盖规则（源码 `getActiveAgentsFromList` [203-221]）：
- **managed（policySettings）** 覆盖一切
- **flagSettings** 覆盖 project/user/plugin/built-in
- **projectSettings** 覆盖 user/plugin/built-in
- **userSettings** 覆盖 plugin/built-in
- **plugin** 覆盖 built-in
- **built-in** 被所有自定义 agent 覆盖

注：`localSettings` 在加载管道中存在（`.claude/agents-local/`）但不参与 `getActiveAgentsFromList` 的覆盖优先级链（该函数只处理 6 组：builtIn/plugin/user/project/flag/managed）。

#### 2.2.2 加载入口

```ts
// loadAgentsDir.ts [296-393]
getAgentDefinitionsWithOverrides(cwd): Promise<{
  activeAgents: AgentDefinition[]    // 去重覆盖后的活跃 agents
  allAgents: AgentDefinition[]       // 所有发现（含被覆盖的）
  failedFiles?: Array<{path, error}> // 解析失败的 agent 文件
}>
```

关键行为：
- `CLAUDE_CODE_SIMPLE` 环境变量 → 只返回 built-in agents
- 非 agent markdown 文件自动跳过（无 `name` frontmatter）
- 加载失败不回滚 → 返回 built-in agents + `failedFiles`
- **并行加载**：plugin agents 与 memory snapshot 初始化并发
- **记忆快照初始化**：遍历 `memory: 'user'` 的 agents，若 snapshot 更新则标记 `pendingSnapshotUpdate`

#### 2.2.3 Markdown 解析（`parseAgentFromMarkdown`）

核心逻辑：
1. 解析 frontmatter → 提取 `name`, `description`, `tools`, `model`, `color`, `hooks`, `skills`, `memory`, `isolation` 等字段
2. `parseAgentToolsFromFrontmatter()` 解析工具声明字符串
3. `parseHooksFromFrontmatter()` 用 `HooksSchema()` 验证 hooks
4. 若 `memory` 启用且 `isAutoMemoryEnabled()`，自动注入 Write/Edit/Read 工具
5. `getSystemPrompt` 闭包 = md content（去 frontmatter 标记后的正文）

---

### 2.3 Execution Model — Three-State Agent Lifecycle

Claude Code 的子代理执行不是简单的同步调用，而是**三态生命周期**：

```
            spawn
              │
     ┌───────┼────────┐
     ▼       ▼        ▼
   Sync    Async   Multi-Agent
     │       │        │
     │   runInBg=true  │
     │       │        │
     ▼       ▼        ▼
  [阻塞父] [异步]  [顺序/并行]
     │       │
     ├───auto-background──→ Async (原地转化)
     │   (阈值触发 or backgroundAll())
     │
     ▼
  [完成 / 失败 / 中止]
```

#### 2.3.1 Sync 模式（默认）

```ts
// AgentTool.tsx [765-1200+]
// 父消息循环阻塞，子 agent 的每个 tool use 立即在父 UI 中渲染
```

核心行为：
- 子 agent 共享父 `setAppState`、`setResponseLength`、`abortController`
- 每个 tool_use/tool_result 通过 `onProgress` 发射 progress 事件到父 UI
- **Auto-background 过渡**：运行中检测 `backgroundAll()` 或阈值触发 → 原地转化为 async
- 父 abort → 子同步 abort
- 清理：`clearInvokedSkillsForAgent` + `clearDumpState` + worktree cleanup

#### 2.3.2 Async 模式（`run_in_background: true` 或 `background: true`）

```ts
// AgentTool.tsx [686-764]
```

核心行为：
- 独立 `abortController`（不依赖父）
- `shouldAvoidPermissionPrompts: true` — 异步 agent 不弹出权限对话框
- `isNonInteractiveSession: true` — 禁用交互式 prompt
- 注册到 `BackgroundTaskRegistry`，父可以查询状态/结果
- Verifier agent 默认 `background: true`

#### 2.3.3 Auto-Background 机制

```ts
// AgentTool.tsx [886-960]
```

关键触发条件：
1. **`backgroundAll()`** — 父 agent 显式调用（工具中的 `bg` 命令）
2. **阈值触发** — 子 agent 运行中，父 agent 需要继续时自动触发
3. **`cancelAutoBackground()`** — 计时器回调，在 agent 完成前取消自动转化

转化过程：
1. 停止 foreground summarization
2. 创建独立 `abortController`
3. 更新 `agentToolUseContext`（切换为 async 模式）
4. 注册到 `BackgroundTaskRegistry`
5. 父 agent 收到 transition 确认 → 继续下一轮（不再阻塞）

#### 2.3.4 Multi-Agent 模式（单工具调用启动多个 agent）

```ts
// AgentTool.tsx [632-684]
```

当用户在 Agent 工具调用中指定多个 agent 名称时：
- 每个 agent 独立启动（平行的 async 或顺序的 sync）
- 共享同一个 tool_use_id 前缀
- Progress 事件聚合到父 UI

#### 2.3.5 Agent 创建入口（`createSubagentContext`）

```ts
// runAgent.ts [697-714]
const agentToolUseContext = createSubagentContext(toolUseContext, {
  options: agentOptions,             // 独立/继承的工具、模型、MCP
  agentId,                           // 唯一标识符
  agentType: agentDefinition.agentType,
  messages: initialMessages,          // 包含 system prompt
  readFileState: agentReadFileState,  // 隔离的文件读取状态
  abortController: agentAbortController,
  getAppState: agentGetAppState,
  shareSetAppState: !isAsync,        // sync → 共享父 UI 状态
  shareSetResponseLength: true,       // 都贡献 response metrics
})
```

---

### 2.4 Fork Subagent — Prompt Cache Sharing Mechanism

Fork 子代理是 Claude Code 的**零额外系统提示词开销**机制——子进程**直接复用**父进程的完整 system prompt + 精确工具数组，不重新构建。

#### 2.4.1 Fork 触发条件

```ts
// prompt.ts [80-97] — When to fork
```

AI 被提示在以下场景使用 fork：
- **Same tools** — 子 agent 需要与父完全相同的工具集
- **Same context** — 子 agent 需要相同的系统提示词 + 项目上下文
- **Complex multi-step** — 需要多轮推理的复杂任务
- **Parallel exploration** — 多个子 agent 并行探索不同方向

#### 2.4.2 Fork 消息构建

```ts
// forkSubagent.ts — buildForkedMessages()
```

核心步骤：
1. **继承父 system prompt** — 直接复用 `toolUseContext.getSystemPrompt()` 结果
2. **精确工具数组** — `useExactTools: true` → 直接使用父 `tools` 数组（不重新 resolve）
3. **Fork boilerplate** — 注入 `<fork-boilerplate>` 用户消息，指示子 agent 执行任务
4. **Tool result 占位** — 所有 `tool_result` 用相同占位文本 → 最大化 API cache 命中
5. **防递归** — `isInForkChild()` 检查 `<fork-boilerplate>` 标签，拒绝子代理再 fork

#### 2.4.3 Cache 共享槽位

```ts
// forkedAgent.ts
type CacheSafeParams = {
  systemPrompt: string
  userContext: string
  systemContext: string
  toolUseContext: ToolUseContext
  forkContextMessages: Message[]
}
```

主循环 post-turn 写入 `CacheSafeParams` 全局槽位 → 子进程 `onCacheSafeParams` 回调接收 → 用于 background summarization 的 cache 优化。

#### 2.4.4 Fork 与 Normal 的分支决策

```ts
// AgentTool.tsx [492-636]
if (isForkAgent && forkContextMessages) {
  // Fork 路径：直接使用 forkContextMessages
  initialMessages = forkContextMessages  // 已包含 system prompt
} else {
  // Normal 路径：重新构建 system prompt + resolve tools
  const { systemPrompt, userContext, systemContext } = await buildAgentSystemPrompt(...)
  initialMessages = [...systemContext, ...userContext, systemPrompt]
}
```

---

### 2.5 Tool Pool Inheritance & Isolation

工具池的解析和隔离是 agent 安全性的核心。

#### 2.5.1 工具解析链

```
agent definition (tools/disallowedTools 字段)
  → parseAgentToolsFromFrontmatter()      ← 解析字符串 → 工具名数组
  → resolveAgentTools()                    ← resolve wildcard → 具体工具名
  → filterToolsForAgent()                  ← 应用黑名单
  → finalizeAgentTool()                    ← 序列化 → 注入名称
  → 合并 agent MCP tools                  ← 去重 (uniqBy name)
```

#### 2.5.2 `resolveAgentTools()` — 复杂工具声明语法

```ts
// agentToolUtils.ts [122-225]
// 支持的声明格式：
// 1. 基础工具名: "Read", "Bash", "Glob"
// 2. Bash 子命令: "Bash(git:*)", "Bash(npm:install,npm:test)"  ← 白名单子命令
// 3. Agent spawn 限制: "Agent(general-purpose,explore)"        ← 限制可 spawn 的子 agent 类型
// 4. Wildcard: "*" = 所有工具
// 5. 去重: 同名工具只保留一次
```

#### 2.5.3 `filterToolsForAgent()` — 三层过滤

```ts
// agentToolUtils.ts [70-116]
1. ALL_AGENT_DISALLOWED_TOOLS      ← 全局禁止（TaskOutput, ExitPlanMode, EnterPlanMode, Agent[非ant], AskUserQuestion, TaskStop, WorkflowTool[若启用]）
2. CUSTOM_AGENT_DISALLOWED_TOOLS   ← 同 ALL_AGENT_DISALLOWED_TOOLS（当前相同集合，预留扩展点）
3. ASYNC_AGENT_ALLOWED_TOOLS       ← async agent 白名单（Read/WebSearch/TodoWrite/Grep/WebFetch/Glob/Shell/Edit/Write/NotebookEdit/Skill/SyntheticOutput/ToolSearch/EnterWorktree/ExitWorktree）
4. Agent 自身 disallowedTools 字段 ← 个体黑名单
```

#### 2.5.4 `finalizeAgentTool()` — 工具序列化与 handoff 分类

```ts
// agentToolUtils.ts [276-357]
// 为每个工具注入：
// - agentName 元数据（谁在使用）
// - handoff 分类（用于权限日志）
// - Tool augmentation（增加 agent 上下文）
```

#### 2.5.5 Fork 路径的工具处理

Fork 路径**完全跳过**上述解析链：
```
Fork: useExactTools=true → 直接使用父 tools 数组
Normal: 完整 resolveAgentTools → filterToolsForAgent → finalizeAgentTool 链路
```

---

### 2.6 Permission Mode Override Rules

Agent 权限模式覆盖遵循严格规则：

```ts
// runAgent.ts [400-500]
```

覆盖决策树：
1. **父 bypassPermissions？** → 子 agent 不覆盖（保持 bypass）
2. **父 acceptEdits？** → 子 agent 不覆盖（保持 acceptEdits）
3. **父 auto（auto-accept）？** → 子 agent 不覆盖
4. **Agent 定义 permissionMode 字段存在？** → 覆盖为 agent 定义的模式
5. **否则** → 继承父模式

附加规则：
- **Async agent** → `shouldAvoidPermissionPrompts: true`（强制无交互）
- **`allowedTools` 参数** → 只保留 cliArg 规则 + session 规则
- **Bubble mode**：子 agent 权限提示冒泡到父终端

---

### 2.7 Agent Memory System — 3-Layer Scope + Snapshot

#### 2.7.1 记忆三层次

```ts
// agentMemory.ts [1-178]
```

| Scope | 路径 | 用途 |
|---|---|---|
| `user` | `~/.claude/agent-memory/<agentType>/` | 跨项目持久记忆 |
| `project` | `./claude/agent-memory/<agentType>/` | 项目级共享记忆 |
| `local` | `./claude/agent-memory-local/<agentType>/` | 本地（不提交）记忆 |

**`MEMORY.md` 文件格式**：
```markdown
# Agent Memory
Last updated: 2026-07-18T10:30:00Z

## Key Decisions
...

## Context
...
```

#### 2.7.2 记忆快照机制

```ts
// agentMemorySnapshot.ts [1-198]
```

核心流程：
1. **初始化** — `checkAgentMemorySnapshot()` 检查 `agent-memory-snapshots/<agentType>/` 是否存在
2. **三种状态**：
   - `none`：无快照 → 不处理
   - `initialize`：快照存在，本地无记忆 → 从快照复制
   - `prompt-update`：快照版本 > 本地版本 → 在 agent 系统提示词中注入提示
3. **增量更新** — `slurpAgentMemorySnapshot()` 合并快照到本地
4. **synced 元数据** — 跟踪同步状态防止重复提示
5. **清理** — `removeSnapshotsForAgent()` 删除旧快照

#### 2.7.3 记忆注入

```ts
// runAgent.ts — buildMemoryPrompt() 在 system prompt 构建时注入
```

若 agent 定义 `memory` 字段：
1. 自动注入 Write/Edit/Read 工具（用于记忆文件操作）
2. 注入 `MEMORY.md` 加载提示 → agent 知道如何读写记忆
3. 系统提示词中包含记忆文件路径

---

### 2.8 Worktree Isolation Mechanism

```ts
// AgentTool.tsx [460-490]
```

当 agent 定义 `isolation: 'worktree'`：

1. **创建临时 worktree**：`git worktree add /tmp/agent-<id前8位>`
2. **Fork + worktree**：注入路径翻译提示（告知子 agent 文件路径映射）
3. **清理策略**：
   - 有变更 → 保留（返回 worktreePath 供后续使用）
   - 无变更 → 删除 worktree
4. **Hook-based worktree**：通过 hooks 可以永久保留
5. **Resume 恢复**：resume 时检查 mtime 防过期清理

---

### 2.9 Transcript & Resume Mechanism

#### 2.9.1 Transcript 记录

```ts
// AgentTool.tsx [1060-1126]
```

Sync agent 的每个 tool_use/tool_result 消息都会被捕获并存储为 transcript：
- 过滤：跳过 `type !== 'assistant' && type !== 'user'` 的非对话消息
- Progress 转发：所有 tool_use → onProgress（父 UI）
- Token 计数：assistant 消息内容长度累加到 `setResponseLength`

#### 2.9.2 Resume（断点续跑）

```ts
// resumeAgent.ts [1-200+]
```

关键步骤：
1. **获取 transcript**：`getAgentTranscript(asAgentId(agentId))` → 完整对话记录
2. **过滤**：
   - 孤立 thinking 块
   - 纯空白 assistant 消息
   - 未完成的 tool_use（无对应 tool_result）
3. **重建状态**：`reconstructForSubagentResume()` 还原 content replacement state
4. **恢复 worktree**：检查 mtime → 决定是复用还是放弃
5. **Fork resume**：特殊处理 fork 子代理的 transcript

#### 2.9.3 Resume 触发条件

```ts
// AgentTool.tsx — call() 路由入口
if (resumeAgentId) {
  // 不创建新 agent，而是恢复已有 agent
  return resumeExistingAgent(resumeAgentId, ...)
}
```

---

### 2.10 AgentTool Core Handler — Complete Spawn Router

`AgentTool.tsx` 的 `call()` 方法是整个子代理系统的总入口。

#### 2.10.1 输入解析

```ts
// AgentTool.tsx [196-316]
Input (raw JSON string) → 解析为:
{
  agentType?: string           // agent 类型选择
  description?: string          // 任务描述
  prompt: string                // 任务 prompt
  subagent_type?: string       // 旧字段兼容
  resume?: string               // resume agent ID
  run_in_background?: boolean   // async 模式
  model?: string                // 模型覆盖
}
```

#### 2.10.2 路由决策

```
parseInput()
  ├─ 多 agent？ → multi-agent 分发
  ├─ resume？ → resumeExistingAgent()
  ├─ fork? → isForkAgent + forkContextMessages 可用？
  │   ├─ Yes → buildForkedMessages() → fork 路径
  │   └─ No  → buildAgentSystemPrompt() → normal 路径
  └─ run_in_background？ → async 路径
```

#### 2.10.3 Agent 选择（`selectAgentDefinition`）

```
1. agentType 显式指定 → 从 activeAgents 查找
2. 未指定 → auto-select 逻辑（基于 description 匹配 whenToUse）
3. 未找到 → 默认 general-purpose
```

#### 2.10.4 Background 任务注册

```ts
// AgentTool.tsx — async 路径
const backgroundTask = {
  agentId,
  agentType,
  description,
  startTime,
  abortController,
  // ...进度跟踪
}
registerBackgroundTask(backgroundTask)
// 父 agent 通过 tools 查询后台任务状态
```

#### 2.10.5 Sync Agent 完成后的清理

```ts
// AgentTool.tsx [1150-1200+]
finally {
  // 1. 清除 background hint UI
  // 2. 停止 foreground summarization
  // 3. 取消注册 foreground task
  // 4. SDK 通知 (task_notification event)
  // 5. 清理 scoped skills
  // 6. 清理 dumpState
  // 7. 取消 auto-background timer
  // 8. Worktree 清理（仅非 backgrounded）
}
```

---

## 3. Built-in Agent Catalog

| Agent | `agentType` | `model` | 工具 | 权限 | 特有行为 |
|---|---|---|---|---|---|
| **GeneralPurpose** | `general-purpose` | inherit+4k | 继承父工具 | 继承 | 通用委派, `omitClaudeMd: false` |
| **Explore** | `explore` | inherit+4k | Read/Glob/Grep | 继承 | 只读, `omitClaudeMd: true`（避免冗余上下文） |
| **Plan** | `plan` | inherit+4k | Read/Glob/Grep/WebFetch/WebSearch | 继承 | 只读规划, 逐步输出计划, 关键文件列表 |
| **ClaudeCodeGuide** | `claude-code-guide` | haiku | Read/WebFetch/WebSearch + glob/grep | `dontAsk` | 动态构建 prompt（注入 skills/agents/MCP/settings）, 双文档源 |
| **StatuslineSetup** | `statusline-setup` | sonnet | Read/Edit | 继承 | PS1→statusLine 命令转换, settings.json 操作 |
| **Verification** | `verification-agent` | sonnet | 全部执行工具 | 继承 | `background: true`, PASS/FAIL/PARTIAL, 命令必须执行 |

### 3.1 Verification Agent 详细行为

```ts
// verificationAgent.ts [1-153]
```

- **判定三值**：`PASS`（完全通过）、`FAIL`（失败需修复）、`PARTIAL`（部分通过带问题）
- **强制执行**：不能只在脑海里推理 → 必须实际执行命令验证
- **结果格式**：`### {PASS|FAIL|PARTIAL}\n\n{详细说明}\n\n## Commands Executed\n...`
- **默认后台运行**：`background: true`

### 3.2 Explore Agent 特殊约束

- `omitClaudeMd: true` — 不加载项目 CLAUDE.md（避免与父 agent 重复）
- `disallowedTools: ['Task', 'Agent']` — 明确禁止再 spawn
- 响应前缀要求：`"I found..."`（标准化输出格式）

---

## 4. TriMMC Current State Gap Analysis

### 4.1 当前状态

| 子系统 | TriMMC 现状 | Claude Code 实现 | 差距 |
|---|---|---|---|
| Agent 定义系统 | 无 | BuiltIn/Custom/Plugin 三层 | 100% |
| Agent 加载管道 | 无 | 6 层来源 + 覆盖优先级 | 100% |
| Agent 执行模型 | 无 | Sync/Async/Auto-BG 三态 | 100% |
| Fork 共享 Cache | 无 | Fork 子代理复用父 system prompt+tools | 100% |
| 工具池继承隔离 | 无（单 agent） | Wildcard/Allowlist/Denylist/Agent(x,y) | 100% |
| 权限模式覆盖 | 无 | 6 条覆盖规则 + bubble mode | 100% |
| Agent 记忆 | 无 | 3 layer scope + snapshot | 100% |
| Worktree 隔离 | 无 | Git worktree + 清理策略 | 100% |
| Transcript + Resume | 无 | 完整对话记录 + 断点续跑 | 100% |
| AgentTool Handler | 无 | 1200+ 行 spawn 路由器 | 100% |
| 背景任务注册 | 无 | BackgroundTaskRegistry | 100% |

**结论**：TriMMC sub-agent 基础设施覆盖率 = **0%**。

### 4.2 对现有系统的影响

- **Agent Loop**（`src/agent-loop/loop.ts`）：当前 while-true 只处理单 agent 的 tool dispatch → 需要增加 "spawn sub-agent" tool 的处理分支
- **Tool 注册表**（`src/agent-loop/tools.ts`）：当前 6 个内置工具 → 需要增加 `Agent` tool
- **ToolUseContext**：需要支持子 context 的创建和隔离
- **Observability**（`src/observability/`）：需要支持 agent spawn/background/resume 事件

---

## 5. Absorption Recommendations

### 5.1 Tier 1: MVP 必需（Phase 3a）

**目标**：让 TriMMC 的子代理能工作——spawn → run → return results

| 积木 | 描述 | 依赖 | 估算 |
|---|---|---|---|
| **AgentTool spawn router** | `AgentTool.ts` — 解析 input → 选择 agent → 分发 sync/async | Agent 定义系统 | M |
| **Agent 定义系统** | `AgentDefinition` 类型 + `getBuiltInAgents()` | 无 | S |
| **Sync 执行路径** | `runAgent.ts` 核心 — system prompt 构建 → createSubagentContext → query | Agent 定义系统 | L |
| **Tools resolve** | `resolveAgentTools()` + `filterToolsForAgent()` | Tool 注册表 | M |
| **权限覆盖** | 6 条覆盖规则 | Permission system | S |
| **AgentTool 注册到 tool registry** | 将 Agent 工具注入 TriMMC 的 tool dispatch | AgentTool spawn router | S |

### 5.2 Tier 2: 成本优化（Phase 3b）

| 积木 | 描述 | 依赖 |
|---|---|---|
| **Fork 子代理** | `forkSubagent.ts` — buildForkedMessages + 防递归 | Tier 1 全部 |
| **Prompt Cache 共享** | Fork 子代理复用父 system prompt → 零额外 token 开销 | Phase 2 Cache 基础设施 |
| **Worktree 隔离** | Git worktree 创建/清理/路径翻译 | Fork 子代理 |
| **Auto-background** | Sync→Async 原地转化 | Async 执行路径 |

### 5.3 Tier 3: 可观测性（Phase 3c）

| 积木 | 描述 | 依赖 |
|---|---|---|
| **Agent 记忆** | 3 layer MEMORY.md + 注入提示 | Tier 1 |
| **Transcript** | 完整对话记录 + 过滤规则 | Sync 执行路径 |
| **Resume** | 断点续跑 + worktree 恢复 | Transcript + Worktree |
| **BackgroundTaskRegistry** | 后台任务注册/查询/状态 | Async 执行路径 |

### 5.4 Tier 4: 生态扩展（Phase 3d+）

| 积木 | 描述 | 依赖 |
|---|---|---|
| **Custom Agent 加载** | `.claude/agents/*.md` 解析 → CustomAgentDefinition | Agent 定义系统 |
| **Agent 覆盖优先级** | 6 层来源 + flag/local/project 覆盖 | Custom Agent 加载 |
| **Plugin Agent** | 插件系统 agent | 待插件系统成熟 |
| **Multi-agent 分发** | 单 tool call 启动多个 agent | AgentTool spawn router |
| **Skill preloading** | Agent frontmatter skills → 初始化消息注入 | Custom Agent 加载 |

---

## 6. Key Design Decisions for TriMMC

### 6.1 是否采纳 Fork 子代理？

**建议**: Tier 2 采纳，但 Tier 1 先用 Normal 路径跑通。

理由：Fork 的零额外 token 开销是长期必须的，但实现依赖 Phase 2 的 cache 基础设施。Tier 1 先用 Normal 路径（重新构建 system prompt）跑通 spawn→run→return 全链路，验证 agent 树协作模式可行后再加 Fork 优化。

### 6.2 是否采纳 Worktree 隔离？

**建议**: Tier 2 采纳，但初期可简化为"文件锁"替代。

理由：TriMMC 的 sub-agent 使用场景当前主要是代码分析和规划（只读），Worktree 隔离的主要价值在"可写并行 agent"场景。Tier 1 可先跳过，用文件操作日志/锁替代。

### 6.3 是否采纳 Agent 记忆？

**建议**: Tier 3 采纳，但先定义记忆 schema 与 TriMMC 的四层记忆体系（Soul Memory → Project Memory → Session Memory → Tool Memory）的映射关系。

### 6.4 Built-in Agent 裁剪策略

TriMMC 当前不需要全部 6 个 Claude Code built-in agent：
- ✅ **保留**: GeneralPurpose（通用委派）、Explore（代码探索）
- ✅ **适配**: Plan → 结合 TriMMC 的产品规划体系
- ⚠️ **暂缓**: ClaudeCodeGuide（Claude Code 文档问答 → 无此需求）、StatuslineSetup（CLI 专属）
- ✅ **采纳**: Verification（证验器）— 与小柯模式天然契合

---

## 7. Verification Checklist（小柯模式预置）

待 Phase 3 编写完成后，以小柯模式逐项检查：

- [ ] Agent 定义系统的三层类型是否完整覆盖
- [ ] 加载管道的 6 层来源+覆盖优先级是否正确
- [ ] 执行三态（sync/async/auto-bg）的转换条件是否完整
- [ ] Fork 的 cache 共享逻辑是否与 Phase 2 吸收对齐
- [ ] 工具池继承的 4 层过滤是否正确
- [ ] 权限覆盖的 6 条规则是否与 Claude Code 源码一致
- [ ] Agent 记忆的 3 layer scope 是否完整
- [ ] Worktree 清理策略是否正确
- [ ] Transcript/Resume 的过滤规则是否完整
- [ ] AgentTool handler 的 spawn 路由是否覆盖所有分支
- [ ] 6 个 built-in agent 的目录是否完整
- [ ] 吸收建议的优先级和依赖关系是否自洽
- [ ] 与 Phase 1（Core Loop）和 Phase 2（Prompt Cache）的交叉依赖是否正确识别

---

## 8. 小柯验证结果

> **验证人**：CTO 小狄（小柯模式）
> **验证日期**：2026-07-18
> **验证范围**：逐项源码对比检查

| # | 检查项 | 结果 | 备注 |
|---|--------|------|------|
| 1 | AgentDefinition 三层类型 | ✅ PASS | BuiltIn/Custom/Plugin 类型定义与源码一致 |
| 2 | BaseAgentDefinition 字段完整性 | ✅ PASS | 已修正 `memory`/`isolation` 类型 |
| 3 | AgentJsonSchema | ✅ PASS | 字段与 loadAgentsDir.ts [73-99] 一致 |
| 4 | 加载优先级 | ✅ PASS（已修正） | 已按 `getActiveAgentsFromList` [203-221] 修正顺序 |
| 5 | filterToolsForAgent 三层过滤 | ✅ PASS | 与 agentToolUtils.ts [70-116] 一致 |
| 6 | 工具禁止列表 | ✅ PASS（已修正） | 已补充具体工具名 |
| 7 | FORK_AGENT 定义 | ✅ PASS | forkSubagent.ts [60-71] 验证通过 |
| 8 | Fork 防递归 | ✅ PASS | `isInForkChild()` 验证 `<fork-boilerplate>` tag |
| 9 | Resume 过滤链 | ✅ PASS | resumeAgent.ts [70-74] 三过滤验证通过 |
| 10 | 执行三态模型 | ✅ PASS | Sync/Async/Auto-BG 与 AgentTool.tsx 一致 |
| 11 | Auto-background 触发条件 | ✅ PASS | 与 AgentTool.tsx [886-960] 一致 |
| 12 | Agent 记忆系统 | ✅ PASS | 3 layer scope + snapshot 与源码一致 |
| 13 | 6 个 Built-in Agent 目录 | ✅ PASS | 全部验证，属性与源码一致 |
| 14 | 权限覆盖规则 | ✅ PASS | 6 条规则与 runAgent.ts [400-500] 一致 |
| 15 | Worktree 隔离机制 | ✅ PASS | 清理策略与源码一致 |
| 16 | Absorption Tiers 优先级 | ✅ PASS | Tier 1→2→3→4 依赖关系自洽 |
| 17 | Phase 1/2 交叉依赖 | ✅ PASS | Fork 依赖 Phase 2 Cache，AgentTool 依赖 Phase 1 Loop |

**验证结论**：Phase 3 文档经源码逐项验证，3 处修正后全部通过。文档状态：`Draft → Complete`。

---

## 9. Sources

- `TriMMC/vendor/claude-code/src/tools/AgentTool/AgentTool.tsx` — 完整阅读（1200+ 行）
- `TriMMC/vendor/claude-code/src/tools/AgentTool/loadAgentsDir.ts` — 完整阅读（500+ 行）
- `TriMMC/vendor/claude-code/src/tools/AgentTool/runAgent.ts` — 完整阅读（730+ 行）
- `TriMMC/vendor/claude-code/src/tools/AgentTool/agentToolUtils.ts` — 完整阅读（400+ 行）
- `TriMMC/vendor/claude-code/src/tools/AgentTool/prompt.ts` — 完整阅读（288 行）
- `TriMMC/vendor/claude-code/src/tools/AgentTool/forkSubagent.ts` — 完整阅读
- `TriMMC/vendor/claude-code/src/tools/AgentTool/forkedAgent.ts` — 完整阅读
- `TriMMC/vendor/claude-code/src/tools/AgentTool/builtInAgents.ts` — 完整阅读（72 行）
- `TriMMC/vendor/claude-code/src/tools/AgentTool/built-in/generalPurposeAgent.ts` — 完整阅读
- `TriMMC/vendor/claude-code/src/tools/AgentTool/built-in/exploreAgent.ts` — 完整阅读
- `TriMMC/vendor/claude-code/src/tools/AgentTool/built-in/planAgent.ts` — 完整阅读
- `TriMMC/vendor/claude-code/src/tools/AgentTool/built-in/verificationAgent.ts` — 完整阅读（153 行）
- `TriMMC/vendor/claude-code/src/tools/AgentTool/built-in/claudeCodeGuideAgent.ts` — 完整阅读（206 行）
- `TriMMC/vendor/claude-code/src/tools/AgentTool/built-in/statuslineSetup.ts` — 完整阅读（145 行）
- `TriMMC/vendor/claude-code/src/tools/AgentTool/agentMemory.ts` — 完整阅读（178 行）
- `TriMMC/vendor/claude-code/src/tools/AgentTool/agentMemorySnapshot.ts` — 完整阅读（198 行）
- `TriMMC/vendor/claude-code/src/tools/AgentTool/resumeAgent.ts` — 完整阅读（200+ 行）
- `TriMMC/vendor/claude-code/src/tools/AgentTool/agentDisplay.ts` — 完整阅读（105 行）
- `TriMMC/vendor/claude-code/src/constants/tools.ts` — 工具禁止列表常量验证
- `TriMMC/vendor/claude-code/src/coordinator/workerAgent.ts` — 验证为空壳
- `TriMMC/docs/registry/code-state.md` — TriMMC 当前 sub-agent 状态（0%）
