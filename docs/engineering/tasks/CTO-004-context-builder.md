# CTO-004: Context Builder

> **依赖**: CTO-008权限模型（tier信息源）
> **小全 + 小柯 Pipeline**: ✅ Phase 1-3 complete, CTO review

## 背景

TriMMC v0.2.0 编排层四组件之一：**Context Builder**（公司背景 + registry 引用 → CLAUDE.md 注入）。目标是让每个 agent 实例的 system prompt 自动携带项目上下文（模块角色、tier能力、AGENTS.md、code-state 摘要），而非依赖调用者手动拼接。

吸收自 Claude Code `prompt.ts` 的 section-building 模式，但不复制其 agent tool listing——Context Builder 注入的是**项目上下文**，而非工具列表。

## 改动范围

| 文件 | 变更 |
|------|------|
| `src/context-builder/context-builder.ts` | NEW: `buildContext()` + `mergeContextWithPrompt()` + 5 个 section builder |
| `test/context-builder/context-builder.test.ts` | NEW: 16 测试（5 suites） |
| `src/agent-loop/loop.ts` | +4/-1: import ContextSources, AgentLoopOptions 新增 `context?`, seed message 构建前注入 |
| `docs/registry/code-state.md` | +1 CTO-004 entry |
| `docs/engineering/tasks/CTO-004-context-builder.md` | NEW: 本文件 |

## Phase 1: 小全实现

### context-builder.ts 核心 API

1. **ContextSources 接口**: 所有字段可选（除 tier 必填），支持 agentsMd / codeState / role / extraContext
2. **buildContext()**: 按 Role → Tier → AGENTS.md → Code State → Extra 顺序组装 Markdown 章节
3. **mergeContextWithPrompt()**: context 前缀 + `---` + systemPrompt，匹配 Claude Code 注入惯例

### loop.ts 集成

- `AgentLoopOptions` 新增 `context?: ContextSources`
- `agentLoop()` 在构建 seed messages 前调用 `buildContext(context) → mergeContextWithPrompt(contextBlock, systemPrompt)` 生成 `effectiveSystemPrompt`

## Phase 2: 小柯验证

```
node scripts/validate.mjs
```

| 门禁 | 结果 |
|------|------|
| TypeScript 类型检查 | ✅ PASS |
| 全部测试 | ✅ 131/131 PASS |
| 最小测试数 | ✅ 131 ≥ 1 |

### 测试覆盖（16 新测 + 115 存量 = 131）

| Suite | 测试数 | 覆盖内容 |
|-------|--------|----------|
| Suite 1: 完整上下文组装 | 2 | 全部源输出所有章节 + 章节顺序 |
| Suite 2: Tier 能力注入 | 4 | main(6)/subagent(5)/coordinator(1) + TIER_DESCRIPTIONS |
| Suite 3: 稀疏/最小上下文 | 4 | 仅tier/role+tier/空extraContext/空白agentsMd |
| Suite 4: mergeContextWithPrompt | 4 | ---分隔/仅context/仅prompt/皆空 |
| Suite 5: ContextSources 类型合约 | 2 | 全可选字段/tier必填 |

## 设计决策

| 决策 | 说明 |
|------|------|
| context 块以 `---` 分隔 | 匹配 Claude Code system prompt 前缀注入惯例 |
| ContextSources tier 必填 | 能力注入是 Context Builder 的最小价值——无 tier 则无 Capabilities 章节 |
| 不在 seed messages 创建后修改 | buildContext + merge 在 seed message 构建前完成，不搞消息数组后期注入 |
| 章节顺序固定 Role→Tier→Module→Code→Extra | 角色身份先于能力、能力先于领域知识 |

## 影响分析

- **编排层进度**: v0.2.0 四组件中 Context Builder 首先完成
- **agentLoop 行为**: 不传 `context` 时行为完全不变（向后兼容）
- **后续集成点**: TriMMC HTTP server 在构建 agent 实例时可通过 ContextSources 注入模块背景

---

## CTO Sign-off

> **Approved ✅**
> Phase 1-3 全部 131/131 测试 PASS，类型检查通过。
> Context Builder 是 v0.2.0 编排层首个落地的完整组件——项目上下文注入从手动拼接变为标准化 API。
