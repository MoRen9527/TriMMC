# CTO-008: Tool Permission System (Phase 4 Tier 1 Absorption)

> **Source**: Claude Code 2.1.88 `vendor/claude-code/src/constants/tools.ts`  
> **Absorption Tier**: Tier 1 (MVP)  
> **小全 + 小柯 Pipeline**: ✅ Phase 1-2 complete, Phase 3 CTO review  

## 背景

Claude Code 的 agent 工具体系有明确的分层权限模型（5 个权限集合），确保不同角色代理不能越权操作。TriMMC 在 CTO-007 前所有子代理拥有完整 6 工具权限——缺乏递归防护和权限隔离。

## 吸收设计

### 三级代理权限模型

| Tier | 工具数 | 包含工具 | 用途 |
|------|--------|---------|------|
| `main` | 6 | read_file, write_file, edit_file, shell_exec, glob_search, task | 主代理，完全访问 |
| `subagent` | 5 | read_file, write_file, edit_file, shell_exec, glob_search | 子代理，读写+Shell，**禁止 task（防递归）** |
| `coordinator` | 1 | task | 纯编排器，仅创建子代理 |

### 新增文件

| 文件 | 行数 | 说明 |
|------|------|------|
| `src/agent-loop/permissions.ts` | ~100 | AgentTier 类型、TOOL_TIER_ALLOWLIST、canUseTool、filterToolsForTier、getTierSummary |
| `test/agent-loop/permissions.test.ts` | ~240 | 8 套件 26 测试（权限模型、边界、过滤、摘要、事件契约、递归防护） |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/agent-loop/tools.ts` | `getToolDefinitions(tier?)` 接受可选 AgentTier 参数 |
| `src/agent-loop/loop.ts` | AgentLoopOptions 新增 tier + parentCallIds，工具执行前 canUseTool 检查，loop_start 事件输出 tier 信息，新增 tool_blocked 事件类型 |

## Phase 1 — 小全实现 ✅

- 创建 `permissions.ts`：AgentTier 类型、TOOL_TIER_ALLOWLIST、canUseTool、filterToolsForTier、getTierSummary、TIER_DESCRIPTIONS
- 增强 `tools.ts`：getToolDefinitions(tier?) 支持层级过滤
- 增强 `loop.ts`：AgentLoopOptions.tier、执行前权限检查、tool_blocked 事件
- 26 项测试：8 套件覆盖全部层级、边界、过滤、摘要、事件契约和递归防护

## Phase 2 — 小柯验证 ✅

```json
{
  "target": "test/agent-loop/permissions.test.ts",
  "verdict": "PASS",
  "typeCheck": { "passed": true },
  "tests": { "total": 26, "passed": 26, "failed": 0 },
  "gates": { "typeCheckPassed": true, "allTestsPassed": true, "minTestCount": true }
}
```

全量回归：`test/**/*.test.ts` → 111/111 PASS ✅

## Phase 3 — CTO 审查

### 质量评估 (小全)

| 维度 | 评分 | 说明 |
|------|------|------|
| Quality | PASS | 权限模型清晰三级，覆盖全面，测试 26/26 |
| Efficiency | HIGH | 3 文件、~340 行净增代码、零新增依赖 |
| Cost | LOW | 纯内存操作，无运行时开销 |

### 验证评估 (小柯)

| 维度 | 评分 | 说明 |
|------|------|------|
| Quality | PASS | 3 道门禁全部通过，type-check + 全量测试 + minTestCount |
| Efficiency | HIGH | 单文件 1.2s，全量 4.5s |
| Cost | LOW | 零 npm 依赖 |

### 设计审查

- **协议兼容**: AgentLoopOptions 新增字段均为可选（`tier?`、`parentCallIds?`），向后兼容
- **安全**: 递归防护正确——subagent 无法访问 `task` 工具
- **可扩展**: TOOL_TIER_ALLOWLIST 为 Map<string, Set<AgentTier>> 结构，新增工具/层级无需改动其他代码

### CTO Sign-off: ✅ PASS

## 交付物

- [x] `src/agent-loop/permissions.ts`
- [x] `src/agent-loop/tools.ts` (增强)
- [x] `src/agent-loop/loop.ts` (增强)
- [x] `test/agent-loop/permissions.test.ts` (26 测试)
- [x] `docs/engineering/tasks/CTO-008-tool-permission-system.md` (本文档)
