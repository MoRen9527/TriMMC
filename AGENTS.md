# TriMMC Agent Rules

## Module Role

- TriMMC 是服务域主控模块。
- 它负责任务控制、服务域执行、审计、事件聚合与结算相关能力。
- 当商业模式涉及服务域能力、任务编排、审计和结算时，必须考虑本模块。

## Strategy Delegation

- 总商业模式、当前实验是否需要服务域优先、模块边界变化，先咨询 `TriMetaverse/BusinessStrategy`。
- `core-agent` 只能作为历史 observability 迁移源，不应在本地被重新当作现役主控。

## Local Fact Sources

- 产品事实：`README.md`
- 代码事实：`src/`、`test/`、`sql/`

## Current Registries

- `TriMMCBusinessStrategyRegistry`
- `TriMMCProductRegistry`
- `TriMMCCodeRegistry`

当前 registry agent canonical discovery 位于 `TriMMC/.github/agents/`。同名中央 discovery 文件不应在 `TriMetaverse/.github/agents/` 并行保留；中央只通过 manifest 和 registry closeout 工作流路由本模块 registry。

## Update Discipline

- 若本模块事实与中央边界冲突，先报告冲突，再请求更新中央 strategy registry。
