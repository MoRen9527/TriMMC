# Phase 1 吸收教程：Claude Code 核心 Loop

**Trainer**：小吴（RAndDTrainer）
**蓝本**：`TriMMC/docs/engineering/claude-code-absorption/phase-1-core-loop.md`（CTO 小狄，2026-07-17）
**目标读者**：需要接手 TriMMC agent-loop 代码的研发新人
**前提**：已读过 `TriMMC/AGENTS.md` 和 `TriMMC/README.md`，了解 TriMMC 是服务域主控模块
**配套吸收计划**：CTO-003 Phase 1-4，本教程随吸收计划推进同步更新
**当前版本**：Phase 1 核心 Loop（`phase-1-core-loop.md` 完成）

> **路径说明**：预期落点 `docs/training/claude-code-absorption/phase-1-core-loop-tutorial.md`。因当前环境限制，暂落 `docs/training/phase-1-core-loop-tutorial.md`，待 shell 可用时移入子目录。

---

## 1. 先讲大的结果：我们做了什么、为什么重要

### 1.1 一句话

**我们把 Claude Code 2.1.88 的 agent 主循环（1730 行）完整拆解成了 337 行的吸收分析文档，并标记了 TriMMC 当前实现（181 行）与它的差距。**

### 1.2 这个问题为什么重要

TriMMC 的 agent-loop 是服务域的核心引擎——所有任务控制、工具调度、模型调用都在这个循环里跑。当前实现是一个「能跑通」的 181 行 while-true：

- 调模型 → 拿结果 → 有 tool_use 就执行 → 结果追加到历史 → 下一轮
- 能处理 6 个内置工具，最多跑 25 轮

但这只是 Claude Code 1730 行主循环的 **~15%**。缺失的 85% 不是「锦上添花」，而是决定生产级 agent 能否在长对话、异常场景、多工具调用、上下文溢出等情况下不崩溃的关键能力。

**Claude Code 为什么要 1730 行？** 因为它要处理：
- 模型调用如何流式+容错（streaming + fallback）
- 上下文溢出如何自愈（auto-compact + reactive compact + collapse drain 三级恢复）
- 什么叫「用完了」要停下来（token budget + stop hooks + 11 种退出原因）
- 用户中断了怎么办（abort handling 两条路径）
- 工具调用如何不阻塞（streaming executor 边流式接收边执行）

这些 TriMMC 目前都没有。**Phase 1 吸收分析的产出，就是把「都没有」变成「都知道缺什么、先补什么」**。

### 1.3 学习本教程后的收获

| 你会学到 | 对应场景 |
|----------|----------|
| Claude Code agent 主循环的完整架构 | 读 `vendor/claude-code/src/query.ts` 前建立地图 |
| State 管理为什么用 spread-replace 而不是 in-place mutation | 接手 loop.ts 重构时的核心决策 |
| 每轮循环 4 个阶段（Pre-Model → Streaming → Recovery → Tool Exec）分别做什么 | 理解代码结构而非死记 |
| 11 种「停下」的原因 vs 11 种「继续」的原因 | 读懂 agent 的状态机 |
| 错误自愈级联（Error Recovery Cascade）——整个 query.ts 最高杠杆的模式 | 让 agent-loop 从「异常即死」变成「尽量自愈」 |
| 从当前 181 行到生产级的 5 步实施路线图 | 知道先改什么、为什么 |

---

## 2. 再讲理论方法和协议

### 2.1 核心思维模型：双层 AsyncGenerator

Claude Code 的 agent 循环不是一个函数，而是**两层嵌套的 async generator**：

```
query(params)            ← 外层：命令生命周期（通知、清理、队列排空）
  └─ queryLoop(params)   ← 内层：while-true 循环（真正干活的）
```

你不需要立刻理解 `query()` 的每个细节，但要记住这个分层逻辑：
- **外层**管「一次 agent 会话的开始和结束」
- **内层**管「每一轮 turn 的迭代逻辑」

TriMMC 目前只有内层（`agentLoop()`），这是正确的——我们先吸收内层，外层按需补。

### 2.2 四种数据结构的分工

Claude Code 把循环的输入拆成四种结构：

| 结构 | 类比 | 可变？ | TriMMC 对应 |
|------|------|--------|------------|
| `QueryParams` | 餐厅的菜单（顾客点了什么） | ❌ 不可变 | `AgentLoopOptions` |
| `QueryConfig` | 餐厅的营业执照（能做什么） | ❌ 不可变 | 环境变量/配置 |
| `QueryDeps` | 厨房设备（提供什么能力） | ❌ 可替换（测试用） | `createModelClient()` + `executeTool()` |
| `State` | 正在做的菜的状态 | ✅ 可变（但用替换方式） | `LoopState`（目前就地修改） |

**关键理解**：前三个是「输入契约」，State 是「运行时快照」。把不可变输入和可变状态分开，是让复杂循环可控的第一步。

### 2.3 State 管理协议：只替换、不修改

这是整个吸收分析里**最重要的一个协议**——不是最复杂的，但是最基础、最容易在一开始就做对的。

```typescript
// ❌ 就地修改（TriMMC 当前做法）
state.messages.push(assistantMsg);    // 改了原来的数组
state.messages.push(...toolResults);  // 又改了
state.turnCount++;                     // 改了数字

// ✅ 整体替换（Claude Code 做法）
state = {
  messages: [...state.messages, assistantMsg, ...toolResults],
  turnCount: state.turnCount + 1,
  // 其他字段不变
};
```

**为什么这很重要？** 当循环只有一个 continue 点时，就地修改没问题。但 Claude Code 有 **11 个不同的 continue 点**（模型 fallback 继续、错误恢复继续、token budget 继续……）。如果你在每个 continue 点都就地修改，很快就会出现「某个计数器忘了清零」「某个字段被上一轮残留污染」的 bug。

**一句话记忆**：State = 上一轮的 State + 本轮的变化 = 一个新对象。

### 2.4 每轮循环的四阶段 pipeline

```
┌─────────────────────────────────────────────────┐
│ Phase A: Pre-Model-Call（调模型前）               │
│ turnCount++ → 上下文收窄 → 自动压缩 → token 检查   │
├─────────────────────────────────────────────────┤
│ Phase B: Model Call + Streaming（调模型）         │
│ 流式调用 → 边收边执行工具 → 错误暂存不抛出         │
├─────────────────────────────────────────────────┤
│ Phase C: Post-Model Recovery（模型返回后，无工具） │
│ 错误自愈级联 → stop hooks → token budget → 结束    │
├─────────────────────────────────────────────────┤
│ Phase D: Tool Execution + State Transition（有工具）│
│ 执行工具 → 附件管线 → 状态构造 → 下一轮            │
└─────────────────────────────────────────────────┘
```

TriMMC 当前实现等价于：Phase B（非流式）→ Phase D（顺序执行工具）→ 循环。缺少 Phase A 的预处理和 Phase C 的自愈能力。

---

## 3. 先用最小 MVP 跑通全流程

### 3.1 跑起来：TriMMC 当前 agent-loop 的完整走读

打开 `TriMMC/src/agent-loop/loop.ts`（181 行），我们从入口一路走到出口。

#### 入口：`agentLoop(options)`

```typescript
export async function* agentLoop(options: AgentLoopOptions): AsyncGenerator<AgentEvent>
```

这是一个 **async generator**——调用方通过 `for await (const event of agentLoop(opts))` 消费事件流。每个 `yield` 都是一条事件。

#### 步骤 1：初始化（第 45-68 行）

```
model = options.model ?? 'deepseek-v4-pro'
maxTurns = options.maxTurns ?? 25
modelClient = createModelClient()          // TriModel 的模型客户端
tools = getToolDefinitions()               // 6 个内置工具
seedMessages = [systemPrompt, ...userMessages]  // 构建初始消息
state = { messages: seedMessages, turnCount: 1, maxTurns }
accumulator = new UsageAccumulator()        // token 用量累计器
yield { type: 'loop_start' }               // 通知调用方循环开始
```

**关键点**：`UsageAccumulator` 是 CTO-007 加的，跨 turn 累计 TokenUsage。

#### 步骤 2：while(true) 循环体（第 70-155 行）

```
while (true):
  ├─ maxTurns 检查（第 72-75 行）    → 超过 25 轮 → loop_end(max_turns) → return
  ├─ request_start 事件（第 78 行）   → 通知调用方本轮到模型了
  ├─ modelClient.chat()（第 82 行）  → 调用 DeepSeek，一次拿到完整响应
  │   └─ 异常（第 84-89 行）         → error 事件 → loop_end(error) → return ⚠️ 无自愈
  ├─ assistant_message 事件（第 92-97 行）→ 输出模型回复
  ├─ 追加 assistant 消息到历史（第 99-107 行）→ state.messages.push() ⚠️ 就地修改
  ├─ 无 tool_use？（第 110-118 行）   → loop_end(done) → return
  └─ 有 tool_use（第 120-154 行）：
      for (const tc of tool_calls):
        ├─ tool_call 事件
        ├─ JSON.parse 参数
        ├─ executeTool(name, args)  → 顺序执行，等一个完再下一个 ⚠️ 非流式
        ├─ tool_result 事件
        └─ 结果 push 到 toolResults
      state.messages.push(...toolResults)  ⚠️ 就地修改
      state.turnCount++                    ⚠️ 就地修改
      循环继续（无显式 state = {}）
```

#### 步骤 3：`runAgentLoop()` 便捷封装（第 160-180 行）

把 async generator 收集成一次性结果：`{ events, finalMessage, usage }`。

### 3.2 验证：如何确认它跑通了

```bash
cd TriMMC
npm test -- --testPathPattern="agent"  # 运行 agent-loop 相关测试
```

当前 55 个测试全部通过。这是 Phase 1 的基线。

### 3.3 MVP 小结

| 能做什么 | 不能做什么 |
|----------|-----------|
| 调模型 → 拿工具调用 → 执行 → 下一轮 | 流式接收响应（等全部返回才处理） |
| 6 个内置工具 | 工具执行与模型调用重叠（等模型完全返回才执行工具） |
| 最多 25 轮 | 错误自愈（任何模型异常直接退出） |
| token 用量累计 | 上下文压缩（长对话会溢出） |

---

## 4. 再由浅入深拆原理

### 4.1 入口层：从 `agentLoop(options)` 到 `queryLoop(params)`

TriMMC 的 `AgentLoopOptions`（8 个字段）对应 Claude Code 的 `QueryParams`（20+ 字段）。差距不是「写更多字段」，而是 Claude Code 把入口分成了三层：

```
QueryParams（不可变输入：systemPrompt, maxTurns, userContext...）
QueryConfig（会话级开关：streamingToolExecution, isAnt, fastMode...）
QueryDeps（可替换能力：callModel, autocompact, microcompact, uuid...）
```

TriMMC 当前把所有配置都塞在 `AgentLoopOptions` 里，这在小规模 OK，但随着 compaction、hooks、attachment pipeline 等能力加入，需要提前规划分层。**先不用改，但要记住这个三明治模型**。

### 4.2 参数层：State 的 10 个字段 vs 3 个字段

| Claude Code State 字段 | TriMMC State 字段 | 用途 |
|------------------------|-----------------|------|
| `messages: Message[]` | `messages: Message[]` | ✅ 已对齐 |
| `toolUseContext` | 无 | 工具上下文（文件权限、工作目录等） |
| `autoCompactTracking` | 无 | 压缩追踪（压缩了几次、清了多少 token） |
| `turnCount` | `turnCount` | ✅ 已对齐，但用就地修改 |
| `maxOutputTokensRecoveryCount` | 无 | 输出 token 超限恢复次数计数器 |
| `hasAttemptedReactiveCompact` | 无 | 本轮是否已尝试过反应式压缩（防死循环） |
| `pendingToolUseSummary` | 无 | 待发出的工具使用摘要 |
| `maxOutputTokensOverride` | 无 | 输出 token 上限覆写 |
| `stopHookActive` | 无 | 本轮 stop hook 是否激活 |
| `transition: string` | 无 | 本轮状态转换原因（next_turn / collapse_drain_retry ...） |

**关键理解**：State 的字段数量和循环的 continue 点数量正相关。TriMMC 只有 1 个 continue 点（tool exec 后 always continue），所以 3 个字段够用。Claude Code 有 11 个 continue 点，每个点都可能修改不同的字段，因此需要 10 个字段 + 显式 transition 标记。

### 4.3 分发层：从「一个 continue 点」到「11 个 continue 点」

当前 TriMMC 的决策树：

```
有 tool_use? → 是 → 执行工具 → 继续循环
           → 否 → 结束
```

Claude Code 的决策树（简化）：

```
有 tool_use? → 是 → 执行工具 → 附件注入 → max_turns 检查 → state 构造 → 继续
           → 否 → 有 withheld error?
                    → 是 → collapse drain? → 继续
                          → reactive compact? → 继续
                          → 都失败 → 结束（prompt_too_long）
                    → 否 → stop hooks 检查 → 阻止? → 结束
                          → token budget 检查 → 耗尽? → 结束
                          → 正常结束（completed）
```

**记住这个递进关系**：「结束」不是只有一种，而是有 11 种不同的结束原因。每种原因对应不同的清理逻辑和调用方通知。

### 4.4 业务层：Error Recovery Cascade 详解

这是整个吸收分析中**杠杆率最高**的一个模式。TriMMC 当前：

```typescript
catch (err) {
  yield { type: 'error', message: msg };
  yield { type: 'loop_end', reason: 'error' };
  return;  // ← 死路一条
}
```

Claude Code 不会直接抛出错误——它**先尝试自愈**，自愈失败才真正结束。三层自愈：

```
Prompt-Too-Long (413):
  尝试 collapse drain（清空暂存的上下文收窄）→ 便宜、精细
  失败 → 尝试 reactive compact（用 Haiku 模型做完整对话摘要）→ 贵、彻底
  失败 → surface error（真正抛出）→ 最后手段

Max-Output-Tokens:
  尝试 8k → 64k token 上限提升 → 单次重试
  失败 → 注入 resume message 让模型继续（最多 3 次）→ 多轮恢复
  失败 → surface error

Model Failure:
  尝试 streaming fallback（同模型清状态重试）→ 清除部分状态
  失败 → 切换 fallback 模型 → 换模型
  失败 → surface error
```

**设计原则**：每个阶段只试一次。collapse drain 失败 → 直接跳到 reactive compact，不回退重试 collapse。这样既最大化自愈机会，又不会陷入无限恢复循环。

### 4.5 落盘层：消息历史的追加

Claude Code 不只是 `state.messages.push()`。它区分多种消息类型：

- **assistant 消息**：模型原始输出
- **tool_result 消息**：工具执行结果
- **postCompactMessages**：压缩后注入的摘要消息
- **blocking error 消息**：stop hook 注入的阻断错误
- **nudge 消息**：token budget 注入的提醒
- **resume 消息**：max output token 恢复注入的续写提示
- **attachment 消息**：附件管线注入的系统消息
- **task summary 消息**：定期任务摘要

每种消息的注入时机和优先级不同。TriMMC 目前只处理前两种。

### 4.6 校验层：Stop Hooks 和 Token Budget

**Stop Hooks**：模型返回后、结束前，运行一组校验函数。如果校验函数返回「阻止继续」，agent 停下来；返回「有阻断错误」，把错误注入消息历史继续；返回「没问题」，正常结束。

**Token Budget**：追踪累计 token 消耗。规则很简单：
- 消耗超过 90% 总预算 → 注入提醒消息（「你的 token 快用完了，请尽快收尾」）
- 连续 3 轮 token 增量 < 500 → 对话已进入「收益递减」→ 自动结束

这两层校验在 Claude Code 中是独立的决策点，不是耦合在循环逻辑里的。TriMMC 吸收时也应该保持独立。

---

## 5. 再从 MVP 丰富到当前实现

### 5.1 每增加一层复杂度，都要说明它解决了什么

| 复杂度增量 | 解决的问题 | 实现成本 |
|-----------|-----------|---------|
| **State spread-replace** | 防止多 continue 点状态污染 | 低（纯重构） |
| **Streaming tool executor** | 多工具调用串行延迟（模型在输出 tool_use 时就开始执行） | 中（需要改造执行模型） |
| **错误恢复级联** | 「模型异常即死亡」 | 中（3 种错误 × 2-3 层恢复） |
| **Auto-compact** | 长对话上下文溢出 | 高（需要总结模型 + 消息替换逻辑） |
| **Token budget** | 成本失控 + 收益递减的对话继续浪费 token | 低（计数器 + 两个阈值） |
| **Stop hooks** | 无法在对话结束前验证/干预 | 中（hook 框架 + 注册机制） |
| **Attachment pipeline** | 多 agent 上下文注入 | 高（命令队列 + 内存预取 + skill 发现） |

### 5.2 吸收优先级矩阵

```
优先级 = 影响 × 可行性 × 当前痛苦程度

Tier 1（立即做，高杠杆）:
  1. State spread-replace                    — 纯重构，防止未来 bug
  2. 错误恢复级联（先做模型 fallback）       — 消灭单点故障
  3. Streaming tool executor                — 多工具延迟降低 30-50%

Tier 2（下周做，中等投入）:
  4. Auto-compact（主动压缩）               — 延长对话长度
  5. Token budget tracker                   — 成本护栏
  6. Max-output-tokens recovery             — 长响应自愈

Tier 3（后续，低紧迫）:
  7. Stop hooks                              — 校验面
  8. Attachment pipeline                    — 多 agent 上下文
  9. Reactive compact + context collapse    — 高级压缩
  10. Tool use summaries                    — UX 优化
```

---

## 6. 最后讲完整实现和生产级考虑

### 6.1 从 181 行到生产级的 5 步路线图

#### Step 1：State 管理改造（立即）

```typescript
// Before
state.messages.push(assistantMsg);
state.messages.push(...toolResults);
state.turnCount++;

// After
state = {
  messages: [...state.messages, assistantMsg, ...toolResults],
  turnCount: state.turnCount + 1,
};
```

**影响范围**：`loop.ts` 第 107、153-154 行。**风险**：极低，纯机械替换。**测试**：现有 55 个测试应全部通过。

#### Step 2：错误恢复级联（本周）

当前只有一种错误处理：

```typescript
catch (err) { yield error; return; }
```

改为三层恢复：

```
catch (err):
  识别错误类型（prompt-too-long / max-output-tokens / model-failure / 其他）
  ├─ model-failure → 切换 fallback 模型 → continue
  ├─ 其他可恢复 → 尝试恢复策略 → 成功 → continue
  └─ 不可恢复 → yield error → return
```

**先从最小成本开始**：模型 fallback。TriStaciss 已经配置为 fallback provider，只需要在 catch 块里做模型切换。

#### Step 3：Streaming tool executor（本周）

当前执行模型：模型完全返回 → 顺序执行工具。

改为：模型开始返回 tool_use 块 → 立即启动工具执行（与后续 tool_use 块的接收并行）。

**核心改造**：`modelClient.chat()` 改为流式接口，对每个 `tool_use` delta 立即 dispatch `executeTool()`。

#### Step 4：Auto-compact（下周）

当消息历史的 token 数接近上下文窗口上限时，在调模型**之前**做一次自动压缩：
- 用一个小模型（如 DeepSeek Chat）生成对话摘要
- 用摘要替换原始历史（保留最近 N 轮）
- 清空压缩追踪计数器

#### Step 5：Token budget + Stop hooks（下周）

Token budget 相对独立，可以先行：
- `BudgetTracker` 类，追踪累计 token
- 90% 阈值注入提醒
- 连续 3 轮增量 < 500 → 结束

Stop hooks 需要先设计 hook 注册机制，建议放到 Phase 3（Sub-Agent 树）吸收时一起考虑。

### 6.2 Gap 全景：现在有什么、缺什么

```
✅ 已有（7 项）：
  while-true loop       async generator yield     max turns guard
  tool dispatch        tool result → history       model call abstraction
  TriModel UsageAccumulator

❌ 缺失 — Tier 1（6 项，高优先）：
  streaming tool executor     streaming fallback      fallback model
  error recovery cascade     orphan tombstoning       abort handling

❌ 缺失 — Tier 2（7 项，中优先）：
  auto-compact      reactive compact     context collapse
  microcompact      token budget         token blocking limit
  snip

❌ 缺失 — Tier 3（6 项，低优先）：
  stop hooks       post-sampling hooks    attachment pipeline
  tool use summary  tool refresh          periodic task summary
```

### 6.3 扩展点：给未来预留的接口

在实施以上改造时，注意几个扩展点：

1. **模型调用抽象**：`modelClient.chat()` 已经是一个好的抽象层，继续保持 provider-agnostic
2. **工具注册表**：`getToolDefinitions()` 返回工具列表的模式保持，后续直接对接 ToolGater
3. **事件类型**：`AgentEvent` 的 union type 设计很好，新增事件只需加 type
4. **异步生成器模式**：`AsyncGenerator<AgentEvent>` 是最灵活的输出接口，不要改成 Promise 一次性返回

### 6.4 测试策略

| 改造 | 测试方法 | 验证标准 |
|------|---------|---------|
| State spread-replace | 现有 55 测试全过 | 行为不变 |
| 错误恢复 | 模拟模型异常 + 验证 fallback 触发 | 不应直接 loop_end(error) |
| Streaming executor | 多工具调用的端到端延迟 | 延迟降低 30-50% |
| Auto-compact | 长对话测试 + 验证压缩后 token 数下降 | 压缩后不再触发上下文溢出 |
| Token budget | 设定小 budget + 验证提醒/停止 | 90% 提醒、3 轮递减停止 |

---

## 7. 稳定心智模型（可复用骨架）

做完本教程后，你应该能在脑子里建起这个骨架：

```
Agent Loop 核心骨架：

1. 输入分三层：不可变 params + 会话 config + 可替换 deps
2. 状态用替换：state = { ...state, 本轮变化 }
3. 循环四阶段：预处理 → 流式调用 → 恢复自愈 → 工具执行+状态转移
4. 退出有原因：11 种 terminal + 11 种 continue，每种有明确触发条件
5. 错误不自尽：先 collapse drain → reactive compact → surface（每层只试一次）
6. 工具有策略：流式执行（边收边做）优先于批量执行（全收再做）
7. 预算有护栏：90% 提醒 + 连续递减检测

当前 TriMMC → 生产级，按 5 步走：
  State 改造 → 错误恢复 → 流式执行 → 自动压缩 → Token budget
```

这个骨架同样适用于后续 Phase 2-4 的吸收分析——每次新增的能力都可以映射到骨架的对应层（Phase 2 映射到「循环四阶段」的预处理和恢复、Phase 3 映射到「输入分层」的 deps、Phase 4 映射到「工具有策略」的安全层）。

---

## 使用依据

| 依据 | 路径 |
|------|------|
| 蓝本（吸收分析） | `TriMMC/docs/engineering/claude-code-absorption/phase-1-core-loop.md` |
| 当前实现 | `TriMMC/src/agent-loop/loop.ts`（181 行） |
| 吸收目标 | `TriMMC/vendor/claude-code/src/query.ts`（1730 行） |
| 代码状态 | `TriMMC/docs/registry/code-state.md` |
| 模块规则 | `TriMMC/AGENTS.md` |
| Phase 1 执行记录 | `TriMMC/docs/engineering/phase-1-execution-note.md` |
| 配套组件 | `TriMMC/vendor/claude-code/src/query/tokenBudget.ts`、`stopHooks.ts`、`config.ts`、`deps.ts` |

## 版本跟踪

| 日期 | 变更 | 触发 |
|------|------|------|
| 2026-07-14 | 初始版本，以 Phase 1 吸收分析为蓝本 | CTO-003 Phase 1 完成 |
| — | 待更新：Phase 2 吸收分析完成后补充 Prompt 缓存章节 | CTO-003 Phase 2 |
| — | 待更新：Phase 3 吸收分析完成后补充 Sub-Agent 树章节 | CTO-003 Phase 3 |
| — | 待更新：Phase 4 吸收分析完成后补充 Tool 权限模型章节 | CTO-003 Phase 4 |
