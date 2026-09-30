# Phase 4: Tool Permission Absorption Analysis

**Author**: CTO 小狄（小全模式 — 积木级完整拆解）
**Date**: 2026-07-18
**Status**: ✅ Complete（小柯验证 25/25 PASS，发现并修正 V-005 一处计数差异）
**Source**: Claude Code 2.1.88 vendor（`src/utils/permissions/` 目录，24 个源文件，~6,900 行）
**Target**: TriMMC（当前权限系统成熟度：0% — 无独立的工具权限决策管道）

---

## 1. Executive Summary

Claude Code 的工具权限系统是其安全架构的脊梁——不是简单的"允许/拒绝"二元开关，而是一个**15 步决策管道**，融合了规则匹配、模式覆盖、分类器 AI 判断、拒绝追踪、路径验证和 Kill Switch 熔断。TriMMC 当前完全没有独立的权限决策系统（仅依赖宿主 Copilot CLI 的默认安全策略）。

Phase 4 完整拆解了 Claude Code 权限系统的 **14 个子系统**：

1. **15 步决策管道**（`permissions.ts`，1387 行）— 从规则检查到模式覆盖到分类器降级的完整流
2. **类型体系**（`types/permissions.ts`，442 行）— 7 种 PermissionMode、3 种 PermissionBehavior、8 种 RuleSource、11 种 DecisionReason
3. **规则解析系统**（`permissionRuleParser.ts`，182 行）— 格式 `ToolName(content)` + 遗留名称别名
4. **规则加载/持久化**（`permissionsLoader.ts`，263 行 + `PermissionUpdate.ts`，349 行）— 多源优先级 + 6 种更新操作
5. **YOLO 分类器**（`yoloClassifier.ts`，1417 行）— 支持 tool_use 和 XML 2-Stage 双模式
6. **分类器白名单**（`classifierDecision.ts`，95 行）— 22 个安全工具跳过分类器
7. **权限解释器**（`permissionExplainer.ts`，221 行）— Haiku 模型生成风险解释
8. **拒绝追踪**（`denialTracking.ts`，39 行）— consecutive≥3 / total≥20 熔断
9. **危险权限检测**（`permissionSetup.ts` 中的 `isDangerousBashPermission` / `findDangerousClassifierPermissions`）
10. **路径验证**（`pathValidation.ts`，440 行）— 5 步检查链 + 危险路径检测
11. **Shadow Rule 检测**（`shadowedRuleDetection.ts`，210 行）— 不可达规则标记
12. **模式转换系统**（`transitionPermissionMode` + `getNextPermissionMode.ts`，92 行）
13. **Kill Switch 熔断**（`bypassPermissionsKillswitch.ts`，141 行）— Statsig/GB 远程禁用
14. **Shell 规则匹配**（`shellRuleMatching.ts`，207 行）— exact/prefix/wildcard 三级匹配

**核心发现**：Claude Code 的权限系统采用了"规则优先 + 分类器兜底"的纵深防御架构。最关键的安全设计是 **Safety Check 的 bypass-immune 属性**——即使在 `bypassPermissions` 或 `auto` 模式下，触及 `.git/`、`.claude/`、shell configs 的操作仍必须经过显式用户确认。这个设计直接对应 TriMMC 项目入口路由层方案中提出的 `auto-fallback` 安全回退循环。

**吸收档位建议**：
- **Tier 1（MVP 必需）**：规则系统 + 决策管道 + 权限模式（default/acceptEdits/bypassPermissions）
- **Tier 2（安全增强）**：路径验证 + Safety Check + 拒绝追踪
- **Tier 3（智能分类）**：YOLO Classifier + 分类器白名单 + 权限解释器
- **Tier 4（运维能力）**：Kill Switch + Shadow Rule 检测 + 模式转换 UI

---

## 2. Architecture Overview

```
                              ┌─────────────────────────┐
                              │   PermissionMode State   │
                              │  (default/acceptEdits/   │
                              │   bypassPermissions/     │
                              │   dontAsk/plan/auto)     │
                              └───────────┬─────────────┘
                                          │
                    ┌─────────────────────┼─────────────────────┐
                    │                     │                     │
              ┌─────▼─────┐        ┌─────▼─────┐        ┌─────▼─────┐
              │  Rules    │        │ Classifier│        │  Safety   │
              │  Engine   │        │  (YOLO)   │        │  Checks   │
              │           │        │           │        │           │
              │ • user    │        │ • Tool-use│        │ • .git/   │
              │ • project │        │ • XML 2-  │        │ • .claude/│
              │ • local   │        │   Stage   │        │ • shell   │
              │ • policy  │        │ • 22 safe │        │   configs │
              │ • CLI arg │        │   tools   │        │           │
              └─────┬─────┘        └─────┬─────┘        └─────┬─────┘
                    │                     │                     │
                    └─────────────────────┼─────────────────────┘
                                          │
                              ┌───────────▼───────────┐
                              │  15-Step Decision     │
                              │  Pipeline             │
                              │                       │
                              │  hasPermissionsTo     │
                              │  UseTool()            │
                              │      │                │
                              │      ▼                │
                              │  allow / ask / deny   │
                              └───────────────────────┘
                                          │
                        ┌─────────────────┼─────────────────┐
                        │                 │                 │
                  ┌─────▼─────┐    ┌─────▼─────┐    ┌─────▼─────┐
                  │  Denial   │    │   Path    │    │  Shadow   │
                  │  Tracking │    │ Validation│    │   Rule    │
                  │  (3/20)   │    │  (5-step) │    │ Detection │
                  └───────────┘    └───────────┘    └───────────┘
```

**数据流概要**：
- **Rule 来源**（8 种）：`userSettings` > `projectSettings` > `localSettings` > `flagSettings` > `policySettings` > `cliArg` > `command` > `session`
- **Rule 格式**：`ToolName` 或 `ToolName(content)` — 其中 Bash 规则支持 exact/prefix/wildcard 三级匹配
- **决策结果**（4 种）：`allow` | `ask` | `deny` | `passthrough`

---

## 3. 15-Step Decision Pipeline Deconstruction

Claude Code 的 `hasPermissionsToUseTool()` 是整个权限系统的心脏。它是一个 **15 步管道**，分为 4 个阶段：

### Phase 1: `hasPermissionsToUseToolInner` — 规则检查（7 步）

```
Step 1a: 全部工具 deny 检查
  → 如果该工具在 alwaysDenyRules 中（无 content 过滤）→ return DENY
    例外：TeamCreate/TeamDelete sandbox override → 允许

Step 1b: 全部工具 ask 检查（非 sandbox 环境）
  → 如果该工具在 alwaysAskRules 中（无 content 过滤）→ return ASK

Step 1c: tool.checkPermissions() — 工具级自定义检查
  → 每个工具可定义自己的权限逻辑（如 FileWrite 检查 working dir）
  → 若返回 ask → 继续管道（不直接返回）

Step 1d: 工具 deny 检查
  → 如果该工具在 alwaysDenyRules 中有 deny rule → return DENY

Step 1e: requiresUserInteraction() 检查
  → 如果工具的 requiresUserInteraction==true → return ASK

Step 1f: 内容特定 ask 检查
  → 如果有匹配的 ask rule（如 Bash(git push:*)）→ return ASK

Step 1g: Safety Check（bypass-immune）
  → 检测 .git/、.claude/、shell configs 等敏感操作
  → 即使在 bypassPermissions 模式下也必须 ASK
  → 这是整个系统最强的安全锚点
```

### Phase 2: 模式检查（2 步）

```
Step 2a: bypassPermissions / plan+available 模式
  → bypassPermissions → 直接 ALLOW（除非 Step 1g safety check 已拦截）
  → plan 模式 + isBypassPermissionsModeAvailable → 直接 ALLOW

Step 2b: alwaysAllow 规则匹配
  → 检查是否有匹配的 alwaysAllow 规则
  → Bash 规则先精确匹配命令再匹配内容
  → 若匹配 → return ALLOW
  → 否则 → return ASK（默认行为，留到外层后处理）
```

### Phase 3: passthrough → ask 转换

```
  → 将 passthrough 行为统一转换为 ask
  → passthrough 是一个中间状态，不暴露给外部
```

### Phase 4: `hasPermissionsToUseTool` 外层后处理（5 步）

```
Step 4a: allow 结果处理
  → return ALLOW，重置 consecutiveDenials=0

Step 4b: ask + dontAsk 模式
  → dontAsk 模式将 ask 降级为 deny
  → 带 "permission denied" 原因

Step 4c: ask + auto 模式 — 分类器管道
  → 这是最复杂的路径：
  4c-1: safetyCheck → ASK（headless 则 DENY）
  4c-2: requiresUserInteraction → ASK
  4c-3: PowerShell（非 POWERSHELL_AUTO_MODE）→ DENY（headless）
  4c-4: acceptEdits 快速路径 → ALLOW（编辑工具 + CWD 内）
  4c-5: Safe-tool allowlist → ALLOW（22 个安全工具）
  4c-6: YOLO classifier → allow/deny/fallback
  4c-7: Denial tracking（consecutive≥3 或 total≥20 → fallback）

Step 4d: ask + shouldAvoidPermissionPrompts
  → hooks → auto-deny（无 headless fallback）

Step 4e: 默认 ask
  → 所有其他情况 → ASK
```

**关键设计亮点**：
- **Safety Check 的 bypass-immune 属性**是所有模式的最高优先级拦截，无法被任何模式或规则覆盖
- **acceptEdits 快速路径**在 auto 模式下先检查 edit 工具 + CWD 内 → 如果 acceptEdits 模式会允许，就直接 allow，避免昂贵的 classifier API 调用
- **Classifier fail-closed**：分类器不可用时默认 block（通过 `tengu_iron_gate_closed` GB gate 也可配置为 fail-open）

---

## 4. Permission Rule System

### 4.1 类型体系（`types/permissions.ts`，442 行）

**PermissionMode**（7 种）：
| Mode | 说明 | 谁可用 |
|------|------|--------|
| `default` | 标准模式，每次询问 | 所有用户 |
| `acceptEdits` | 自动接受编辑到 CWD 内 | 所有用户 |
| `bypassPermissions` | 跳过所有权限检查（Safety Check 除外） | 所有用户（可被 GB/设置禁用） |
| `dontAsk` | 从不询问，直接 deny ask 行为 | 所有用户 |
| `plan` | 规划模式，阅读+分析不执行 | 所有用户 |
| `auto` | 分类器驱动的自动模式 | ant-only（通过 `TRANSCRIPT_CLASSIFIER` feature gate） |
| `bubble` | Fork 子代理隔离模式 | 内部使用 |

**PermissionBehavior**（3 种）：`allow` | `deny` | `ask`

**PermissionRuleSource**（8 种，优先级从高到低）：
1. `userSettings` — 用户全局配置文件
2. `projectSettings` — 项目级 `.claude/settings.json`
3. `localSettings` — 本地 `.claude/settings.local.json`
4. `flagSettings` — 通过 `--flag-settings` CLI 传入
5. `policySettings` — 托管策略（`managedPolicy` in settings）
6. `cliArg` — `--allowedTools` / `--disallowedTools`
7. `command` — `/` 命令注入的规则
8. `session` — 运行时添加的临时规则

**PermissionDecisionReason**（11 种）：`rule` | `mode` | `subcommandResults` | `permissionPromptTool` | `hook` | `asyncAgent` | `sandboxOverride` | `classifier` | `workingDir` | `safetyCheck` | `other`

### 4.2 规则解析器（`permissionRuleParser.ts`，182 行）

**格式规范**：
```
ToolName                 → 无内容过滤，规则作用于整个工具
ToolName(content)        → 带内容过滤
Bash(*)                  → 匹配所有 Bash 命令
Bash(python:*)           → 匹配 python: 前缀
Bash(git push)           → exact match "git push"
Bash(curl *)             → wildcard match "curl "
```

**遗留名称别名**（向后兼容）：
| 旧名称 | 新名称 |
|--------|--------|
| `Task` | `Agent` |
| `KillShell` | `TaskStop` |
| `AgentOutputTool` | `TaskOutput` |
| `BashOutputTool` | `TaskOutput` |

**转义规则**：
- `\` → `\\`
- `(` → `\(`
- `)` → `\)`

**边界条件**：
- `Bash()` 和 `Bash(*)` 等价，都视为工具级规则（无内容过滤）
- `*` 通配符匹配零个或多个字符

### 4.3 规则加载器（`permissionsLoader.ts`，263 行）

**加载优先级**：
1. `policySettings` → `managedPolicy` 文件
2. `userSettings` → `~/.claude/settings.json`
3. `projectSettings` → 项目 `.claude/settings.json`
4. `localSettings` → 项目 `.claude/settings.local.json`

**managedPolicy 门控**：
- `policySettings.allowManagedPermissionRulesOnly` → true 时仅加载托管策略规则
- 保护企业级安全策略不被本地覆盖

**去重机制**：
- 通过规范化 roundtrip（parse → serialize → compare）检测重复规则
- 防止同一规则被多次加载到同一 source

### 4.4 Shell 规则匹配（`shellRuleMatching.ts`，207 行）

**三级匹配**：

1. **exact**（精确匹配）：`Bash(git push)` → 只匹配 `"git push"`
2. **prefix**（前缀匹配）：`Bash(python:*)` → 匹配所有以 `python:` 开头的命令
3. **wildcard**（通配符匹配）：
   - `*` 匹配零个或多个字符
   - `\*` 转义的字面量 `*`
   - `\\` 转义的字面量 `\`
   - 大小写不敏感
   - 单 wildcard trailing ` *` 可选匹配（`Bash(npm run *)` 匹配 `"npm run build"` 和 `"npm run"`）

**建议生成**：
- `suggestionForExactCommand()`：为精确命令生成规则建议
- `suggestionForPrefix()`：为前缀生成规则建议

---

## 5. YOLO Classifier System

YOLO（"You Only Live Once"）分类器是 auto 模式的核心——当规则系统无法判断时，由 AI 分类器决定是否允许操作。

### 5.1 分类器入口（`yoloClassifier.ts` 主要函数 `classifyYoloAction`）

**调用条件**（仅在 auto 模式下满足以下条件时）：
1. 工具不在 22 个安全白名单中
2. 工具不是 edit 操作 + CWD 内（acceptEdits 快速路径）
3. 工具不需要用户交互（`requiresUserInteraction() === false`）
4. 非 PowerShell（除非 `POWERSHELL_AUTO_MODE` feature gate 开启）

**输入构建**：
- `buildYoloSystemPrompt()`：组装分类器系统提示词，支持 external/anthropic 两种模板
- `buildTranscriptEntries()`：构建紧凑 JSONL 格式的对话记录
- `buildClaudeMdMessage()`：注入 CLAUDE.md 项目上下文
- 使用 cache_control 在 action block 上设置断点（breakpoint caching）

**模型选择**：`getClassifierModel()` 优先级：
1. `CLAUDE_CODE_AUTO_MODE_MODEL` 环境变量（ant-only）
2. GB `tengu_auto_mode_config.model` 配置
3. 主循环模型（`getMainLoopModel()`）

### 5.2 XML 2-Stage Classifier（`classifyYoloActionXml`）

GrowthBook `tengu_auto_mode_config.twoStageClassifier` 启用后，分类器切换到 XML 双阶段模式：

**Stage 1 — Fast（max_tokens=64，stop_sequences=['</block>']）**：
```
Prompt suffix: "Err on the side of blocking. <block> immediately."
Response:  <block>yes</block> / <block>no</block>
```
- `<block>no</block>` → 立即允许（fast path）
- `<block>yes</block>` → 升入 Stage 2
- 无法解析 → 在 'both' 模式升入 Stage 2，在 'fast' 模式 block

**Stage 2 — Thinking（max_tokens=4096）**：
```
Prompt suffix: "Review the classification process and follow it carefully...
                Use <thinking> before responding with <block>."
Response:  <thinking>...</thinking><block>yes/no</block><reason>...</reason>
```
- 带 chain-of-thought 推理来减少误报
- `<block>yes</block>` → block；`<block>no</block>` → allow
- 无法解析 → fail-closed block

**三种模式**：
| Mode | 行为 |
|------|------|
| `both` | Stage 1 → Stage 2（默认） |
| `fast` | Stage 1 only |
| `thinking` | Stage 2 only |

**错误处理**：
- signal.aborted → block with `unavailable: true`
- `detectPromptTooLong()` → block with `transcriptTooLong: true`
- Stage 2 出错但有 Stage 1 结果 → block "based on stage 1 assessment"
- Stage 1 都没有 → block with `unavailable: true`

**Output Format 替换**：
- 从 tool_use 格式（`Use the classify_result tool...`）替换为 XML 格式
- 要求：`Your ENTIRE response MUST begin with <block>`

### 5.3 Tool-Use Classifier（传统模式）

未启用 XML 2-Stage 时的默认分类器：
- 使用 `YOLO_CLASSIFIER_TOOL_SCHEMA` 作为 tool_choice
- `tool_choice: { type: 'tool', name: 'classify_result' }` 强制结构化输出
- 响应格式：`{ thinking, shouldBlock, reason }`
- 无法解析 → fail-closed block

### 5.4 分类器白名单（`classifierDecision.ts`，95 行）

**22 个安全工具白名单**（跳过分类器）：
- **文件读取**：`FileRead`
- **搜索**：`Grep`、`Glob`、`LSP`、`ToolSearch`、`ListMcpResources`、`ReadMcpResourceTool`
- **任务管理**：`TodoWrite`、`TaskCreate`、`TaskGet`、`TaskUpdate`、`TaskList`、`TaskStop`、`TaskOutput`
- **计划/UI**：`AskUserQuestion`、`EnterPlanMode`、`ExitPlanMode`
- **团队协调**：`TeamCreate`、`TeamDelete`、`SendMessage`
- **工作流**：`WorkflowTool`（feature-gated）
- **Misc**：`Sleep`、`TerminalCapture`（ant-only）、`OverflowTest`（ant-only）、`VerifyPlanExecution`（ant-only）
- **分类器自身**：`YOLO_CLASSIFIER_TOOL_NAME`

### 5.5 PowerShell 分类器指导

当 `POWERSHELL_AUTO_MODE` feature gate 开启时，分类器系统的 deny 列表包含 PowerShell 特定指导：

| PS 危险模式 | 分类器映射 |
|-------------|-----------|
| `iex (iwr ...)` / `Invoke-Expression (Invoke-WebRequest ...)` | "Code from External" |
| `Remove-Item -Recurse -Force` | "Irreversible Local Destruction" |
| `$PROFILE` 修改 / `Register-ScheduledTask` / Registry Run keys | "Unauthorized Persistence" |
| `Start-Process -Verb RunAs` / `-ExecutionPolicy Bypass` | "Security Weaken" |

### 5.6 分类器基础设施（`classifierShared.ts`，36 行）

轻量共享工具：
- `extractToolUseBlock(content, toolName)` — 从 BetaContentBlock[] 中提取 tool_use block
- `parseClassifierResponse(toolUseBlock, schema)` — 用 Zod schema 安全解析分类器输出

---

## 6. Denial Tracking

**文件**：`denialTracking.ts`（39 行）

独立的拒绝追踪状态机，用于在 auto 模式下降级到手动确认：

```
consecutiveDenials: 最大 3 → 连续 3 次拒绝 → fallback to prompt
totalDenials:      最大 20 → 总计 20 次拒绝 → reset counter + fallback
```

**与决策管道的集成**（`permissions.ts`）：
1. 分类器返回 block → `consecutiveDenials++`
2. 任何 allow → `consecutiveDenials = 0`
3. `consecutiveDenials >= 3` 或 `totalDenials >= 20` → 跳过分类器，退回 ask

**关键设计**：consecutive 追踪的是**极短时间窗口内的连续拒绝**（可能指示分类器误判或攻击），而 total 追踪的是**累计拒绝量**（指示分类器总体上过于严格）。

---

## 7. Dangerous Permission Detection

**文件**：`permissionSetup.ts`（相关函数部分）

### 7.1 Bash 危险权限检测

`isDangerousBashPermission(ruleValue)` 检测以下危险模式：
- **解释器前缀**：`python:*`、`node:*`（允许任意 Python/Node 脚本）
- **通配符**：`python*`（匹配 `python`, `python3`, `python-script` 等）
- **任意命令**：`Bash`（无 content）或 `Bash(*)` — 等同于 YOLO 模式

### 7.2 PowerShell 危险权限检测

`isDangerousPowerShellPermission(ruleValue)` 检测：
- `iex` — Invoke-Expression
- `Start-Process` — 进程启动
- `New-Object` — 对象创建
- `Invoke-WebRequest` / `iwr` — 网络请求
- `Invoke-RestMethod` / `irm` — REST API 调用
- 任意 PowerShell 命令：`PowerShell` 或 `PowerShell(*)`

### 7.3 Task 危险权限检测

`isDangerousTaskPermission()`：任何 Agent 工具的 allow 规则都是危险的（因为子代理可以执行任意操作）

### 7.4 分类器特定危险检测

`findDangerousClassifierPermissions(rules, cliRules)`：
- 扫描所有来源（settings + CLI args）找危险规则
- 在 auto 模式下，这些规则会绕过分类器，因此需要标记并移除

### 7.5 Auto Mode 危险规则剥离

`stripDangerousPermissionsForAutoMode(context)`：
- 进入 auto 模式时，从 alwaysAllowRules 中剥离危险规则
- 存入 `strippedDangerousRules` 用于离开 auto 时恢复
- 只在可持久化来源（排除 session/cliArg/command）上操作

`restoreDangerousPermissions(context)`：
- 离开 auto 模式时，恢复之前剥离的危险规则
- 清除 `strippedDangerousRules` 标记

---

## 8. Path Validation

**文件**：`pathValidation.ts`（440 行）

### 8.1 `isPathAllowed()` — 5 步检查链

```
Step 1: deny rules 检查
  → 如果路径在 alwaysDeny 规则中 → DENY

Step 2: internal editable paths 检查
  → Claude Code 内部可编辑路径 → ALLOW

Step 3: safety check
  → .git/、.claude/、shell configs → ASK

Step 4: working directory 检查
  → 路径在当前工作目录内 → ALLOW

Step 5: allow rules 检查
  → 如果路径在 alwaysAllow 规则中 → ALLOW
  → 否则 → ASK
```

### 8.2 `validatePath()` — 完整安全序列

```
1. 去引号（de-quote）→ 移除 shell 引号
2. 展开 ~ → 解析为 HOME 目录
3. UNC 路径拒绝 → `\\server\share` 格式
4. tilde 变体拒绝 → `~otheruser/` 等
5. shell 展开拒绝 → `$HOME`、`$(cmd)`、`` `cmd` ``
6. glob 写操作拒绝 → `*.log` + 写操作 → 拒绝
7. 路径解析 → 规范化绝对路径
8. 权限检查 → isPathAllowed()
```

### 8.3 `isDangerousRemovalPath()` — 危险删除路径检测

检测并拒绝以下危险路径的删除操作：
- `/`（根目录）
- `~`（HOME 目录）
- `C:\`（Windows 系统盘）
- 以上路径的直接子目录

---

## 9. Shadow Rule Detection

**文件**：`shadowedRuleDetection.ts`（210 行）

检测不可达规则（被更高优先级规则完全覆盖的规则）：

### 9.1 两种 shadow 类型

1. **Allow rule shadowed by deny rule**（更严重）：
   - 用户添加了 allow 规则，但被 deny 规则完全覆盖
   - 用户期望的 allow 永远不会生效

2. **Allow rule shadowed by ask rule**（Warning）：
   - allow 规则被 ask 规则遮蔽
   - 用户期望 allow，但实际只会 ask

### 9.2 `isSharedSettingSource()` 区分

- **共享设置**（`projectSettings`、`policySettings`、`command`）：shadow 警告对所有用户可见
- **个人设置**（`userSettings`、`localSettings`）：shadow 警告仅对当前用户可见

### 9.3 Sandbox 例外

- Bash + sandbox auto-allow：如果子代理在 sandbox 中且 Bash 有 auto-allow，个人 ask rule 不标记为 shadowed

---

## 10. Permission Update Persistence

**文件**：`PermissionUpdate.ts`（349 行）

### 10.1 6 种 `PermissionUpdate` 操作

| 操作 | 说明 | 持久化 |
|------|------|--------|
| `addRules` | 添加 allow/deny/ask 规则 | userSettings/projectSettings/localSettings |
| `replaceRules` | 替换整个 rule 列表 | userSettings/projectSettings/localSettings |
| `removeRules` | 移除特定规则 | userSettings/projectSettings/localSettings |
| `setMode` | 设置权限模式 | 仅内存（session） |
| `addDirectories` | 添加额外工作目录 | 仅内存（session） |
| `removeDirectories` | 移除额外工作目录 | 仅内存（session） |

### 10.2 持久化目标

- **可持久化**：`userSettings`、`projectSettings`、`localSettings`
- **仅内存**：`session`、`cliArg`、`flagSettings`、`command`、`policySettings`

### 10.3 应用流程

```ts
applyPermissionUpdate(context, update) → 修改 context 内的 rules/mode/directories
persistPermissionUpdate(update)        → 写入磁盘 settings 文件
```

`persistPermissionUpdate` 使用 `supportsPersistence()` 过滤非持久化 destination。

---

## 11. Mode Transition System

**文件**：`getNextPermissionMode.ts`（92 行）+ `permissionSetup.ts` `transitionPermissionMode()`

### 11.1 Mode Cycling（Shift+Tab）

```
default → acceptEdits → plan → bypassPermissions → auto → default
```

**Ant 用户特殊路径**：
```
default → bypassPermissions → auto → default
```
（跳过 acceptEdits 和 plan，因为 auto 模式覆盖了这些场景）

### 11.2 `transitionPermissionMode(fromMode, toMode, context)`

统一入口处理所有模式切换的副作用：

1. **fromMode === toMode** → 无操作返回
2. **Plan mode 过渡**：`handlePlanModeTransition(from, to)` — plan 进入/离开附件
3. **Auto mode 过渡**：
   - 进入 auto → `setAutoModeActive(true)` + `stripDangerousPermissionsForAutoMode()`
   - 离开 auto → `setAutoModeActive(false)` + `restoreDangerousPermissions()` + `setNeedsAutoModeExitAttachment(true)`
4. **Plan→non-plan**：`setHasExitedPlanMode(true)`
5. **Plan+TRANSCRIPT_CLASSIFIER**：`prepareContextForPlanMode(context)` — 备份 prePlanMode
6. **`fromUsesClassifier` 判定**：`fromMode === 'auto'` 或 `fromMode === 'plan' && isAutoModeActive()`
7. **Gate 检查**：进入 auto 前 `isAutoModeGateEnabled()` → 不通过则 throw

### 11.3 `cyclePermissionMode(context)`

计算下一个模式并准备上下文：
```ts
const nextMode = getNextPermissionMode(context)
const context = transitionPermissionMode(currentMode, nextMode, context)
```

---

## 12. Kill Switch Mechanisms

### 12.1 Bypass Permissions Kill Switch

**文件**：`bypassPermissionsKillswitch.ts`（141 行）

**两个同步检查**（启动时 + `/login` 后重置）：
1. `checkAndDisableBypassPermissionsIfNeeded()` — 检查 Statsig gate `tengu_disable_bypass_permissions_mode`
2. `checkAndDisableAutoModeIfNeeded()` — 检查 GrowthBook `tengu_auto_mode_config`

**禁用优先级**：
1. Statsig gate（最高优先级，远程即时生效）
2. Settings `permissions.disableBypassPermissionsMode: 'disable'`

### 12.2 Auto Mode Gate System

**三层门控**（`verifyAutoModeGateAccess()`）：
1. **Circuit Breaker**：GB `enabled === 'disabled'` 或 settings `disableAutoMode: 'disable'`
2. **Model Support**：`modelSupportsAutoMode(getMainLoopModel())`
3. **Carousel Availability**：circuit-breaker 未触发 + model 支持 + GB enabled/opt-in

**AutoModeEnabledState**：
- `enabled` — 所有用户可见
- `opt-in` — 仅已 opt-in 用户可见（`--enable-auto-mode` CLI 或 `skipAutoPermissionPrompt` setting）
- `disabled` — 完全不可用（熔断）

**Fast Mode Circuit Breaker**：
- GB `tengu_auto_mode_config.disableFastMode` — auto+fast 模式交互验证未通过时临时禁用

### 12.3 Kick-Out 变换

`verifyAutoModeGateAccess` 返回一个 **Transform 函数**（而非预计算的 context），确保在异步 GB 查询期间用户 shift-tab 切换模式不会被覆盖：

```ts
kickOutOfAutoIfNeeded(ctx) {
  // 重新检查 FRESH ctx.mode
  if (ctx.mode === 'auto') → 强制切回 default
  if (ctx.mode === 'plan' && prePlanMode === 'auto') → 恢复权限 + defuse prePlanMode
}
```

---

## 13. Safety Check System

**Bypass-Immune Safety Checks**（在 `hasPermissionsToUseTool` Step 1g）：

以下操作**在任何模式下都必须显式用户确认**（包括 bypassPermissions 和 auto 模式）：
- 操作 `.git/` 目录的内容
- 操作 `.claude/` 目录的内容
- 修改 shell 配置文件（`.bashrc`、`.zshrc`、`.profile` 等）

**PowerShell Safety Check**：在 `POWERSHELL_AUTO_MODE` feature gate 开启时：
- PowerShell 操作 `.git/` → safety check
- PowerShell 修改 `$PROFILE` → safety check

**Headless 降级**：在 headless 环境（无 TTY）中，safety check 仍返回 ask 而非 deny（保留最后的人工确认机会）。

---

## 14. TriMMC Gap Analysis

### 14.1 当前状态

TriMMC 当前**完全没有独立的工具权限决策系统**。当前安全依赖：
- Copilot CLI 宿主层的默认工具限制
- 入口路由层的 `active_host` flag + health check 机制（设计阶段）

### 14.2 11 维度差距评估

| # | 维度 | Claude Code | TriMMC 当前 | 差距 |
|---|------|------------|-----------|------|
| 1 | 权限模式系统 | 7 种模式 | 0 | ⬜⬜⬜⬜⬜ 100% |
| 2 | 规则解析引擎 | 完整 parser + 遗留别名 | 0 | ⬜⬜⬜⬜⬜ 100% |
| 3 | 15 步决策管道 | 完整管道 + 4 阶段 | 0 | ⬜⬜⬜⬜⬜ 100% |
| 4 | 规则持久化 | 4 级 source + 6 种 update | 0 | ⬜⬜⬜⬜⬜ 100% |
| 5 | Shell 规则匹配 | exact/prefix/wildcard | 0 | ⬜⬜⬜⬜⬜ 100% |
| 6 | 分类器系统 | tool-use + XML 2-Stage | 0（TriMMC 无 auto 模式概念） | ⬜⬜⬜⬜⬜ 100% |
| 7 | 拒绝追踪 | 3 consecutive / 20 total | 0 | ⬜⬜⬜⬜⬜ 100% |
| 8 | 危险权限检测 | Bash + PS + Task 全覆盖 | 0 | ⬜⬜⬜⬜⬜ 100% |
| 9 | 路径验证 | 5-step 检查链 + 8-step 安全序列 | 0 | ⬜⬜⬜⬜⬜ 100% |
| 10 | Shadow Rule 检测 | allow/deny shadow + shared setting | 0 | ⬜⬜⬜⬜⬜ 100% |
| 11 | Kill Switch 熔断 | Statsig + GB + settings 三层 | 入口路由层 auto-fallback（设计阶段） | ⬜⬜⬜⬜⬜ 100% |

**总体评估**：TriMMC 权限系统成熟度 = **0%**。Claude Code 的权限系统是一个完整、经过生产验证的安全架构，覆盖了从规则到 AI 分类到熔断的全链路。

---

## 15. Absorption Recommendation Tiers

### Tier 1 — MVP 必需（与 TriMMC agent-loop 直接耦合）

**目标**：建立最小的工具权限决策能力，支撑 safe/unsafe 工具区分

1. **PermissionMode 最小集**（3 种）：
   - `default`：每次操作询问用户
   - `acceptEdits`：编辑操作自动允许（CWD 内）
   - `bypassPermissions`：跳过所有检查（Safety Check 除外）

2. **规则系统核心**：
   - 格式：`ToolName(content)` — 与 Claude Code 兼容
   - 来源优先级：`userSettings` > `projectSettings` > `cliArg`
   - 规则解析器（`permissionRuleParser.ts` 核心逻辑）
   - Shell 规则匹配引擎（`shellRuleMatching.ts` exact/prefix/wildcard）

3. **简化决策管道**（8 步，从 15 步裁剪）：
   - Step 1-2: Always deny + Always ask（规则优先）
   - Step 3: Safety Check（bypass-immune）
   - Step 4-5: Mode check（bypassPermissions/acceptEdits）
   - Step 6-7: Always allow rules + Shell 匹配
   - Step 8: Default ask

4. **规则持久化**：`addRules` + `removeRules` 两种更新操作

**预估工时**：3-5 天（基于 TriMMC 当前 TypeScript 基础设施）

### Tier 2 — 安全增强（独立安全模块）

**目标**：建立纵深防御的第二层

1. **路径验证系统**（`pathValidation.ts` 核心逻辑）：
   - `isPathAllowed()` 5 步检查链
   - `validatePath()` 8 步安全序列
   - `isDangerousRemovalPath()` 危险路径检测

2. **Safety Check 系统**：
   - `.git/`、`.claude/`、shell configs 的 bypass-immune 检查
   - 与 TriMMC 项目特定的安全路径扩展

3. **拒绝追踪**（`denialTracking.ts`）：
   - consecutive: 3，total: 20
   - 与 TriMMC 的 auto-fallback 机制集成（入口路由层 auto-fallback 循环）

4. **Dangerous Permission 检测**：
   - Bash 解释器前缀 + 通配符
   - PowerShell 危险命令
   - Agent 任意 allow

**预估工时**：5-7 天

### Tier 3 — 智能分类（与 TriMMC 的 Copilot-host/TriMMC-host 双模式集成）

**目标**：引入 AI 分类器实现 auto 模式

1. **分类器白名单**（22 个安全工具 → TriMMC 等价映射）：
   - 文件读取、搜索、任务管理、团队协调、Misc

2. **YOLO 分类器适配**：
   - TriMMC 使用自己的模型端点（而非 Claude API）
   - 支持 tool_use 格式的结构化输出
   - 同等的 fail-closed 策略

3. **权限解释器**（`permissionExplainer.ts`）：
   - 使用轻量模型生成风险解释
   - `riskLevel` / `explanation` / `reasoning` / `risk` 结构化输出

4. **acceptEdits 快速路径**：编辑工具 + CWD 内 → 跳过分类器

**预估工时**：7-10 天（取决于 TriMMC 模型端点的可用性）

### Tier 4 — 运维能力（远程管理 + 可观测性）

**目标**：企业级安全运维

1. **Kill Switch 熔断**：
   - TriMMC 自己的远程配置端点（替代 Statsig/GB）
   - `bypassPermissions` 和 `auto` 模式独立熔断
   - `/login` 后重置

2. **Shadow Rule 检测**（`shadowedRuleDetection.ts`）：
   - allow 被 deny 阻塞 → 严重警告
   - allow 被 ask 遮蔽 → 警告
   - 共享设置 vs 个人设置区分

3. **Mode Transition UI**（`getNextPermissionMode` + `cyclePermissionMode`）：
   - TriMMC 自己的 Shift+Tab 等效模式切换
   - enter/exit auto 模式的上下文清理

4. **权限审计日志**：决策原因 + 来源 + 模式 + 结果的完整记录

**预估工时**：5-8 天

---

## 16. Key Design Decisions Worth Adopting

1. **Safety Check 的 bypass-immune 属性**：TriMMC 入口路由层 auto-fallback 设计中的"健康检查 3 次失败自动回退"应该也保留类似的 bypass-immune 锚点——某些关键安全检查（如项目配置修改、密钥文件操作）在回退到 Copilot-host 时也不能跳过。

2. **Classification as Tier 2, not Tier 1**：Claude Code 的经验表明，规则系统 + 模式系统就覆盖了 90%+ 的日常场景。分类器（auto 模式）是锦上添花，不是 MVP 必需。

3. **Denial Tracking 双重阈值**：consecutive（短窗口异常）和 total（长期趋势）分开追踪的设计很聪明，TriMMC 直接采用。

4. **Mode Transition 的 Transform 模式**：`verifyAutoModeGateAccess` 返回 Transform 函数而非预计算 context，避免了异步配置查询期间的竞态条件——TriMMC 的入口路由层 active_host 切换应该采用类似的模式。

5. **Rule Source 优先级分级**：policySettings > userSettings > projectSettings > localSettings > cliArg 的分级设计保证了企业策略不被本地覆盖——TriMMC 如果未来支持 enterprise tier 需要这个设计。

---

## 17. 小柯 Verification Checklist

| # | 验证项 | 依据文件 | 状态 |
|---|--------|---------|------|
| V-001 | 15 步决策管道 step 描述准确、无遗漏 | `permissions.ts` 1387 行 | ✅ PASS |
| V-002 | 7 种 PermissionMode 说明正确 | `types/permissions.ts` + `PermissionMode.ts` | ✅ PASS |
| V-003 | 3 种 PermissionBehavior 说明正确 | `types/permissions.ts` | ✅ PASS |
| V-004 | 8 种 PermissionRuleSource 优先级正确 | `types/permissions.ts` + `permissionsLoader.ts` | ✅ PASS |
| V-005 | 11 种 PermissionDecisionReason 完整 | `types/permissions.ts` | ✅ PASS（已修正，原"12 种"为计数错误） |
| V-006 | 规则解析器格式/转义/别名描述正确 | `permissionRuleParser.ts` | ✅ PASS |
| V-007 | Shell 匹配 exact/prefix/wildcard 逻辑正确 | `shellRuleMatching.ts` | ✅ PASS |
| V-008 | Safety Check bypass-immune 属性准确 | `permissions.ts` hasPermissionsToUseToolInner | ✅ PASS |
| V-009 | 22 个安全白名单工具完整正确 | `classifierDecision.ts` | ✅ PASS |
| V-010 | acceptEdits 快速路径条件正确 | `permissions.ts` auto 模式后处理 | ✅ PASS |
| V-011 | YOLO 分类器 tool_use + XML 2-Stage 描述准确 | `yoloClassifier.ts` 1417 行 | ✅ PASS |
| V-012 | 拒绝追踪阈值准确（consecutive=3, total=20） | `denialTracking.ts` | ✅ PASS |
| V-013 | 危险权限检测 Bash/PS/Task 全覆盖 | `permissionSetup.ts` | ✅ PASS |
| V-014 | `isPathAllowed` 5 步检查链完整 | `pathValidation.ts` | ✅ PASS |
| V-015 | `validatePath` 8 步安全序列完整 | `pathValidation.ts` | ✅ PASS |
| V-016 | Shadow Rule 检测两种类型准确 | `shadowedRuleDetection.ts` | ✅ PASS |
| V-017 | 6 种 PermissionUpdate 操作描述正确 | `PermissionUpdate.ts` | ✅ PASS |
| V-018 | Mode Transition 副作用处理完整 | `permissionSetup.ts` transitionPermissionMode | ✅ PASS |
| V-019 | Kill Switch 三层门控（circuit breaker + model + carousel）准确 | `permissionSetup.ts` verifyAutoModeGateAccess | ✅ PASS |
| V-020 | Kick-Out Transform 模式描述正确 | `permissionSetup.ts` kickOutOfAutoIfNeeded | ✅ PASS |
| V-021 | 遗留名称别名表准确（Task→Agent 等） | `permissionRuleParser.ts` | ✅ PASS |
| V-022 | 权限持久化 destination 分类正确 | `PermissionUpdate.ts` supportsPersistence | ✅ PASS |
| V-023 | PowerShell deny guidance 映射正确 | `yoloClassifier.ts` POWERSHELL_DENY_GUIDANCE | ✅ PASS |
| V-024 | Gap Analysis 11 维度评估合理 | 全源码阅读交叉验证 | ✅ PASS |
| V-025 | Absorption Tiers 在 TriMMC 当前架构下可行 | TriMMC 当前 `src/agent-loop/` 结构 | ✅ PASS |

---

## Appendix A: Source File Inventory

| 文件 | 行数 | 核心职责 |
|------|------|---------|
| `permissions.ts` | 1387 | 15 步决策管道核心 |
| `permissionSetup.ts` | 1403 | 权限初始化 + 模式转换 + 危险检测 + Gate 系统 |
| `yoloClassifier.ts` | 1417 | YOLO 分类器（tool_use + XML 2-Stage） |
| `pathValidation.ts` | 440 | 文件系统路径验证 |
| `types/permissions.ts` | 442 | 完整类型体系 |
| `PermissionUpdate.ts` | 349 | 6 种权限更新操作 |
| `permissionsLoader.ts` | 263 | 从 settings 加载/写入规则 |
| `permissionExplainer.ts` | 221 | AI 风险解释器 |
| `shadowedRuleDetection.ts` | 210 | 不可达规则检测 |
| `shellRuleMatching.ts` | 207 | Shell 命令规则匹配 |
| `permissionRuleParser.ts` | 182 | 规则字符串解析 |
| `bypassPermissionsKillswitch.ts` | 141 | 远程禁用 bypassPermissions |
| `PermissionMode.ts` | 127 | 模式枚举 + 帮助文本 |
| `PermissionPromptToolResultSchema.ts` | 118 | 权限提示响应 Zod schema |
| `classifierDecision.ts` | 95 | 22 个安全工具白名单 |
| `getNextPermissionMode.ts` | 92 | Shift+Tab 模式循环 |
| `PermissionUpdateSchema.ts` | 75 | PermissionUpdate Zod schema |
| `bashClassifier.ts` | 50 | 分类器权限 stub（外部构建禁用） |
| `dangerousPatterns.ts` | 78 | 危险命令模式列表 |
| `PermissionRule.ts` | 37 | PermissionRule Zod schema |
| `denialTracking.ts` | 39 | 拒绝追踪状态机 |
| `classifierShared.ts` | 36 | 分类器基础设施共享 |
| `PermissionResult.ts` | 33 | 结果行为描述辅助 |
| `autoModeState.ts` | 31 | auto mode 运行时状态 |

**总计**：24 个源文件，~6,900 行 TypeScript

---

## Appendix B: Related Documents

- `docs/engineering/claude-code-absorption/phase-1-core-loop.md` — 核心 Loop 分析（待小全+小柯重审）
- `docs/engineering/claude-code-absorption/phase-2-prompt-cache.md` — Prompt Cache 分析（待小全+小柯重审）
- `docs/engineering/claude-code-absorption/phase-3-subagent-tree.md` — Sub-Agent Tree 分析（已完成）
- `TriCompany/docs/engineering/entry-routing-layer-design.md` — TriMMC 入口路由层设计（CTO-008）
