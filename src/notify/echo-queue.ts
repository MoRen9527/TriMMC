// ── TriMMC Echo Outbound Queue（Q2 反向通道一期件①；派工单 046caf7cb·CEO 18:16 批）──
//
// M-service→M-local 回声出向队列：服务域席写入（含证据三元组）→本机 mc-echo-pull
// 拉取器按节律取走→消账确认。存储=JSON 原子落盘（notify outbox 同族）；台账=
// echo-queue-ledger.jsonl 事件型（enqueue_accepted/rejected/expired/acked——
// 技术卷 §二.3「ledger reject 事件型·零新机制」）。
// 红线落点（技术卷 §二/§三）：
//   红线①：text≤8KB 字节面+字段白名单（三元组+text+指针字段）·无 file/binary
//           传输字段（字段白名单在 routes 层拒，本层防 schema 演化再校验）
//   红线②：target_endpoint ∈ TRIMC_ECHO_TARGETS 白名单（env 结构化·一期单值=
//           M-local 信箱端点）——白名单外=入队即拒+ledger reject 留痕
//   红线③：本队列与 cron/job 调度 API 零共享面（独立存储独立路由——设计注记；
//           收推≠执行的结构性保证在 TriMLC 落箱侧 advisory 标成立）
//   红线④：证据三元组 {source_id, ts_machine, ref} 必填——缺/残入队即拒（第一闸；
//           落箱侧二次校验标疑=第二闸，防 schema 演化破约）
// 时戳纪律：ts_machine=服务域机写 UTC Z（D-47 同源）；Date.parse 可解析校验。
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface EchoQueueItem {
  message_id: string;
  /** 目标端点标识（TRIMC_ECHO_TARGETS 白名单校验；一期单值=m-local-mailbox）。 */
  target_endpoint: string;
  source_id: string;
  ts_machine: string;
  ref: string;
  text: string;
  title?: string;
  enqueued_at: string;
  status: 'pending' | 'acked';
  acked_at?: string;
  acked_by?: string;
  attempts: number;
  expired?: boolean;
}

export interface EchoQueueDoc {
  items: EchoQueueItem[];
}

/** 8KB（技术卷红线①；Buffer.byteLength 字节面）。 */
export const ECHO_TEXT_MAX_BYTES = 8 * 1024;
/** pending 上限（outbox OUTBOX_MAX_PENDING 同值 200）。 */
export const ECHO_QUEUE_MAX_PENDING = 200;
/** TTL 默认 24h（outbox 同族；超阈标 expired 不静默删）。 */
export const ECHO_TTL_MS = 24 * 3600_000;
/** 消费方白名单（红线②最小集写死·一期单值——技术卷 §二.2 拉取器身份）。 */
export const ECHO_CONSUMER_WHITELIST: ReadonlySet<string> = new Set(['mc-echo-pull']);

export const ECHO_QUEUE_FILE_ENV = 'TRIMC_ECHO_QUEUE_FILE';

/** 目标端点白名单（env 结构化·逗号分隔；缺省单值=M-local 信箱端点——技术卷
 *  §二.1「一期单值」；TRIMC_ECHO_TARGETS 空值=回落缺省，非空=env 全量替）。 */
export function echoTargets(): string[] {
  const raw = process.env.TRIMC_ECHO_TARGETS?.trim();
  if (!raw) return ['m-local-mailbox'];
  return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

export function echoQueuePath(): string {
  const env = process.env[ECHO_QUEUE_FILE_ENV]?.trim();
  if (env) return resolve(env);
  return resolve(process.cwd(), 'echo-queue.json');
}

function ledgerPathFor(queuePath: string): string {
  return queuePath.replace(/\.json$/, '') + '-ledger.jsonl';
}

function readDoc(path: string): EchoQueueDoc {
  if (!existsSync(path)) return { items: [] };
  try {
    const doc = JSON.parse(readFileSync(path, 'utf-8')) as EchoQueueDoc;
    if (!doc || !Array.isArray(doc.items)) return { items: [] };
    return doc;
  } catch {
    return { items: [] }; // 坏文件 fail-safe 空箱（队列缓存面，消费方幂等重拉兜底）
  }
}

function writeDocAtomic(path: string, doc: EchoQueueDoc): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf-8');
  renameSync(tmp, path);
}

/** 台账事件型追加（元数据+title，零 text 正文——outbox ledger SEC 同约束）。 */
function appendLedger(path: string, record: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf-8');
  } catch {
    /* 台账写失败不阻断主流程 */
  }
}

export interface EchoEnqueueInput {
  target_endpoint: string;
  source_id: string;
  ts_machine: string;
  ref: string;
  text: string;
  title?: string;
  message_id?: string;
}

export type EchoEnqueueOutcome =
  | { ok: true; item: EchoQueueItem; duplicate: boolean }
  | { ok: false; statusCode: 400 | 403 | 413 | 503; error: string; message: string };

/** 入队（目标端点白名单→三元组→时戳→8KB→上限→幂等；顺序=先校验后幂等，
 *  白名单外/缺三元组=入队即拒+ledger reject 留痕——验收锚 2/3 判法数据源）。 */
export function enqueueEchoItem(
  input: EchoEnqueueInput,
  pathOverride?: string,
  now: Date = new Date(),
): EchoEnqueueOutcome {
  const reject = (statusCode: 400 | 403 | 413, error: string, message: string): EchoEnqueueOutcome => {
    appendLedger(ledgerPathFor(pathOverride ?? echoQueuePath()), {
      at: now.toISOString(), event: 'rejected', error,
      target_endpoint: input.target_endpoint || '(缺)',
      source_id: input.source_id || '(缺)',
      ref: input.ref || '(缺)',
      title: input.title || '',
    });
    return { ok: false, statusCode, error, message };
  };

  // 红线②：目标端点白名单（env 结构化·一期单值）
  if (!echoTargets().includes(input.target_endpoint)) {
    return reject(403, 'target_not_allowed', `目标端点 '${input.target_endpoint}' 不在 TRIMC_ECHO_TARGETS 白名单（${echoTargets().join('、')}）`);
  }
  // 红线④：证据三元组缺/残入队即拒（第一闸）
  const missing = (['source_id', 'ts_machine', 'ref'] as const).filter((k) => !input[k] || !String(input[k]).trim());
  if (missing.length > 0) {
    return reject(400, 'missing_tuple', `证据三元组缺/残：${missing.join('、')}（入队即拒·技术卷红线④）`);
  }
  // 时戳纪律：ts_machine 机写 UTC Z——可解析校验
  if (!Number.isFinite(Date.parse(input.ts_machine))) {
    return reject(400, 'invalid_ts_machine', `ts_machine 非法（须 UTC Z 可解析：'${input.ts_machine.slice(0, 40)}'）`);
  }
  // 红线①：text≤8KB 字节面
  const textBytes = Buffer.byteLength(input.text, 'utf-8');
  if (textBytes > ECHO_TEXT_MAX_BYTES) {
    return reject(413, 'text_over_8kb', `text 超限（${textBytes} 字节 > 上限 ${ECHO_TEXT_MAX_BYTES}）——红线①只推消息不推文件`);
  }

  const path = pathOverride ?? echoQueuePath();
  const doc = readDoc(path);

  // pending 上限（收端 ack 后腾位）
  const pendingCount = doc.items.filter((m) => m.status === 'pending' && !m.expired).length;
  if (pendingCount >= ECHO_QUEUE_MAX_PENDING) {
    return { ok: false, statusCode: 503, error: 'queue_full', message: `回声队列已满（pending ${pendingCount} ≥ 上限 ${ECHO_QUEUE_MAX_PENDING}），待拉取方消账后重试` };
  }

  // 幂等：message_id 去重（同 id 已在=返回既有件 duplicate 标记）
  if (input.message_id) {
    const existing = doc.items.find((m) => m.message_id === input.message_id);
    if (existing) return { ok: true, item: existing, duplicate: true };
  }

  const item: EchoQueueItem = {
    message_id: input.message_id ?? `echo-${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    target_endpoint: input.target_endpoint,
    source_id: input.source_id,
    ts_machine: input.ts_machine,
    ref: input.ref,
    text: input.text,
    ...(input.title ? { title: input.title } : {}),
    enqueued_at: now.toISOString(),
    status: 'pending',
    attempts: 0,
  };
  doc.items.push(item);
  writeDocAtomic(path, doc);
  appendLedger(ledgerPathFor(path), { at: item.enqueued_at, event: 'enqueue_accepted', message_id: item.message_id, target_endpoint: item.target_endpoint, source_id: item.source_id, ref: item.ref, title: item.title ?? '' });
  return { ok: true, item, duplicate: false };
}

/** 契约投影形（件② echo-pull.mjs 锚死：items 元素只含六键，零内部状态暴露）。 */
function projectItem(m: EchoQueueItem): { message_id: string; source_id: string; ts_machine: string; ref: string; text: string; title?: string } {
  return {
    message_id: m.message_id,
    source_id: m.source_id,
    ts_machine: m.ts_machine,
    ref: m.ref,
    text: m.text,
    ...(m.title ? { title: m.title } : {}),
  };
}

export type EchoPullOutcome =
  | { ok: true; items: Array<ReturnType<typeof projectItem>> }
  | { ok: false; statusCode: 403; error: string; message: string };

/** 拉取（按消费方取：pending 未过期按 enqueued_at 升序·attempts 逐件+1·TTL 扫描
 *  标 expired+ledger；consumer 白名单外=403+ledger reject 留痕）。 */
export function pullEchoQueue(
  consumer: string,
  pathOverride?: string,
  now: Date = new Date(),
): EchoPullOutcome {
  if (!ECHO_CONSUMER_WHITELIST.has(consumer)) {
    appendLedger(ledgerPathFor(pathOverride ?? echoQueuePath()), { at: now.toISOString(), event: 'rejected', error: 'consumer_not_allowed', consumer });
    return { ok: false, statusCode: 403, error: 'consumer_not_allowed', message: `消费方 '${consumer}' 不在白名单（${[...ECHO_CONSUMER_WHITELIST].join('、')}）` };
  }
  const path = pathOverride ?? echoQueuePath();
  const doc = readDoc(path);
  const cutoff = now.getTime() - ECHO_TTL_MS;
  for (const m of doc.items) {
    if (m.status === 'pending' && !m.expired && new Date(m.enqueued_at).getTime() < cutoff) {
      m.expired = true;
      appendLedger(ledgerPathFor(path), { at: now.toISOString(), event: 'expired', message_id: m.message_id });
    }
  }
  const pending = doc.items
    .filter((m) => m.status === 'pending' && !m.expired)
    .sort((a, b) => a.enqueued_at.localeCompare(b.enqueued_at));
  for (const m of pending) m.attempts += 1;
  writeDocAtomic(path, doc);
  return { ok: true, items: pending.map(projectItem) };
}

export type EchoAckOutcome =
  | { ok: true; duplicate: boolean }
  | { ok: false; reason: 'not_found' | 'consumer_not_allowed' };

/** 消账确认（幂等：已 acked=200 duplicate；未知 id=404 not_found——件②拉取器
 *  对 ack 失败只重拉不重投，落箱侧幂等兜底）。 */
export function ackEchoItem(
  messageId: string,
  consumer: string,
  pathOverride?: string,
  now: Date = new Date(),
): EchoAckOutcome {
  if (!ECHO_CONSUMER_WHITELIST.has(consumer)) {
    appendLedger(ledgerPathFor(pathOverride ?? echoQueuePath()), { at: now.toISOString(), event: 'rejected', error: 'consumer_not_allowed', consumer });
    return { ok: false, reason: 'consumer_not_allowed' };
  }
  const path = pathOverride ?? echoQueuePath();
  const doc = readDoc(path);
  const m = doc.items.find((x) => x.message_id === messageId);
  if (!m) return { ok: false, reason: 'not_found' };
  if (m.status === 'acked') return { ok: true, duplicate: true };
  m.status = 'acked';
  m.acked_at = now.toISOString();
  m.acked_by = consumer;
  writeDocAtomic(path, doc);
  appendLedger(ledgerPathFor(path), { at: m.acked_at, event: 'acked', message_id: m.message_id, consumer });
  return { ok: true, duplicate: false };
}
