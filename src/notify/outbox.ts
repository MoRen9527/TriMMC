// ── TriMMC Notify Outbox（LG-036 跨面席位通知通道 MVP，方案 acaae9fc §一）──
//
// sg→TriMLC 单向候裁决类的发端 outbox：入队/幂等（message_id 去重）/TTL/上限/
// 限速/replay 语义对齐 CTO-008-M event-queue；存储=JSON 原子落盘（tmp+rename，
// trimc 仓 mirror-store 同族）。送达三态（CPO）：accepted（入队 200 响应可见）
// →forwarded（TriMLC 拉走）→delivered（letter-store 确认回写）。
// 全量台账=notify-ledger.jsonl 追加（SEC 白名单：元数据+title，零 body 正文）。
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface NotifyMessage {
  message_id: string;
  source_seat: string;
  target_daemon: string;
  target_seat: string;
  urgent: 'urgent' | 'normal';
  title: string;
  body: string;
  enqueued_at: string;
  status: 'pending' | 'forwarded' | 'delivered';
  status_history: Array<{ status: string; at: string }>;
  attempts: number;
  expired?: boolean;
}

export interface OutboxDoc {
  messages: NotifyMessage[];
}

/** 4KB 上限（BOD 令三硬约束；body 序列化字节数）。 */
export const NOTIFY_BODY_MAX_BYTES = 4096;
/** pending 上限（CTO-008-M maxQueueSize 语义，MVP 缩量）。 */
export const OUTBOX_MAX_PENDING = 200;
/** TTL 默认 24h（超阈标记 expired+台账；升级归 COO 告警面，本面绝不静默删）。 */
export const OUTBOX_TTL_MS = 24 * 3600_000;
/** 限速：每源席每分钟滑窗。 */
export const RATE_LIMIT_PER_MINUTE = 10;

/** 目标席名册（MVP=bod 单条；P2 扩面照此册）。 */
export const TARGET_SEAT_ROSTER: Record<string, { daemon: string }> = {
  bod: { daemon: 'trimlc' },
  coo: { daemon: 'trimlc' },  // FADE-010 首落③：coo 副投（候批信 bod+coo 双投固定路由）
};
/** 源席白名单（MVP=m-duty-cos 单条）。 */
export const SOURCE_SEAT_WHITELIST = ['m-duty-cos'];

export const NOTIFY_FILE_ENV = 'TRIMC_NOTIFY_FILE';

export function notifyOutboxPath(): string {
  const env = process.env[NOTIFY_FILE_ENV]?.trim();
  if (env) return resolve(env);
  return resolve(process.cwd(), 'notify-outbox.json');
}

function ledgerPathFor(outboxPath: string): string {
  return outboxPath.replace(/\.json$/, '') + '-ledger.jsonl';
}

function readDoc(path: string): OutboxDoc {
  if (!existsSync(path)) return { messages: [] };
  try {
    const doc = JSON.parse(readFileSync(path, 'utf-8')) as OutboxDoc;
    if (!doc || !Array.isArray(doc.messages)) return { messages: [] };
    return doc;
  } catch {
    return { messages: [] }; // 坏文件 fail-safe 空箱（发端缓存面）
  }
}

function writeDocAtomic(path: string, doc: OutboxDoc): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf-8');
  renameSync(tmp, path);
}

function appendLedger(path: string, record: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf-8');
  } catch {
    /* 台账写失败不阻断主流程 */
  }
}

export interface NotifyEnqueueInput {
  source_seat: string;
  target_daemon: string;
  target_seat: string;
  urgent: 'urgent' | 'normal';
  title: string;
  body: string;
  message_id?: string;
}

export type NotifyEnqueueOutcome =
  | { ok: true; message: NotifyMessage; duplicate: boolean }
  | { ok: false; statusCode: 400 | 403 | 409 | 413 | 429 | 503; error: string; message?: string };

/** 入队（寻址正名制/白名单/4KB/幂等/上限/限速全门；顺序=先校验后限速后幂等）。 */
export function enqueueNotify(
  input: NotifyEnqueueInput,
  pathOverride?: string,
  now: Date = new Date(),
): NotifyEnqueueOutcome {
  // 源席白名单（MVP=m-duty-cos）
  if (!SOURCE_SEAT_WHITELIST.includes(input.source_seat)) {
    return { ok: false, statusCode: 403, error: 'forbidden_source_seat', message: `源席 '${input.source_seat}' 不在白名单（MVP：${SOURCE_SEAT_WHITELIST.join('、')}）` };
  }
  // 寻址正名制：未名人话拒绝
  const roster = TARGET_SEAT_ROSTER[input.target_seat];
  if (!roster) {
    return { ok: false, statusCode: 400, error: 'unknown_target_seat', message: `目标席 '${input.target_seat}' 未在名册（MVP 名册：${Object.keys(TARGET_SEAT_ROSTER).join('、')}）` };
  }
  if (roster.daemon !== input.target_daemon) {
    return { ok: false, statusCode: 400, error: 'daemon_seat_mismatch', message: `target_daemon '${input.target_daemon}' 与目标席名册不符（'${input.target_seat}' 应为 '${roster.daemon}'）` };
  }
  // 4KB 上限
  const bodyBytes = Buffer.byteLength(input.body, 'utf-8');
  if (bodyBytes > NOTIFY_BODY_MAX_BYTES) {
    return { ok: false, statusCode: 413, error: 'body_too_large', message: `通知正文超限（${bodyBytes} 字节 > 上限 ${NOTIFY_BODY_MAX_BYTES}）` };
  }

  const path = pathOverride ?? notifyOutboxPath();
  const doc = readDoc(path);

  // 上限：pending 满则拒（收端拉走/确认后腾位）
  const pendingCount = doc.messages.filter((m) => m.status === 'pending' && !m.expired).length;
  if (pendingCount >= OUTBOX_MAX_PENDING) {
    return { ok: false, statusCode: 503, error: 'outbox_full', message: `通知箱已满（pending ${pendingCount} ≥ 上限 ${OUTBOX_MAX_PENDING}），待收端拉取后重试` };
  }

  // 限速：每源席每分钟滑窗
  const windowStart = now.getTime() - 60_000;
  const recent = doc.messages.filter(
    (m) => m.source_seat === input.source_seat && new Date(m.enqueued_at).getTime() >= windowStart,
  ).length;
  if (recent >= RATE_LIMIT_PER_MINUTE) {
    return { ok: false, statusCode: 429, error: 'rate_limited', message: `触发限速（每源席每分钟 ${RATE_LIMIT_PER_MINUTE} 条），请稍后重试` };
  }

  // 幂等：message_id 去重（同 id 已在=返回既有件 duplicate 标记）
  if (input.message_id) {
    const existing = doc.messages.find((m) => m.message_id === input.message_id);
    if (existing) return { ok: true, message: existing, duplicate: true };
  }

  const message: NotifyMessage = {
    message_id: input.message_id ?? `ntf-${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    source_seat: input.source_seat,
    target_daemon: input.target_daemon,
    target_seat: input.target_seat,
    urgent: input.urgent,
    title: input.title,
    body: input.body,
    enqueued_at: now.toISOString(),
    status: 'pending',
    status_history: [{ status: 'accepted', at: now.toISOString() }],
    attempts: 0,
  };
  doc.messages.push(message);
  writeDocAtomic(path, doc);
  appendLedger(ledgerPathFor(path), { at: message.enqueued_at, event: 'accepted', message_id: message.message_id, source_seat: message.source_seat, target_seat: message.target_seat, urgent: message.urgent, title: message.title });
  return { ok: true, message, duplicate: false };
}

/** 收端拉取（replay）：pending 件按时间序（attempts+1）；TTL 标记不静默删。 */
export function pullPending(pathOverride?: string, now: Date = new Date()): NotifyMessage[] {
  const path = pathOverride ?? notifyOutboxPath();
  const doc = readDoc(path);
  const pending = doc.messages.filter((m) => m.status === 'pending' && !m.expired);
  for (const m of pending) m.attempts += 1;
  const cutoff = now.getTime() - OUTBOX_TTL_MS;
  for (const m of doc.messages) {
    if (m.status === 'pending' && !m.expired && new Date(m.enqueued_at).getTime() < cutoff) {
      m.expired = true;
      m.status_history.push({ status: 'expired', at: now.toISOString() });
      appendLedger(ledgerPathFor(path), { at: now.toISOString(), event: 'expired', message_id: m.message_id });
    }
  }
  writeDocAtomic(path, doc);
  return pending;
}

/** 状态迁移（forwarded=收端拉走确认 / delivered=letter-store 终态确认）。 */
export function transitionStatus(
  messageId: string,
  to: 'forwarded' | 'delivered',
  pathOverride?: string,
  now: Date = new Date(),
): { ok: boolean; reason?: string } {
  const path = pathOverride ?? notifyOutboxPath();
  const doc = readDoc(path);
  const m = doc.messages.find((x) => x.message_id === messageId);
  if (!m) return { ok: false, reason: 'not_found' };
  if (m.status === to) return { ok: true }; // 幂等重放
  const allowed: Record<string, string[]> = { forwarded: ['pending'], delivered: ['pending', 'forwarded'] };
  if (!allowed[to].includes(m.status)) return { ok: false, reason: `illegal_transition:${m.status}->${to}` };
  m.status = to;
  m.status_history.push({ status: to, at: now.toISOString() });
  writeDocAtomic(path, doc);
  appendLedger(ledgerPathFor(path), { at: now.toISOString(), event: to, message_id: messageId });
  return { ok: true };
}

/** 源席查询端点（屏扫痛点根治=发送方可见）：按 message_id 或全列。 */
export function queryStatus(messageId: string | null, pathOverride?: string): NotifyMessage[] {
  const path = pathOverride ?? notifyOutboxPath();
  const doc = readDoc(path);
  if (messageId) return doc.messages.filter((x) => x.message_id === messageId);
  return doc.messages;
}
