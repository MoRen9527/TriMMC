# TriMMC 模块启动与控制面导读

本文档是 TriMMC 首轮模块摸底后的导读版说明，目标是让第一次接手 TriMMC 的人快速回答五个问题：它是什么、现在能跑什么、代码从哪读、哪些地方只是骨架、下一步应该在哪些面继续落地。

## 1. 先说一句话定义

TriMMC 当前最准确的定义不是“已经完成的统一 runtime”，而是“三元宇宙里的服务域主控骨架”。

如果再展开一点，就是：

1. 它在服务域承接任务接入和控制平面的最小入口。
2. 它为节点桥接、风险门禁、审计事件和 replay 能力预留并落下了第一批代码位点。
3. 它已经开始吸收 `core-agent` 的 observability/replay 能力，但没有把 `core-agent` 恢复成现役主控。
4. 它把 `vendor/openclaw/` 当成 shadow 吸收参考基线，而不是直接把 vendored 代码等同于 TriMMC 自研主实现。

## 2. 当前仓里哪些是现役真源

第一次读 TriMMC，优先看这几类文件：

- `AGENTS.md`
- `README.md`
- `package.json`
- `src/index.ts`
- `src/server/app.ts`
- `src/task-controller/controller.ts`
- `src/node-bridge/bridge.ts`
- `src/observability/`
- `test/*.test.ts`
- `docs/registry/product-state.md`
- `docs/registry/code-state.md`

当前不要把下面这些直接当成“现役能力已经成熟”的证据：

- `vendor/openclaw/`：这是 shadow 吸收基线，不是 TriMMC 自研控制平面的同义词。
- README 里关于 unified runtime 的长期目标表述：它能说明方向，但不能自动代表当前实现完成度。
- 中央合同文档里对 TriMMC 的目标边界：这些文档定义了未来应该长成什么，不等于仓里今天已经全部落地。

## 3. TriMMC 现在能跑什么

### 3.1 启动方式

```powershell
cd TriMMC
npm install
npm run dev
```

也可以用：

```powershell
npm run check
npm test
```

`package.json` 当前脚本很直接：

- `dev`: `tsx watch src/index.ts`
- `build`: `tsc -p tsconfig.json`
- `check`: `tsc -p tsconfig.json --noEmit`
- `test`: `node --import tsx --test test/**/*.test.ts`

所以它是一个很标准的 Node 20 + TypeScript + tsx 运行面骨架。

### 3.2 实际启动链路

TriMMC 的最短启动链路是：

`src/index.ts` -> 读取环境变量 -> `createTriMMCApp(env)` -> `app.start()` -> 启动 HTTP server

也就是说，真正的主装配点是 `src/server/app.ts`。

### 3.3 当前 HTTP 面

`src/server/app.ts` 现在只明确做了三件事：

1. 注册 `/healthz`
2. 注册 `POST /internal/v1/tasks`
3. 其余请求返回 `404 not_found`

这很重要，因为它直接告诉你：TriMMC 已经具备最小服务入口，但还远没到完整控制面 API 的阶段。

## 4. 两条现役链路是怎么走的

### 4.1 健康检查链路

最短路径：

`HTTP GET /healthz` -> `src/server/app.ts` -> 返回 `{ ok: true, service: 'trimc' }`

这条链路主要用来证明进程是否启动成功，不承载业务编排逻辑。

### 4.2 任务接单链路

最短路径：

`HTTP POST /internal/v1/tasks` -> `TaskController.acceptPlaceholder()` -> 返回 accepted/queued 占位响应

这里的核心事实是：

- TriMMC 已经有 “接单” 动作。
- 但当前接单只到 placeholder 阶段。
- 它还没有在现役代码中展开成完整任务状态机、审批、调度和执行桥接链路。

`controller.ts` 返回的数据也很直白：

- `controller: 'trimc-main'`
- `status: 'accepted'`
- `queueStatus: 'queued'`

这说明现阶段更像“确认进入队列”，而不是“已经开始完整执行”。

## 5. Node bridge 现在到了哪一步

如果你只看目录名，很容易以为 TriMMC 已经具备完整 node-bridge。实际不是。

当前 `src/node-bridge/bridge.ts` 只有一个主要动作：

- `offerTask(request)`

但这个动作目前只是打印日志：

```ts
console.log('[trimc/node-bridge] offer task', request.taskId, request.targetNodeId)
```

这代表两层意思：

1. 目录边界已经定了，桥接职责已进入现役代码面。
2. 真实的节点下发、回执、失败恢复、重试和生命周期管理还没有在这里成型。

因此，当前最准确的表述是“node-bridge 占位实现已存在”。

## 6. 目前最成熟的子系统其实是 observability

TriMMC 当前最像“已经从骨架走向具体实现”的部分，是 `src/observability/`。

这里已经包含：

- `mapper.ts`
- `contractSamples.ts`
- `timelineReplayApi.ts`
- `postgresClient.ts`
- `timelineReplaySqlStores.ts`
- `runtime.ts`

其中 `timelineReplayApi.ts` 已经明确支持：

1. event ingest / bulk ingest
2. 按 session 查询 timeline
3. 按 trace 分页查询 timeline
4. start replay
5. stop replay
6. get replay

对应测试也已经存在：

- `test/observabilityMapper.test.ts`
- `test/timelineReplayApi.test.ts`

所以，如果你想找 TriMMC 当前“最落地”的代码面，优先看 observability，而不是先看 node-bridge。

## 7. 第一次读代码，推荐顺序

如果你想快速理解控制面骨架，建议按这个顺序：

1. `AGENTS.md`
2. `README.md`
3. `package.json`
4. `src/index.ts`
5. `src/server/app.ts`
6. `src/task-controller/controller.ts`
7. `src/node-bridge/bridge.ts`
8. `src/observability/timelineReplayApi.ts`
9. `test/timelineReplayApi.test.ts`

如果你想判断“哪些还只是规划”，一个简单方法是看三件事有没有同时出现：

1. 真实目录和入口文件
2. 对外装配或调用路径
3. 测试或 SQL/runtime 配套

例如：

- observability：三者基本都有，所以成熟度更高。
- task-controller：有入口，但实现仍薄。
- node-bridge：有目录和占位方法，但缺少完整链路。
- planner/context/model-call：当前连目录级证据都不足，所以不能写成已落地。

## 8. 当前最容易踩的坑

这轮摸底最值得直接记住的坑有五个：

1. README 的长期目标写法比当前代码更宽，不能直接当成现状说明。
2. TriMMC 的现役服务面目前非常小，只有健康检查和任务接单占位。
3. `TaskController` 和 `NodeBridge` 都还处在薄实现阶段，目录存在不等于能力成熟。
4. `core-agent` 和 `vendor/openclaw/` 都容易被误当成 TriMMC 的现役主实现，需要持续显式区分。
5. observability/replay 已经比控制平面更成熟，容易让人误判“整个 TriMMC 已经差不多完成”。

## 9. 下一步如果继续做 TriMMC，最合理的切口是什么

如果下一轮还要继续深挖 TriMMC，最自然的切口只有三个：

1. 把 `/internal/v1/tasks` 从 placeholder 接口推进到真正的任务状态机。
2. 把 `node-bridge` 从日志占位推进到真实节点桥接和回执链路。
3. 把 policy-gate、SQL runtime、observability 和任务控制面真正装配起来，形成最小可回放执行流。

## 10. 最后总结

一句话收尾：TriMMC 现在已经是一个方向明确、结构清楚的服务域主控骨架，但还不是完整成型的统一 runtime；最成熟的是 observability/replay，最需要继续长的是任务控制、桥接和门禁三条主链。
