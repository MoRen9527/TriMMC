# TriMC

TriMC is the unified agent runtime and interaction core for TriMetaverse.

Current boundary:

- During the current copilot-host stage, both shadow and formal takeover still run directly on Copilot as the active host.
- TriMC now represents the unified runtime-side boundary for service-domain execution and the R&D workflow slice.
- TriHost is the planned host-adaptation and cutover layer for the go-live stage.
- Tride remains part of the PC-side software stack and is not the formal host of the R&D workflow.
- The virtual company remains the business and interaction carrier, not a third infrastructure host.

Responsibilities:

- host the unified runtime core for service-domain execution and the R&D workflow slice
- bridge OpenClaw gateway semantics and node execution lifecycle
- enforce confirmation, high-risk interception, and privacy protection
- dispatch tasks to TriLC nodes
- aggregate execution, audit, and settlement events
- absorb the core-agent observability and replay subsystem
- extend planner, context, tool orchestration, and model-call capabilities as code lands

Stable OpenClaw baseline:

- vendor/openclaw: vendored stable OpenClaw source snapshot at version 2026.3.28
- this snapshot is the starting point for evolving OpenClaw into the TriMC runtime shadow baseline

Planned modules:

- src/server: bootstrap and HTTP surface
- src/task-controller: task state machine and orchestration
- src/node-bridge: OpenClaw node and gateway integration
- src/policy-gate: approval, risk, and privacy gate
- src/contracts: shared protocol contracts
- src/observability: audit mapping, timeline query, replay, and SQL stores

Observability migration baseline:

- `src/observability/contractSamples.ts`: migrated sample event source for mapper and replay tests
- `test/*.test.ts`: migrated baseline tests from `core-agent`
- `sql/init_observability_tables.sql`: migrated Postgres bootstrap for timeline/replay tables

Useful commands:

- `npm run check`
- `npm test`

## 中央连接面（LG-030 勘定 2026-09-04）

- 中央面（本仓，sg 部署 /srv/fleet/TriMC 物理冻结）服务端口 8710；接收本机 TriRLC（8711）与 TriMLC-Channel（8713）上送。heyuan TriRMC 为 R 面周平面迁移自治执行点——「上送中央面+R 面执行迁移」双职责分属两节点。
- 连接面变更须 CEO 明令（D-17 在册）。
- 审计条款（LG-031）：M/R 面按承载语义连，非按面名连。
