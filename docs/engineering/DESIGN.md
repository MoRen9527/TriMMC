# TriMMC 技术设计

- 模块定位：统一 agent runtime 与 interaction core
- 当前状态：V0.1 架构设计草案（待 CPO/CTO 联审）
- 最后更新：2026-07-08
- 维护归属：当前由总助（小贾）起草框架，后续移交 CTO 作为技术真源 owner

## 文档同步元信息

- sourceOfTruth: TriMMC/docs/engineering/DESIGN.md
- publishedFrom: 当前文件（source）
- syncMode: source-only
- publishTier: source-only
- lastSyncedAt: 2026-07-03

---

## 1. 总体定位

TriMMC 是赛博公司的 **统一 agent runtime 与 interaction core**。赛博公司有两种部署形态，本质上都是同一家公司在运营 TriMetaverse 项目——区别在于 runtime 由谁提供、编排由谁执行：

- **Copilot-host（本地手动版）**：赛博公司的本地原型形态。Runtime 由 Copilot 宿主提供，编排由总助 Agent 手动执行。用于在本地验证商业模式、研发流程和员工协作路径。
- **TriMMC 部署（服务器正式版）**：赛博公司的服务器上线形态。Runtime 由 TriMMC 自身提供（server/daemon 进程），所有 AI 员工在 TriMMC 上自动化运行，负责接收任务、调度 agent、管理上下文、调用模型、执行工具、持久化状态，并协调服务域（TriMMC）与本地域（TriRLC）之间的任务分发。

### 1.1 两种部署形态对照

| 维度 | Copilot-host（本地手动版） | TriMMC 部署（服务器正式版） |
|------|--------------------------|--------------------------|
| 赛博公司形态 | 本地原型，手动运营 | 服务器上线，自动化运营 |
| Runtime 提供者 | Copilot 宿主 | TriMMC 自身（server/daemon 进程） |
| Agent 调度 | 总助 Agent 手动协调 | TriMMC runtime 自动编排 |
| AI 员工运行方式 | 少数关键岗位以 Copilot Agent 形态上岗 | 所有 AI 员工在 TriMMC 上 7×24 运行 |
| 模型调用 | Copilot 宿主路由 | TriModel 统一配置 + TriMMC 调用 |
| 本地域 | 无（本地文件操作直接通过 Copilot 工具完成） | TriRLC 配合执行本地任务 |
| 适用场景 | 研发验证、流程调试、小规模试运行 | 正式商业运营、多用户接入、规模化服务 |

### 1.2 吸收策略总览

TriMMC 的核心架构吸收两条开源链：

1. **OpenClaw**（产品架构主吸收源）：agent loop、multi-agent isolation、context engine、hook/plugin system、session management、queue/concurrency
2. **Claude Code**（推理核心主吸收源）：coordinator mode、task decomposition、parallel worker execution、synthesis→implementation→verification workflow

吸收链：`reference/ → TriMMC/vendor/ → TriMMC/src/`，严格遵守项目级吸收规则。

---

## 2. 架构分层

TriMMC 采用六层架构，从入口到模型调用逐层递进：

```
┌─────────────────────────────────────────────────────┐
│  Gateway / Entry Layer                              │
│  WebSocket (ACP), REST, CLI, TriGateway 回调        │
├─────────────────────────────────────────────────────┤
│  Agent Runtime Layer                                │
│  员工生命周期、agent 沙箱、workspace 管理           │
├─────────────────────────────────────────────────────┤
│  Orchestration Engine Layer                         │
│  Coordinator（任务分解）、Planner、并行调度         │
├─────────────────────────────────────────────────────┤
│  Context Engine Layer                               │
│  上下文组装、压缩/compaction、记忆检索、token 预算  │
├─────────────────────────────────────────────────────┤
│  Inference Core Layer                               │
│  模型推理、tool calling、streaming、retry/fallback  │
├─────────────────────────────────────────────────────┤
│  Tool Bus & Model Adapter Layer                     │
│  Tool 注册/执行/沙箱、TriModel 统一模型接入         │
├─────────────────────────────────────────────────────┤
│  Session & State Store Layer                        │
│  会话持久化、状态管理、审计日志、event sourcing     │
└─────────────────────────────────────────────────────┘
```

### 2.1 各层职责

#### Gateway / Entry Layer
- **吸收自 OpenClaw**：Gateway daemon 设计、RPC 入口（`agent` / `agent.wait`）、WebSocket 连接管理
- **TriMMC 定制**：Agent Communication Protocol (ACP) 作为标准通信协议；TriGateway 回调接口用于社交通道消息接入
- **关键决策**：OpenClaw 的社交通道实现（WhatsApp/Telegram/Discord 等）由 TriGateway 吸收承接，TriMMC 自身不内嵌社交通道，所有社交通道消息通过 TriGateway 回调接口路由

#### Agent Runtime Layer
- **吸收自 OpenClaw**：multi-agent isolation（每 agent 独立 workspace + agentDir + sessions）、per-agent sandbox、tool policy
- **TriMMC 定制**：AI 员工生命周期管理——每个赛博公司员工是 TriMMC 上的一个 agent 实例；员工上岗/下岗/技能变更由 TriCompany 管理，TriMMC 执行
- **吸收自 Claude Code**：worker 生命周期（spawn → run → continue/stop → cleanup）

#### Orchestration Engine Layer
- **吸收自 Claude Code**：Coordinator 模式——这是 TriMMC 推理核心最重要的升级
  - 任务分解（Research → Synthesis → Implementation → Verification 四阶段）
  - 并行 worker 调度（独立任务并发执行）
  - Worker 上下文延续决策（continue vs spawn fresh）
  - 协调器汇总 worker 结果并向用户/上游汇报
- **吸收自 OpenClaw**：queue/concurrency 机制（per-session lane + global lane 序列化）
- **TriMMC 新增**：十阶段流程 gate 对接（与 TriDev phase engine 协调阶段门禁）

#### Context Engine Layer
- **吸收自 OpenClaw**：可插拔 context engine 接口
  - Ingest：消息入库/索引
  - Assemble：上下文组装 + token 预算控制
  - Compact：上下文压缩/摘要
  - AfterTurn：后处理（持久化状态、触发后台压缩）
- **吸收自 Claude Code**：更代码感知的上下文组装策略——文件内容、diff、类型签名等结构化信息注入
- **TriMMC 定制**：
  - 多级压缩策略（DAG 摘要 → vector retrieval → incremental condensation）
  - 模块 registry 集成（将 `<Module>CodeRegistry` 的 codegraph 成果注入上下文，降低 token 消耗）
  - 记忆系统对接（与 TriCompany Hermes 记忆系统协作）

#### Inference Core Layer
- **吸收自 Claude Code**：coordinator 推理逻辑、worker prompt 构建规范、synthesis 要求
- **吸收自 OpenClaw**：streaming 机制、tool calling 生命周期、compaction retry
- **替换 OpenClaw pi-agent ReAct**：用 Coordinator 模式替代简单 ReAct 循环
- **关键设计**：
  - 模型调用统一通过 TriModel（provider/model/fallback 配置）
  - 支持 thinking/verbose/fast 模式切换
  - Tool calling 错误自动重试与降级

#### Tool Bus & Model Adapter Layer
- **Tool Bus**（吸收自 OpenClaw + Claude Code）：
  - Tool 注册/发现机制（OpenClaw plugin-sdk 模式）
  - Tool 执行沙箱（per-agent sandbox，吸收自 OpenClaw）
  - Tool policy（allow/deny 列表，per-agent 可配置）
  - Hook 拦截点（before_tool_call / after_tool_call / tool_result_persist）
- **TriModel Adapter**（TriMMC 自有）：
  - 多 provider 适配（Anthropic、OpenAI、OpenRouter、本地模型等）
  - 模型路由与 fallback 链
  - Token 计数与成本追踪

#### Session & State Store Layer
- **吸收自 OpenClaw**：session key 体系、JSONL transcript、session maintenance（prune/rotate/cap）
- **吸收自 Claude Code**：session mode 切换（coordinator vs normal）
- **TriMMC 定制**：
  - Event sourcing 模式（所有 agent 行为作为事件流持久化）
  - 审计日志（合规要求，delegate 模式下的完整操作记录）
  - 状态快照与恢复（crash recovery）

---

## 3. 推理核心设计：Coordinator 模式

这是 TriMMC 相比 OpenClaw 原生 pi-agent ReAct 最关键的升级。吸收自 Claude Code 的 coordinator 推理核心。

### 3.1 工作流程

```
用户任务
  ↓
Coordinator 接收 → 任务分解
  ↓
┌─────────────────────────────────┐
│ Research Phase                  │
│ 并行 Worker(s) 调查代码库      │
│ → 返回 findings（文件路径、行号、类型签名）│
└─────────────────────────────────┘
  ↓ Coordinator 阅读并理解 findings
┌─────────────────────────────────┐
│ Synthesis Phase（Coordinator 自己执行）│
│ 理解问题 → 确定方案 → 编写实现 spec  │
│ → spec 含具体文件路径、行号、修改内容  │
└─────────────────────────────────┘
  ↓
┌─────────────────────────────────┐
│ Implementation Phase            │
│ Worker(s) 按 spec 修改代码      │
│ → 自验证（测试 + typecheck）    │
│ → 提交并报告 commit hash        │
└─────────────────────────────────┘
  ↓
┌─────────────────────────────────┐
│ Verification Phase              │
│ 独立 Worker 验证变更            │
│ → 独立测试、边界情况、回归检查  │
└─────────────────────────────────┘
  ↓
Coordinator 汇总 → 向用户报告
```

### 3.2 关键设计决策

| 决策点 | Claude Code 方案 | TriMMC 采用 |
|--------|-----------------|-----------|
| Worker 隔离 | 每个 worker 独立 context，不能看到 coordinator 对话 | ✅ 采用 |
| Synthesis | Coordinator 必须自己理解 findings，禁止"based on your findings"式惰性委托 | ✅ 采用 |
| Continue vs Spawn | 高 overlap → continue；低 overlap → spawn fresh | ✅ 采用 |
| 验证独立性 | 验证 worker 用 fresh eyes，不承接实现 worker 上下文 | ✅ 采用 |
| 并行度控制 | 只读任务并行；写任务串行（同文件区） | ✅ 采用 |
| Worker tools | 限制工具集（Bash + Read + Edit + MCP），禁止 coordinator 内部工具 | ✅ 采用 |

### 3.3 与赛博公司员工模型的映射

Coordinator 模式下，TriMMC 的 agent 分为两个层级：

- **Coordinator Agent**：对应赛博公司中承担"协调/管理"职责的员工（如总助、CTO、CPO）
- **Worker Agent**：对应赛博公司中执行具体技术任务的员工（如 dev-xxx、tester-xxx、deployer-xxx）

一个 coordinator 可以调度多个 worker，worker 完成子任务后汇报结果。这种模式与赛博公司的岗位体系自然对齐。

---

## 4. 上下文引擎设计

### 4.1 核心接口（吸收自 OpenClaw context engine）

```
ContextEngine {
  ingest(sessionId, message, isHeartbeat) → { ingested }
  assemble(sessionId, messages, tokenBudget) → { messages, estimatedTokens, systemPromptAddition }
  compact(sessionId, force) → { ok, compacted }
  afterTurn(sessionId) → void
}
```

### 4.2 TriMMC 增强

1. **CodeGraph 感知注入**：在 `assemble` 阶段查询模块 `CodeRegistry` 的 codegraph 结果，按需注入相关代码结构摘要，减少 model 自己去读代码的 token 消耗
2. **多级压缩策略**：
   - Level 1：摘要压缩（类似 OpenClaw legacy engine）
   - Level 2：DAG 摘要（保留关键决策路径，压缩中间探索）
   - Level 3：Vector retrieval（仅检索与当前任务最相关的历史片段）
3. **System prompt 动态构建**：根据当前 agent 的员工角色、active skills、模块上下文动态组装 system prompt

### 4.3 ownsCompaction 模式

与 OpenClaw 一致，context engine 区分 owning/non-owning 两种模式：
- **Owning**：引擎完全控制压缩行为（建议 TriMMC 默认模式）
- **Non-owning**：委托 runtime 内置压缩（开发阶段兼容模式）

---

## 5. Hook/Plugin 系统

吸收自 OpenClaw 的双轨 hook 体系，TriMMC 扩展为赛博公司业务流程 hook。

### 5.1 核心 Hook 点（吸收自 OpenClaw）

| Hook | 时机 | 用途 |
|------|------|------|
| `before_model_resolve` | 模型解析前 | 动态切换 provider/model |
| `before_prompt_build` | prompt 构建前 | 注入上下文、system prompt |
| `before_tool_call` | 工具调用前 | 权限校验、参数修正 |
| `after_tool_call` | 工具调用后 | 结果转换、审计 |
| `tool_result_persist` | 工具结果持久化前 | 脱敏、截断 |
| `agent_end` | agent 运行结束 | 状态回写、metrics 收集 |

### 5.2 TriMMC 扩展 Hook

| Hook | 时机 | 用途 |
|------|------|------|
| `before_phase_gate` | 十阶段门禁前 | 阶段准入检查 |
| `after_phase_gate` | 十阶段门禁后 | 阶段产物归档 |
| `before_employee_dispatch` | 员工派发任务前 | 技能匹配、负载检查 |
| `after_employee_report` | 员工上报结果后 | 绩效记录、知识沉淀 |

### 5.3 Plugin SDK

吸收 OpenClaw `plugin-sdk/*` 设计，TriMMC 提供稳定的公共合约边界：
- Plugin 注册/发现
- Engine slot（context engine、memory engine 等可替换）
- Plugin 配置热加载

---

## 6. 多 Agent 隔离体系

吸收自 OpenClaw multi-agent routing，映射到赛博公司员工体系。

### 6.1 Agent 定义

每个 TriMMC agent 拥有：
- **Workspace**：独立文件工作区
- **AgentDir**：认证配置、员工档案、个人 skills
- **Session Store**：独立会话历史
- **Tool Policy**：per-agent 工具权限（allow/deny）
- **Sandbox**：可选的隔离执行环境

### 6.2 与 TriCompany 员工体系的映射

| TriMMC Agent 属性 | TriCompany 员工属性 |
|-----------------|-------------------|
| agentId | employeeId |
| workspace | 员工工作目录 |
| agentDir/AGENTS.md | 员工 soul/岗位描述 |
| tool policy | 员工权限矩阵 |
| skills snapshot | 员工技能清单 |
| session history | 员工工作记录 |

### 6.3 路由规则

吸收自 OpenClaw 的确定性路由（most-specific wins）：
1. peer match（精确 DM/群组 ID）
2. parentPeer match（线程继承）
3. accountId match
4. channel match
5. default agent fallback

在 TriMMC 场景下，路由还包括：
- 任务类型路由（coding → dev agent、testing → tester agent）
- 技能匹配路由（按任务所需技能匹配员工）
- 负载路由（按员工当前负载均衡）

---

## 7. 会话与状态管理

### 7.1 Session 体系（吸收自 OpenClaw）

```
Session Key = agent:<agentId>:<scope>:<peerId>
```

- 直接对话默认 collapse 到 main session
- 按需隔离（per-peer / per-channel-peer / per-account-channel-peer）
- Session 维护：prune（30d）、cap（500 entries）、rotate（10MB）

### 7.2 TriMMC 增强

1. **Event Sourcing**：所有 agent 行为作为事件流持久化，支持时间旅行调试
2. **检查点/快照**：长任务定期快照，支持从中间状态恢复
3. **跨 session 记忆**：与 TriCompany Hermes 记忆系统协作，持久化跨 session 知识

---

## 8. 模块边界与协作

```
TriMMC ←→ TriModel    : 模型调用（provider/model/fallback 统一配置）
TriMMC ←→ TriGateway  : 社交通道消息收发
TriMMC ←→ TriRLC       : 本地域任务分发与执行
TriMMC ←→ TriCompany  : 员工体系、岗位管理、记忆系统
TriMMC ←→ TriDev      : 十阶段流程门禁对接
TriMMC ←→ TriSkill    : 统一 skill 供给（未来）
```

### 8.1 TriModel 协作

TriMMC 不直接管理 provider/model 配置，统一通过 TriModel：
- 模型注册：`provider/model-id` → 端点、认证、参数
- 路由：按任务类型/优先级/成本选择模型
- Fallback 链：主模型不可用时的降级路径
- Token 成本追踪

### 8.2 TriGateway 协作

- **吸收自 OpenClaw**：社交通道实现（WhatsApp/Telegram/Discord 等消息收发、协议适配、消息排队）由 TriGateway 承接，不内嵌于 TriMMC
- 社交通道消息（用户从 WhatsApp/Telegram/Discord 等发送）通过 TriGateway 接入
- TriGateway 负责消息排队、协议适配
- TriMMC 通过 ACP（Agent Communication Protocol）接收 TriGateway 转发的消息
- TriMMC 的回复通过 TriGateway 发送回社交通道
- **与 Tripilot 的关系**：TriGateway 社交通道与 Tripilot webview 聊天界面是并存的两条用户交互通道——如同 OpenClaw 自身架构中 web 主聊天界面与 WhatsApp/Telegram/Discord 社交通道并存一样。用户可以在手机上通过 Telegram 给赛博公司发消息，也可以在 PC 端通过 Tripilot 与同一 agent 继续对话，两条通道共享同一个 TriMMC session

### 8.3 TriRLC 协作

- 本地域任务（文件操作、本地编译、本地测试）由 TriMMC 调度 TriRLC 执行
- TriRLC 作为 detached local runtime，独立于服务域
- 通信通过 TriGateway 或直接 WebSocket

---

## 9. PC 端客户端设计

### 9.1 总体方案

```
Tripilot（webview 主控）                      TriGateway（社交通道）
  ├── 聊天面板（与赛博公司员工对话）              ├── WhatsApp
  ├── 任务面板（查看/管理进行中的任务）            ├── Telegram
  └── 设置面板（模型配置、本地域控制）              └── Discord
  ↓ ACP                                        ↓ ACP
  └────────────────┬─────────────────────────────┘
                   ↓
vscodium（IDE 宿主）
  ├── Tride 插件（编码模型适配）
  ├── TriPilot 扩展（webview 集成）
  └── 本地项目工作区
  ↓
TriMMC 服务端 ←→ TriRLC 本地域
```

### 9.2 组件职责

| 组件 | 职责 | 吸收参考 |
|------|------|---------|
| Tripilot | Webview 主控界面；ACP 连接 TriMMC；任务状态展示 | OpenClaw macOS app / WebChat |
| vscodium | IDE 宿主；代码编辑；扩展生态 | VS Code OSS |
| Tride | 编码模型适配层；调用 vibe coding 工具 | Claude Code / opencode |
| TriPilot 扩展 | webview 内嵌到 vscodium；ACP 客户端 | Copilot Chat |

### 9.3 ACP（Agent Communication Protocol）

- 基于 WebSocket 的双向通信协议
- 消息类型：`task/submit`、`task/status`、`agent/message`、`stream/delta`、`lifecycle/event`
- 支持断线重连与状态恢复（关闭 Tripilot 后下次打开自动重连 TriMMC，继续原有会话）
- 未来扩展：文件同步、本地域任务分发

### 9.4 双通道架构：Tripilot 与 TriGateway

Tripilot 与 TriGateway 的关系直接对标 OpenClaw 自身架构：

| | OpenClaw | TriMetaverse |
|------|----------|-------------|
| 主聊天界面 | OpenClaw WebChat（浏览器） | Tripilot（webview，打包为 PC 客户端） |
| 社交通道 | WhatsApp / Telegram / Discord | TriGateway（吸收 OpenClaw 实现） |
| 通信协议 | OpenClaw 内部 RPC | ACP（统一 WebSocket 协议） |
| 会话模型 | 同一 agent session 跨通道共享 | 同一 agent session 跨 Tripilot + TriGateway 共享 |

**Tripilot 的特殊性**：与 OpenClaw WebChat 不同，Tripilot 打包为 PC 端本地应用。即使关闭 PC 客户端，下次打开时通过 ACP 断线重连机制自动恢复与 TriMMC 的连接，继续原有会话——用户不会丢失上下文或任务进度。

### 9.5 会话模型验证与吸收基准（已验证）

基于对 `reference/openclaw-v2026.3.28/` 源码的逐文件阅读，以下 TriMMC 会话模型设计已有明确吸收基准。

#### 9.5.1 OpenClaw 会话隔离级别

OpenClaw 的 `buildAgentPeerSessionKey()`（`src/routing/session-key.ts` L127–174）定义了 4 级 `dmScope` 隔离：

| dmScope | Session Key 示例 | 行为 |
|---------|-----------------|------|
| `"main"`（**默认**） | `agent:main:main` | 所有 DM，所有通道 → 同一个 session |
| `"per-peer"` | `agent:<agentId>:<canonicalId>` | 按 peer 分 session，通道无关 |
| `"per-channel-peer"` | `agent:<agentId>:<channel>:direct:<peerId>` | 通道+peer 完全隔离 |
| `"per-account-channel-peer"` | （最细粒度） | 按账号+通道+peer 三层隔离 |

**TriMMC 吸收策略**：赛博公司场景默认采用 `"main"` 级别——用户从 Tripilot、Telegram、Discord 等任意通道发消息，默认路由到同一个 agent session，保证上下文连续性。

#### 9.5.2 跨通道身份合并（identityLinks）

`resolveLinkedPeerId()`（`src/routing/session-key.ts` L176–220）通过配置映射实现不同平台 peer ID → 同一 canonical identity：

```yaml
# OpenClaw 配置示例（TriMMC 等价实现）
identityLinks:
  "user-alice":
    - "telegram:12345"
    - "tripilot:alice-session-abc"
```

**效果**：Alice 从 Telegram 发消息和从 Tripilot 发消息 → 解析到同一 canonical identity → 同一 agent session，无需显式绑定。

#### 9.5.3 Session Binding（显式跨通道合并）

`SessionBindingService`（`src/infra/outbound/session-binding-service.ts`）提供编程式 API：

- `bind(targetSessionKey, {channel, accountId, conversationId})` — 将任意会话显式绑定到指定 session
- `resolveByConversation()` — 查询当前会话是否已绑定到其他 session（绑定优先于路由）
- `unbind()` / `listBySession()` — 解绑与批量查询

**路由优先级**：Session Binding > identityLinks > dmScope 默认路由

#### 9.5.4 TriMMC 实施决策

| 决策点 | 吸收来源 | TriMMC 实现方向 |
|--------|---------|---------------|
| 默认 dmScope | OpenClaw `"main"` | TriMMC 默认所有 DM 共享同一 session |
| 通道隔离需求 | `"per-channel-peer"` | 通过 agent config 可选开启 |
| 跨通道身份合并 | `identityLinks` | 通过 TriModel 用户身份系统实现 |
| 显式绑定 API | `SessionBindingService` | TriMMC Session Store 层提供等价 API |

**关键结论**：OpenClaw 原生支持隔离与合并两种模式，TriMMC 选择"默认共享 + 可选隔离 + 显式绑定兜底"三层策略，完全覆盖赛博公司"用户从多个入口访问同一赛博员工"的业务场景。

#### 9.5.5 源码验证记录

已验证的 OpenClaw 源文件：
- `src/routing/session-key.ts`：`buildAgentPeerSessionKey()`（L127–174）、`resolveLinkedPeerId()`（L176–220）、`buildAgentMainSessionKey()`（L118–125）
- `src/routing/resolve-route.ts`：路由解析入口，agent ID + session key + main key 三级路由
- `src/channels/plugins/binding-routing.ts`：Session binding 路由覆写
- `src/infra/outbound/session-binding-service.ts`：完整 SessionBindingService API
- `src/config/sessions/session-key.ts`：per-sender vs global session 作用域
- `extensions/telegram/src/conversation-route.ts`：Telegram 通道的 session routing 实现（含 SessionBinding 集成）
- `extensions/telegram/src/conversation-route.base-session-key.test.ts`：Telegram 基础 session key 测试用例

验证日期：2026-07-08 | 验证人：小贾（CEOChiefOfStaff）

---

## 10. 技术选型

### 10.1 主语言：Go

**选择理由**：

| 维度 | Go | 为什么匹配 TriMMC |
|------|-----|-----------------|
| **并发模型** | goroutine + channel | TriMMC 的本质是并发 agent 调度——每个 agent、每个 worker、每个 tool call 都可以是一个 goroutine。`select` 多路复用天然匹配 coordinator 等待多 worker 结果的场景 |
| **部署形态** | 单二进制，零依赖 | TriMMC 最终要部署到服务器做 daemon，拷一个文件就能跑 vs Node.js 需要 runtime + node_modules |
| **性能** | 编译型，goroutine 轻量（2KB 栈） | 数百个 agent 并发时，Go 的内存开销远低于 Node.js worker_threads |
| **版权距离** | TS/JS → Go 跨语言 | 从 Claude Code（TS）和 OpenClaw（TS）到 Go，是清晰的"重新实现"边界，不构成衍生作品 |
| **生态** | 丰富的 RPC、WebSocket、数据库驱动 | `net/http`、`gorilla/websocket`、`gRPC`、`sqlx` 等成熟方案，无需从零造轮子 |

**不选其他语言的原因**：

| 语言 | 为什么不选 |
|------|-----------|
| **TypeScript/Node.js** | 与原项目同语言，版权风险最高；单线程模型需 worker_threads 绕路；部署需 runtime |
| **Rust** | 性能更强，但开发速度慢 3–5 倍；async 生态复杂；当前阶段人力有限，迭代速度优先 |
| **Python** | GIL 限制真并发；性能差 Go 10–30 倍；部署依赖多 |
| **C** | 太底层；内存管理负担重；不适合应用层 agent runtime |

**Go 的已知短板**：

- 类型系统不如 Rust 表达力强（没有 sum type / pattern matching），错误处理啰嗦（`if err != nil`）
- GC 在极端长运行场景下可能有延迟抖动（但 Go 1.21+ 的 GC 已做到 sub-ms）
- 如果未来性能瓶颈确实落在 GC 上，Coordinator + Inference 核心层可以局部用 Rust 重写（FFI），不影响整体架构

### 10.2 关键依赖

| 领域 | Go 方案 | 说明 |
|------|---------|------|
| HTTP/WS 服务器 | `net/http` + `gorilla/websocket` | 标准库 + 成熟 WS 库 |
| RPC | `gRPC` 或自研 ACP | 内部服务间通信 |
| 数据库 | `PostgreSQL`（事件存储）+ `SQLite`（本地缓存） | 生产 + 本地双轨 |
| 配置 | `viper` | 支持 JSON/YAML/TOML |
| 日志 | `zerolog` 或 `slog` | 结构化日志 |
| 测试 | 标准 `testing` + `testify` | Go 标准测试体系 |

### 10.3 版权策略

Claude Code 的知识产权吸收采用**间接转译**策略：
1. 阅读和理解 Claude Code 的推理核心设计（coordinator 模式、worker 调度、context continuation）
2. 用 Go 语言从零实现等价功能（不复制代码，只吸收架构设计）
3. 目标性能优于原文（Go 编译型 vs JS 解释型）
4. 对 OpenClaw 同样采用"吸收架构 + Go 重写"策略

---

## 11. 分阶段实施计划

### Phase 1：Copilot-host 本地手动版验证（当前）
- 赛博公司在 Copilot 宿主上以手动形态运行
- 目标：在本地原型上验证编排路径、研发流程和员工协作模式
- TriMMC 角色：`vendor/openclaw/` 作为 shadow 基线参考，为正式版架构设计提供输入
- 产出：确认哪些编排路径是必要的、哪些可以简化，沉淀为 TriMMC 正式版的需求基线

### Phase 2：TriMMC 最小 Runtime（V0.1）
- 实现 Gateway + Agent Runtime + Session Store 三层
- 单 agent 模式跑通（无 coordinator，类似 OpenClaw 单 agent 模式）
- 对接 TriModel（基本模型调用）
- 目标：TriMMC 作为一个独立进程运行，能接收消息并回复——赛博公司首次脱离 Copilot 宿主运行

### Phase 3：Coordinator 推理核心（V0.2）
- 实现 Coordinator 模式（任务分解 → 并行 worker → synthesis → verification）
- 实现 Context Engine（基本组装 + 压缩）
- 实现 Tool Bus（基本 tool 注册/执行）
- 目标：TriMMC 能自主编排多 worker 完成复杂任务——编排能力从手动升级为自动

### Phase 4：多 Agent + 员工体系（V0.3）
- 实现 multi-agent isolation
- 对接 TriCompany 员工体系
- 实现 per-agent tool policy + sandbox
- 实现 Hook/Plugin 系统
- 目标：全部赛博公司 AI 员工在 TriMMC 上运行——从少数关键岗位扩展到全员上岗

### Phase 5：完整集成（V1.0）
- 对接 TriGateway（社交通道）
- 对接 TriRLC（本地域）
- 对接 TriDev（十阶段门禁）
- PC 客户端（Tripilot + vscodium + Tride）打包
- 目标：赛博公司以服务器正式版形态完整自动化运行，覆盖多用户接入和规模化服务

---

## 12. 当前状态与风险

### 12.1 已完成
- OpenClaw 架构深度阅读（agent-loop、multi-agent、delegate、context-engine、session、compaction、hooks）
- Claude Code coordinator 模式深度阅读
- 六层架构框架确定
- 模块边界初步划定

### 12.2 待完成
- [ ] CPO/CTO 联审本设计
- [ ] 确认 Go vs Rust 最终语言选择
- [ ] TriModel 详细接口定义
- [ ] ACP 协议规范
- [ ] Claude Code 源码放入 `reference/`
- [ ] Phase 2 开发启动

### 12.3 主要风险
1. **吸收复杂度**：OpenClaw 和 Claude Code 都是大型项目，完全吸收需要时间
2. **版权边界**：需确保 Go 重写不被认定为"衍生作品"
3. **员工模型定位**：赛博公司员工体系本身在演进中，TriMMC 需要与之对齐
4. **资源投入**：当前 Copilot-host 阶段人力有限，Phase 2 需要确定开发资源
