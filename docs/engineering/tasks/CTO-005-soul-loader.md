# CTO-005: Soul Loader

> **依赖**: CTO-004 Context Builder, AgentContract Schema v1
> **小全 + 小柯 Pipeline**: ✅ Phase 1-3 complete, CTO review

## 背景

TriMMC v0.2.0 编排层四组件之二：**Soul Loader**（agent contract → 系统提示词）。将 AgentContract 六要素（Identity / Responsibilities / Decision Rights / Collaborators / Instructions / Tools）转换为结构化 Markdown 系统提示词，通过 `contractToContextSources()` 直接插入 Context Builder pipeline。

吸收自 Claude Code 的 `formatAgentLine()` 模式——每行是一个格式化条目，但不复制其 agent tool listing 目的。

## 改动范围

| 文件 | 变更 |
|------|------|
| `src/soul-loader/soul-loader.ts` | NEW: `contractToPrompt()` + `contractToContextSources()` + 6 section builders |
| `test/soul-loader/soul-loader.test.ts` | NEW: 23 tests (7 suites) |
| `docs/registry/code-state.md` | +1 CTO-005 entry |
| `docs/engineering/tasks/CTO-005-soul-loader.md` | NEW: 本文件 |

## Phase 1: 小全实现

### soul-loader.ts API

1. **contractToPrompt(contract)**: AgentContract → Markdown system prompt
   - 6 section builders: Identity / Responsibilities / Decision Rights / Collaborators / Instructions / Tools
   - 空章节自动省略（无 instructions、无 tools 时不输出对应章节）
   - 章节顺序固定：Identity → Responsibilities → Decision Rights → Collaborators → Instructions → Tools

2. **contractToContextSources(contract, tier)**: AgentContract + tier → ContextSources
   - `role` = contract identity display_name
   - `extraContext` = prompt 逐行拆分为 string[]
   - 可直接传入 `AgentLoopOptions.context` 启动 agent

### section builders 行为

| 章节 | 条件 | 特殊格式 |
|------|------|----------|
| Identity | 始终输出 | user_invocable → "user-invocable" / "NOT user-invocable" |
| Responsibilities | responsibilities.length > 0 | priority 标签：[HIGH]/[MEDIUM]/[LOW] |
| Decision Rights | 始终输出 | approve/freeze/escalate/forbidden 有值才输出对应行 |
| Collaborators | 始终输出 | peers/supervises 有值才输出 |
| Instructions | instructions 非空 | 无此字段或空白字符串时省略 |
| Tools | tools.length > 0 | risk_level(非low) + requires_approval 标签 |

## Phase 2: 小柯验证

```
node scripts/validate.mjs
```

| 门禁 | 结果 |
|------|------|
| TypeScript 类型检查 | ✅ PASS |
| 全部测试 | ✅ 154/154 PASS |
| 最小测试数 | ✅ 154 ≥ 1 |

### 测试覆盖（23 新测 + 131 存量 = 154）

| Suite | 测试数 | 覆盖内容 |
|-------|--------|----------|
| Suite 1: 完整合约 | 2 | 全部六章节 + 章节顺序 |
| Suite 2: 最小合约 | 4 | 省略空章节 / user_invocable=false / Registry family / 空 decision_rights |
| Suite 3: 部分合约行为 | 5 | 无 instructions / 空白 instructions / 无 tools / 部分 decision_rights |
| Suite 4: 工具格式化 | 3 | low风险隐藏 / medium+high显示 / requires_approval |
| Suite 5: 协作者格式化 | 3 | peers / supervises / 无时省略 |
| Suite 6: contractToContextSources | 4 | role+tier / extraContext逐行匹配 / subagent/coordinator tier |
| Suite 7: 责任项格式 | 2 | 有priority标签 / 无priority无后缀 |

## 设计决策

| 决策 | 说明 |
|------|------|
| contractToPrompt 返回 Markdown | 与 Context Builder 的格式约定一致，section 标题用 `##` |
| extraContext 逐行拆分 | 匹配 ContextSources.extraContext 的 string[] 契约 |
| display_name 作为 role | Context Builder 的 `## Agent Role` 章节直接使用员工名 |
| 不引入文件系统依赖 | Soul Loader 接收已解析的 AgentContract，不自己加载 YAML |
| 空 decision_rights 仍输出章节 | 给 LLM 明确信号：该 agent 没有审批/冻结/升级/禁止权限 |

## 影响分析

- **编排层进度**: v0.2.0 四组件中 Context Builder + Soul Loader 两个完成
- **后续集成**: TriMMC HTTP server 可通过 `resolveContracts()` → `contractToContextSources()` → `agentLoop({context})` 启动员工 agent
- **向后兼容**: 不传 context 时 agentLoop 行为不变

---

## CTO Sign-off

> **Approved ✅**
> Phase 1-3 全部 154/154 PASS，类型检查通过。
> Soul Loader 补全了 v0.2.0 编排层的提示词生成链路：Contract → Soul Loader → Context Builder → agentLoop。
