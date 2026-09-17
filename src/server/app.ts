import { createServer, type Server } from 'node:http';
import * as path from 'node:path';
import type { TriMCEnv } from '../config/env.js';
import {
  createCronService,
  createCronRouteHandler,
  type CronService,
} from '../cron/index.js';
import { TaskController } from '../task-controller/controller.js';
import { createModelClient, type Message } from 'trimodel';
import { agentLoop } from '../agent-loop/loop.js';
import type { AgentEvent } from '../agent-loop/loop.js';
import { assemblePipelineOptions } from '../pipeline/assemble.js';
import type { AgentContract } from '../contracts/agent-contract.js';
import type { AgentTier } from '../agent-loop/permissions.js';
import { arbitrate } from '../comm/arbitration.js';
import { MirrorStore } from '../mirror/store.js';
import type { MirrorTaskStatus } from '../mirror/types.js';
import {
  spawnSession,
  listAgents,
  sendMessage,
  buildRegistry,
  type AgentSession,
  type SessionBridgeOptions,
} from '../orchestration/session-bridge.js';
import {
  readConfigSyncStatus,
  resolveDefaultModel,
  resolveFlashModel,
} from '../config-sync/index.js';

export function createTriMCApp(env: TriMCEnv) {
  const taskController = new TaskController();
  const mirrorStore = new MirrorStore();
  const modelClient = createModelClient();
  let server: Server | null = null;

  // 心跳超时扫描定时器（heartbeat-dualrun-contract v1.0 §3.3）：
  // 每 10s 扫节点心跳表，超阈值（30s 常规 / 180s degraded）→ markNodeUnknown
  let heartbeatScanTimer: ReturnType<typeof setInterval> | null = null;

  // ── M1 Phase-2: Session Bridge（编排层 ↔ 官方 claude 会话）──
  const bridgeOptions: SessionBridgeOptions = {
    runAsUser: env.runAsUser,
    cwd: env.bridgeCwd,
  };

  // ── Cron scheduler（cron 域，r1-2）──
  // 日志目录默认与 agent-core job-store 同根：$TRIMC_CONFIG_DIR/cron/logs。
  const cronService: CronService | null = env.cronEnabled
    ? createCronService({
        logDir:
          env.cronLogDir ??
          path.join(process.env.TRIMC_CONFIG_DIR ?? path.resolve('data'), 'cron', 'logs'),
      })
    : null;
  const handleCronRoutes = cronService ? createCronRouteHandler(cronService) : null;

  /** 最近一次注册表快照（ListAgents 采集结果） */
  let registrySnapshot: AgentSession[] = [];

  async function handleChat(req: { body: string }): Promise<object> {
    let parsed: { model?: string; messages?: Message[] };
    try {
      parsed = JSON.parse(req.body);
    } catch {
      return { error: 'invalid_json' };
    }

    const { model, messages } = parsed;
    if (!model || !messages || !Array.isArray(messages)) {
      return { error: 'missing model or messages' };
    }

    try {
      const response = await modelClient.chat(model, messages);
      return { ok: true, ...response };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.startsWith('Unknown model')) {
        return { error: 'unknown_model', message: msg, available: modelClient.listModels() };
      }
      return { error: 'model_error', message: msg };
    }
  }

  return {
    async start(): Promise<void> {
      server = createServer(async (req, res) => {
        if (req.url === '/healthz') {
          // cron 块对齐 TriLC app.ts healthz：{enabled, jobCount, degraded, consecutiveFailures}
          // （enabled = service running；字段名与 TriLC healthz 一致）
          const cronStatus = cronService ? await cronService.getStatus() : null;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: true,
              service: 'trimc',
              cron: cronStatus
                ? {
                    enabled: cronStatus.running,
                    jobCount: cronStatus.jobCount,
                    degraded: cronStatus.degraded,
                    consecutiveFailures: cronStatus.consecutiveFailures,
                  }
                : {
                    enabled: false,
                    jobCount: 0,
                    degraded: false,
                    consecutiveFailures: 0,
                  },
            }),
          );
          return;
        }

        // ── 内部面鉴权（P0 加固 2026-08-25：8710 公网可达，/internal/* 原零鉴权
        // 且 cron job 可执行任意 bash = 未认证 RCE 面）。TRIMC_INTERNAL_TOKEN
        // 未配置时维持旧行为（兼容未迁移调用方），配置后强制校验。 ──
        const internalToken = process.env.TRIMC_INTERNAL_TOKEN ?? '';
        if (internalToken && (req.url ?? '').startsWith('/internal/')) {
          const h = req.headers;
          const supplied = Array.isArray(h['x-internal-token'])
            ? h['x-internal-token'][0]
            : (typeof h.authorization === 'string' && h.authorization.startsWith('Bearer ')
                ? h.authorization.slice(7)
                : h['x-internal-token']);
          if (supplied !== internalToken) {
            res.writeHead(401, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'unauthorized: missing or invalid X-Internal-Token' }));
            return;
          }
        }

        // ── GET /internal/v1/agents ──
        // M1 Phase-2: 会话注册表（claude agents --json 采集 + employeeId 映射）
        if (req.url === '/internal/v1/agents' && req.method === 'GET') {
          const sessions = await listAgents(bridgeOptions);
          registrySnapshot = buildRegistry(sessions);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: true,
              count: registrySnapshot.length,
              fetchedAt: new Date().toISOString(),
              agents: registrySnapshot,
            }),
          );
          return;
        }

        // ── POST /internal/v1/agents/{id}/message ──
        // M1 Phase-2: SendMessage 桥 → 状态机 queued→running→completed/failed
        const agentMessageMatch = /^\/internal\/v1\/agents\/([^/]+)\/message$/.exec(req.url ?? '');
        if (agentMessageMatch && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const raw = Buffer.concat(chunks).toString('utf-8');
          let body: { message?: string };
          try {
            body = JSON.parse(raw);
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'invalid_json' }));
            return;
          }
          if (!body.message || typeof body.message !== 'string' || body.message.trim().length === 0) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'bad_request', message: 'message is required' }));
            return;
          }

          // 寻址：sessionId 精确 → agentId 精确 → name 匹配（如未命中，拉一次实时注册表兜底）
          const lookupKey = agentMessageMatch[1];
          let session = registrySnapshot.find(
            (s) => s.sessionId === lookupKey || s.agentId === lookupKey || s.name === lookupKey,
          );
          if (!session) {
            registrySnapshot = buildRegistry(await listAgents(bridgeOptions));
            session = registrySnapshot.find(
              (s) => s.sessionId === lookupKey || s.agentId === lookupKey || s.name === lookupKey,
            );
          }
          if (!session) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'agent_not_found', key: lookupKey }));
            return;
          }

          // 状态机：queued → running
          const task = taskController.createTask(body.message, 'normal');
          taskController.updateTaskStatus(task.taskId, 'running');

          const bridge = await sendMessage(session.sessionId, body.message, bridgeOptions);
          if (bridge.ok) {
            const done = taskController.completeTask(task.taskId, bridge.reply ?? '');
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                ok: true,
                agent: { agentId: session.agentId, name: session.name, sessionId: session.sessionId },
                task: done,
                reply: bridge.reply,
              }),
            );
          } else {
            const failed = taskController.failTask(task.taskId, bridge.error ?? 'bridge_failed');
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                ok: false,
                error: 'bridge_failed',
                timedOut: bridge.timedOut ?? false,
                task: failed,
              }),
            );
          }
          return;
        }

        // ── POST /internal/v1/agents ──
        // M1 Phase-2: spawn 新会话（body: { name, task }）
        if (req.url === '/internal/v1/agents' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const raw = Buffer.concat(chunks).toString('utf-8');
          let body: { name?: string; task?: string };
          try {
            body = JSON.parse(raw);
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'invalid_json' }));
            return;
          }
          if (!body.name || typeof body.name !== 'string' || !body.task || typeof body.task !== 'string') {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'bad_request', message: 'name and task are required' }));
            return;
          }
          const spawned = await spawnSession(body.name, body.task, bridgeOptions);
          if (!spawned.ok || !spawned.agentId) {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'spawn_failed', message: spawned.error }));
            return;
          }
          registrySnapshot = buildRegistry(await listAgents(bridgeOptions));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, agentId: spawned.agentId, name: spawned.name }));
          return;
        }

        if (req.url === '/hello' && req.method === 'GET') {
          try {
            // 模型名三级解析 flash 变体（§四）：applied catalog flash 别名 > 兜底常量
            const response = await modelClient.chat(await resolveFlashModel(), [
              {
                role: 'system',
                content:
                  'You are TriMetaverse AI. Greet the user warmly in 1-2 sentences. Mention you are part of the TriMetaverse ecosystem and ready to serve.',
              },
              { role: 'user', content: 'Say hello!' },
            ]);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                ok: true,
                greeting: response.content,
                model: response.model,
                usage: response.usage,
              }),
            );
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            if (msg.startsWith('Unknown model')) {
              res.writeHead(400, { 'content-type': 'application/json' });
              res.end(
                JSON.stringify({
                  error: 'unknown_model',
                  message: msg,
                  available: modelClient.listModels(),
                }),
              );
              return;
            }
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'model_error', message: msg }));
          }
          return;
        }

        // ── POST /internal/v1/tasks/mirror ──
        // S7: Receive task state snapshots from TriLC nodes.
        // CPO Q6c + CTO §7.2 S7.
        if (req.url === '/internal/v1/tasks/mirror' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const raw = Buffer.concat(chunks).toString('utf-8');

          // ① 校验 body
          let body: { nodeId?: string; tasks?: unknown[] };
          try {
            body = JSON.parse(raw);
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'invalid_json', message: 'Request body must be valid JSON' }));
            return;
          }

          if (!body.nodeId || typeof body.nodeId !== 'string') {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'bad_request', message: 'nodeId is required' }));
            return;
          }

          if (!Array.isArray(body.tasks) || body.tasks.length === 0) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'bad_request', message: 'tasks must be a non-empty array' }));
            return;
          }

          // ② 校验每个 task
          for (let i = 0; i < body.tasks.length; i++) {
            const t = body.tasks[i] as Record<string, unknown>;
            if (!t.taskId || typeof t.taskId !== 'string') {
              res.writeHead(400, { 'content-type': 'application/json' });
              res.end(JSON.stringify({
                ok: false,
                error: 'bad_request',
                message: `tasks[${i}]: taskId is required`,
              }));
              return;
            }
          }

          // ③ mirror
          const mirrored = mirrorStore.mirror(
            body.nodeId,
            body.tasks as Array<{
              taskId: string;
              title: string;
              status: MirrorTaskStatus;
              summary: string;
              updatedAt: string;
            }>,
          );

          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, mirrored }));
          return;
        }

        // ── LG-036 跨面席位通知通道（方案 acaae9fc §一；CEO 批方案 A）──
        // POST /internal/v1/notify          源席入队（X-Internal-Token 门内+
        //                                   白名单 m-duty-cos+正名制+4KB+限速）
        // GET  /internal/v1/notify/outbox   TriMLC 收端拉取（replay；TTL 标记）
        // POST /internal/v1/notify/confirm  收端状态确认（forwarded/delivered）
        // GET  /internal/v1/notify/status   源席查询三态（屏扫痛点根治）
        if (req.url?.startsWith('/internal/v1/notify')) {
          const { handleNotifyRoutes } = await import('../notify/routes.js');
          const handled = await handleNotifyRoutes(req, res, req.url ?? '/');
          if (handled) return;
        }

        // ── GET /internal/v1/tasks ──
        // S7: Query unified task state across all TriLC nodes.
        if (req.url?.startsWith('/internal/v1/tasks') && req.method === 'GET') {
          const urlObj = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
          const nodeId = urlObj.searchParams.get('nodeId') ?? undefined;
          const status = urlObj.searchParams.get('status') as MirrorTaskStatus | undefined;
          const limit = parseInt(urlObj.searchParams.get('limit') ?? '50', 10);
          const offset = parseInt(urlObj.searchParams.get('offset') ?? '0', 10);

          const result = mirrorStore.query({ nodeId, status, limit, offset });

          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
          return;
        }

        // ── 2.1/2.2: POST /internal/v1/tasks/result ──
        // TriLC callback: task completed or failed, update TaskController.
        if (req.url === '/internal/v1/tasks/result' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk);
          let body: { taskId?: string; sessionId?: string; status?: string; result?: string; error?: string };
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'invalid_json' }));
            return;
          }

          // Match by taskId (from dispatch) or sessionId (TriLC internal)
          const lookupId = body.taskId ?? body.sessionId;
          if (!lookupId) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'taskId or sessionId required' }));
            return;
          }

          if (body.status === 'success') {
            taskController.completeTask(lookupId, body.result ?? '');
            console.log(`[trimc:task] result received: task=${lookupId} status=success`);
          } else {
            taskController.failTask(lookupId, body.error ?? 'task_error');
            console.log(`[trimc:task] result received: task=${lookupId} status=failed error=${body.error ?? 'unknown'}`);
          }

          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, taskId: lookupId }));
          return;
        }

        if (req.url === '/internal/v1/tasks' && req.method === 'POST') {
          res.writeHead(202, { 'content-type': 'application/json' });
          res.end(JSON.stringify(taskController.acceptPlaceholder()));
          return;
        }

        if (req.url === '/internal/v1/chat' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const body = Buffer.concat(chunks).toString('utf-8');
          const result = await handleChat({ body });
          const statusCode = 'error' in result ? (result.error === 'invalid_json' ? 400 : 422) : 200;
          res.writeHead(statusCode, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
          return;
        }

        if (req.url?.startsWith('/internal/v1/agent') && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const raw = Buffer.concat(chunks).toString('utf-8');
          let parsed: {
            model?: string;
            systemPrompt?: string;
            messages?: Message[];
            maxTurns?: number;
            contract?: AgentContract;
            tier?: AgentTier;
            cwd?: string;
          };
          try {
            parsed = JSON.parse(raw);
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_json' }));
            return;
          }

          // ── Pipeline Assembly (when contract is present) ──
          let loopOptions: Parameters<typeof agentLoop>[0];
          const hasContract = !!parsed.contract;

          if (hasContract) {
            try {
              const assembly = await assemblePipelineOptions({
                contract: parsed.contract!,
                tier: parsed.tier ?? 'main',
                cwd: parsed.cwd ?? env.cwd,
                maxTurns: parsed.maxTurns ?? 25,
                model: parsed.model ?? (await resolveDefaultModel()),
                memdirPath: env.memdirPath,
                systemPromptOverride: parsed.systemPrompt,
              });
              loopOptions = {
                ...assembly.options,
                messages: parsed.messages ?? [],
              };
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              res.writeHead(500, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: 'pipeline_assembly_error', message: msg }));
              return;
            }
          } else {
            // ── Legacy raw mode (backward compatible) ──
            loopOptions = {
              model: parsed.model ?? (await resolveDefaultModel()),
              systemPrompt: parsed.systemPrompt ?? '',
              messages: parsed.messages ?? [],
              maxTurns: parsed.maxTurns ?? 25,
            };
          }

          // ── SSE vs JSON mode detection ──
          const urlObj = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
          const wantsSSE =
            urlObj.searchParams.get('stream') === 'true' ||
            req.headers.accept?.includes('text/event-stream');

          if (wantsSSE) {
            // ── SSE streaming mode ──
            res.writeHead(200, {
              'content-type': 'text/event-stream',
              'cache-control': 'no-cache',
              'connection': 'keep-alive',
              'x-accel-buffering': 'no',
            });

            const writeSSE = (eventType: string, data: object) => {
              res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
            };

            try {
              for await (const event of agentLoop(loopOptions)) {
                writeSSE(event.type, event);
              }
              res.write('data: [DONE]\n\n');
              res.end();
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              writeSSE('error', { type: 'error', message: msg });
              res.write('data: [DONE]\n\n');
              res.end();
            }
            return;
          }

          // ── JSON mode ──
          const events: AgentEvent[] = [];
          try {
            for await (const event of agentLoop(loopOptions)) {
              events.push(event);
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, turns: events.filter((e) => e.type === 'loop_end').length > 0 ? 'completed' : 'no_turns', events }));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'agent_error', message: msg, events }));
          }
          return;
        }

        // ── POST /internal/v1/heartbeat ──
        // Enhanced heartbeat from TriLC nodes. CTO-008-M §3.5.
        if (req.url === '/internal/v1/heartbeat' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const raw = Buffer.concat(chunks).toString('utf-8');
          let hb: {
            nodeId?: string;
            state?: string;
            queueSize?: number;
            uptimeSeconds?: number;
            agentCoreVersion?: string;
          };
          try {
            hb = JSON.parse(raw);
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_json' }));
            return;
          }
          // 心跳登记（heartbeat-dualrun-contract v1.0 §3.3）：
          // 合法心跳 → 节点心跳表登记（2 次回归 known 由 recordNodeHeartbeat 处理）
          if (hb.nodeId) {
            mirrorStore.recordNodeHeartbeat(hb.nodeId, hb.state ?? 'unknown-state');
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: true,
              serverTime: Date.now(),
              nodeId: hb.nodeId ?? 'unknown',
              commands: [] as string[],
            }),
          );
          return;
        }

        // ── /internal/v1/cron/* ──
        // cron 路由（r1-2）：add/list/update/remove/run/log/status，委托 src/cron/routes.ts
        if (
          handleCronRoutes &&
          req.url?.startsWith('/internal/v1/cron') &&
          (await handleCronRoutes(req, res))
        ) {
          return;
        }

        // ── GET /internal/v1/config/sync/status ──
        // i4-2 §三.3：五维同步接收侧状态（只读）。数据源 = TRIMC_CONFIG_DIR/
        // init-sync/ 磁盘真源 + fleet 工作树 HEAD（git 只读）；pending = fleet
        // bundle 与 applied 版本差（同步未达呈现代理）——协同确认 §七 的
        // 服务器侧事实源。消费面读取时解析（D3），无跨进程 IPC。
        if (req.url === '/internal/v1/config/sync/status' && req.method === 'GET') {
          try {
            const payload = await readConfigSyncStatus();
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(payload));
          } catch (err) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'config_sync_status_unavailable', message: (err as Error).message }));
          }
          return;
        }

        // ── POST /internal/v1/events/replay ──
        // Offline event replay from TriLC nodes. CTO-008-M §3.3.2.
        // M.5: Conflict arbitration integrated — arbitrate() detects double-assignment etc.
        if (req.url === '/internal/v1/events/replay' && req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk);
          }
          const raw = Buffer.concat(chunks).toString('utf-8');
          let body: { nodeId?: string; connectionId?: string; events?: Array<{ eventId?: string; type?: string; timestamp?: number; seqNo?: number; payload?: unknown }> };
          try {
            body = JSON.parse(raw);
          } catch {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_json' }));
            return;
          }
          if (!body.nodeId || !Array.isArray(body.events)) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'missing_nodeId_or_events' }));
            return;
          }
          const result = arbitrate(body.nodeId, body.events as Array<{ eventId: string; type: string; timestamp: number; seqNo: number; payload: unknown }>);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              ok: true,
              accepted: result.accepted,
              conflicts: result.conflicts,
              lastSeqNo: result.lastSeqNo,
            }),
          );
          return;
        }

        if (req.url === '/hello-pro' && req.method === 'GET') {
          try {
            // 模型名三级解析 default 变体（§四）：env > applied > 兜底常量
            const response = await modelClient.chat(await resolveDefaultModel(), [
              {
                role: 'system',
                content:
                  'You are TriMetaverse AI Pro. Think step by step, then give a short answer in 1-2 sentences.',
              },
              { role: 'user', content: 'Explain TriMetaverse in one sentence.' },
            ]);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                ok: true,
                model: response.model,
                content: response.content,
                reasoning: response.reasoning_content,
                usage: response.usage,
              }),
            );
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'model_error', message: msg }));
          }
          return;
        }

        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
      });

      await new Promise<void>((resolve, reject) => {
        server!.on('error', reject);
        server!.listen(env.port, () => resolve());
      });

      // Read the actual port (in case port 0 was used for OS-assigned port)
      const addr = server!.address();
      if (addr && typeof addr === 'object') {
        env.port = addr.port;
      }

      console.log(`[trimc] listening on :${env.port}`);

      // Cron scheduler：server listen 后装配（stale-run 恢复 + 调度循环）
      await cronService?.start();

      // 心跳超时扫描：10s 周期（与 heartbeatIntervalMs 对齐）
      heartbeatScanTimer = setInterval(() => {
        mirrorStore.scanStaleNodes();
      }, 10_000);
      heartbeatScanTimer.unref?.();
    },
    get port(): number {
      return env.port;
    },
    async stop(): Promise<void> {
      cronService?.stop();
      if (heartbeatScanTimer) {
        clearInterval(heartbeatScanTimer);
        heartbeatScanTimer = null;
      }
      if (server) {
        await new Promise<void>((resolve, reject) => {
          server!.close((err) => (err ? reject(err) : resolve()));
        });
        server = null;
      }
    },
  };
}