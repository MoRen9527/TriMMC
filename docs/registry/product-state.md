# TriMMC Product State

## Module Overview

- `TriMMC` 是服务域主控模块，当前仓内已验证的现役产品面是“服务域控制骨架 + observability/replay 基线 + OpenClaw shadow 吸收起点”。
- 它负责服务域任务接入、控制面占位、节点桥接占位、风险门禁骨架、审计事件归一化与 timeline/replay 能力，并作为后续服务器端 agent 集群主控的承接模块。
- README 中出现的 “unified agent runtime and interaction core” 写法，可以理解为长期目标方向；但按当前 `AGENTS.md` 与已落地代码，登记层应优先把它写成“服务域主控本体”，而不是已完成的全量统一 runtime。

## Current Product Scope

- 承接 `TriMetaverse` 当前服务域执行切片，向下游本地域节点和未来宿主适配层预留控制接口。
- 对内提供最小 HTTP 控制面，包括健康检查和任务接单占位接口。
- 对内维护 observability / replay 基线，用于吸收 `core-agent` 的相关能力，而不是把 `core-agent` 重新当作现役主控。
- 以 `vendor/openclaw/` 作为 shadow 吸收参考基线之一，用于承接 Gateway 协议、节点执行语义与后续服务域演进。2026-07-10 中央收口后已裁为薄参考层：社交通道归入 TriGateway，消息队列管理归入 TriMMC。
- 正在吸收 Claude Code 2.1.88 的 agent 循环、tool system、task system、cron/hooks 与 permission 设计，用于支撑赛博岗位的常驻任务与定时任务。**Claude Code 是 TriMMC 的 agent infra 层，不是产品面。**
- 后续配合 `TriHost` 承接正式宿主落地配置，配合 `TriStaciss` 做多模型路由、成本控制、模型适用边界判断与 Anthropic-compatible 端点（`POST /v1/messages`）调用。
- 长期目标是吸收 Claude Code harness 设计并自建编排层（Soul Loader + Memory Injector + Tool Gater + Context Builder），形成服务器端 agent 主控，统御各赛博员工的集群控制与调配。
- **产品基调约束（2026-07-10 中央收口）**：员工 = 角色 + 四层记忆 + Hermes 融合，不是 coding agent。产品面输出必须保持"公司员工味"，编排面驱动角色人格，infra 面只提供能力池。核心原则："员工是会写代码的 CPO，不是碰巧叫小乔的 coding agent"。
- **本地演练场（2026-07-10 新增）**：Claude Code CLI 直接运行于 Windows，使用同一份 restored-src 源码。本地验证通过后发布至 TriMMC 服务器，保证绝对 dev-prod parity。
- 目前不能把 planner、context、tool orchestration、model-call 能力写成已落地现役产品面；仓内尚未看到对应目录和稳定入口。
- 涉及具体项目代码仓库时，产品侧文档基线应按 `PROJECT.md`、`REQUIREMENTS.md`、产品版 `ROADMAP.md` 和产品版 `STATE.md` 维护；若缺失，应视为待补齐的产品真源缺口。

## Current Progress

- 已具备根级 `AGENTS.md`、`README.md` 和首版 registry 工作层。
- 已具备可启动的 Node.js/TypeScript 服务骨架，入口为 `src/index.ts`，当前提供 `/healthz` 和 `/internal/v1/tasks` 两个可验证接口面。
- 已具备 `task-controller`、`node-bridge`、`policy-gate`、`observability`、`contracts`、`config` 等目录布局。
- 已具备 observability mapper 与 timeline/replay 测试基线，`test/` 目录中已有两组 Node test。
- 已具备 `sql/` 与 `vendor/openclaw/` 作为后续 shadow 吸收与数据库初始化配套面。
- ✅ TriModel Phase 4 依赖就绪：`ChatResponse.usage` 编译期必选，`UsageAccumulator` 可跨 turn 聚合 token 用量。
- ✅ **TokenUsage 接入已完成（2026-07-14，CTO 交付）**：`agentLoop()` 内部使用 `UsageAccumulator` 跨 turn 累计，所有 `loop_end` 路径（done/max_turns/error）均携带 `UsageSummary`，`runAgentLoop()` 返回 `UsageSummary`。下游消费端（SSE 端点、batch runner）通过 `loop_end` 事件直接获取聚合用量，无需修改。

## Bug And Gap State

- 当前产品成熟度仍明显偏骨架化：任务接单、节点桥接和 HTTP 面已存在，但真正的任务编排、节点调度、审批状态机、结算与大规模执行链路尚未在现役实现中展开。
- OpenClaw / Claude Code harness、心跳、cron、常驻岗位任务和多模型调度目前是吸收方向与产品目标，不能写成已完成生产级实现。
- README 的长期目标口径比当前代码落地更宽，若直接照抄，会高估 TriMMC 已经承接的运行面能力。
- 与 `TriRLC` 的服务域 / 本地域协作链路虽在中央文档中已有方向，但仓内当前仍主要是接口和职责占位。
- 与 `TriHost` 的正式宿主适配关系仍停留在规划口径，尚未见到现役适配代码。
- 产品层仍缺少更稳定的 `PROJECT.md`、`REQUIREMENTS.md`、产品版 `ROADMAP.md`、产品版 `STATE.md`，导致长期目标与当前成熟度只能分散在 README、中央文档和 registry 中表达。
- ~~TokenUsage 消费缺口~~ ✅ **已完成（2026-07-14，CTO 交付，CPO 验收）**：agent loop 已接入 `UsageAccumulator`，跨 turn 累计，全部 `loop_end` 路径携带 `UsageSummary`。注：原始票中提及的 `weeklyReportTemplate.ts` / `benchmarkSummary.ts` 是 SQL 门禁模板，非 agent loop token 消费端；实际消费在 agent loop 事件边界（SSE/JSON 端点），无需修改 SQL observability 文件。

## Cross-Module Dependencies

- 与 `TriMetaverse` 中央战略和合同文档对齐，尤其是 “TriStaciss 做模型路由与 API 调用平台、TriMMC 做服务域主控、TriRLC 做本地域适配层” 的边界。
- 与 `TriRLC` 协同形成服务域到本地域的任务分发链路，但当前仓内更多是桥接骨架而不是完整调度实现。
- 与 `core-agent` 存在历史 observability 迁移关系；该关系是“吸收支撑子系统”，不是“恢复 core-agent 为现役主控”。
- 与 `TriHost` 存在未来正式宿主适配关系，与 `TriStaciss` 存在模型路由 / 官方 SDK 调用协同关系，但仍属于待落地边界。

## Architecture State

- 当前已落地的核心是服务域控制骨架：HTTP 启动面、任务接入占位、node-bridge 占位、observability/replay 子系统和 OpenClaw shadow 参考基线。
- 当前不应把 TriMMC 描述为“完整统一 runtime 已成型”；更准确的说法是“服务域主控骨架已建立，部分 observability 基线已吸收，其他运行面能力待继续落地”。

## Sources

- `../../AGENTS.md`
- `../../README.md`
- `../../package.json`
- `../../src/index.ts`
- `../../src/server/app.ts`
- `../../src/task-controller/controller.ts`
- `../../src/node-bridge/bridge.ts`
- `../../src/observability/timelineReplayApi.ts`
- `../../test/timelineReplayApi.test.ts`
