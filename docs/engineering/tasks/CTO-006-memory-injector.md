# CTO-006: Memory Injector

## 状态：COMPLETE ✅

## 概述

Memory Injector 是 v0.2.0 编排层第三个落地组件。它将四层记忆模型（soul / memory / colleagues / social）转换为 `memdir/` 下的 Markdown 文件，并通过 `buildMemoryContext()` 产出 `ContextSources.extraContext` 行，嵌入 Claude Code `query.ts` 上下文注入链路。

## 四层记忆模型

| 层级 | 目录 | 文件 | 内容 |
|------|------|------|------|
| Soul | `memdir/soul/` | `SOUL.md` | Agent 身份快照（displayName, family, role, description, instructions） |
| Memory | `memdir/memory/` | `<key>.md` | 情景记忆键值对（每 key 一个文件） |
| Colleagues | `memdir/colleagues/` | `<agentId>.md` | 同事能力摘要（role, responsibilities, reportsTo） |
| Social | `memdir/social/` | `graph.md` | 社会关系图（reportsTo, peers, supervises, collaborationNotes） |

## 文件格式

所有 `.md` 文件使用 YAML frontmatter + Markdown body：

```yaml
---
type: soul | memory | colleagues | social
agent_id: <string>
description: <string>
timestamp: <ISO-8601>  # 可选
---
# Markdown 正文
```

## 导出 API

| 函数 | 用途 |
|------|------|
| `injectSoul(soul, memdirPath)` | 写入 `soul/SOUL.md` |
| `injectMemories(memories, agentId, memdirPath)` | 写入 `memory/<key>.md`（空数组返回 0 文件） |
| `injectColleagues(colleagues, memdirPath)` | 写入 `colleagues/<agentId>.md`（空数组返回 0 文件） |
| `injectSocial(social, memdirPath)` | 写入 `social/graph.md` |
| `injectAll(payload, memdirPath)` | 组合注入（只写入 payload 中存在的层） |
| `buildMemoryContext(memdirPath)` | 扫描 memdir 所有 `.md`，产出 `string[]` manifest |
| `contractToSoulMemory(contract)` | AgentContract → SoulMemory 桥接 |

## 文件位置

- 实现：`src/memory-injector/memory-injector.ts`（~405 行）
- 测试：`test/memory-injector/memory-injector.test.ts`（~350 行，8 suites，25 tests）

## 验证结果

- **tsc --noEmit**：✅ PASS
- **测试**：25/25 PASS（全量 179/179 PASS）
- **门禁**：typeCheck + allTests + minTestCount 全部通过

## 设计决策

- 吸收 Claude Code `memdir/memoryTypes.ts` 的 frontmatter 约定（type / description / timestamp）
- 未使用 Claude Code 的 `user` / `feedback` / `project` / `reference` 分类体系——TriMMC 使用独立的四层记忆模型（soul / memory / colleagues / social）
- `buildMemoryContext()` 是 Claude Code `formatMemoryManifest()` 的简化版——只扫描 frontmatter + 首行正文
- 空 memory / colleagues 数组优雅跳过（返回 `{ files: [], count: 0 }`）
- key 安全化：`[^a-zA-Z0-9_-]` → `_`，截断 64 字符
- Windows 路径兼容：测试使用 `endsWith('SOUL.md') + includes('soul')` 模式而非硬编码 `/`

## 编排层嵌入路径

```
AgentContract → Soul Loader → ContextSources (systemPrompt)
            → Memory Injector → memdir/ → buildMemoryContext() → ContextSources (extraContext)
                                              ↓
                              Context Builder → mergeContextWithPrompt()
                                              ↓
                                        agentLoop()
```

Memory Injector 产出物以 `extraContext` 注入 Context Builder，与 Soul Loader 产出的 `systemPrompt` 合并后由 `mergeContextWithPrompt()` 组装为最终 prompt 前缀。

## v0.2.0 编排层完成度

| 组件 | CTO | 状态 |
|------|-----|------|
| Context Builder | CTO-004 | ✅ COMPLETE |
| Soul Loader | CTO-005 | ✅ COMPLETE |
| Memory Injector | CTO-006 | ✅ COMPLETE |
| Tool Gater | — | ⏳ PENDING |

编排层 3/4 完成。Pipeline: Contract → Soul Loader → Context Builder + Memory Injector → Tool Gater → agentLoop。
