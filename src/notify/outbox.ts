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

/** 目标席名册（LG-036 MVP=bod；FADE-010 +coo；LG-052 阶段一扩面=13 员工席
 *  opsName 正名制（seats.json 口径，board 不人格席不入册），daemon 全 trimlc。
 *  治理短名 bod/coo 保留=既有双投行为零变化）。 */
export const TARGET_SEAT_ROSTER: Record<string, { daemon: string }> = {
  bod: { daemon: 'trimlc' },
  coo: { daemon: 'trimlc' },  // FADE-010 首落③：coo 副投（候批信 bod+coo 双投固定路由）
  // ── LG-052 阶段一扩面：13 员工席（seats.json opsName 正名制）──
  'm-cos': { daemon: 'trimlc' },
  'm-cao': { daemon: 'trimlc' },
  'm-cfo': { daemon: 'trimlc' },
  'm-cho': { daemon: 'trimlc' },
  'm-cmo': { daemon: 'trimlc' },
  'm-coo': { daemon: 'trimlc' },
  'm-cpo': { daemon: 'trimlc' },
  'm-cto': { daemon: 'trimlc' },
  'm-cso': { daemon: 'trimlc' },
  'm-fsd': { daemon: 'trimlc' },
  'm-rdt': { daemon: 'trimlc' },
  'm-dee': { daemon: 'trimlc' },
  'm-ste': { daemon: 'trimlc' },
  // LG-052 阶段二：sg 值席收端（跨面定向；daemon=trimmc 即本仓 sg daemon——
  // 值席消费面 duty-consumer 同进程拉取；本地 TriMLC puller 名册外自动跳过不抢）
  'm-duty-cos': { daemon: 'trimmc' },
};
/** 源席白名单（LG-036 MVP=m-duty-cos；LG-052 扩治理链三席 bod/m-cos/m-coo——
 *  本单只扩通道能力，内容面治理口径不在本单）。 */
export const SOURCE_SEAT_WHITELIST = ['m-duty-cos', 'bod', 'm-cos', 'm-coo'];

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

// ── LG-052 阶段一：一稿多投广播（展开制——不采 target_seat="all" 单件制，
// 三态逐席追踪不失真，任务书二.2）──

export interface NotifyBroadcastInput {
  source_seat: string;
  target_daemon: string;
  /** 目标席数组（正名制逐席校验；重复席整单 400 拒）。 */
  targets: string[];
  urgent: 'urgent' | 'normal';
  title: string;
  body: string;
  /** 广播基 id（逐席确定性派生 `${base}--${seat}`；缺省按时刻自动基）。 */
  message_id?: string;
}

export interface NotifyBroadcastPieceOutcome {
  target_seat: string;
  ok: true;
  message_id: string;
  duplicate: boolean;
}

export type NotifyBroadcastOutcome =
  | { ok: true; results: NotifyBroadcastPieceOutcome[]; accepted: number; duplicates: number }
  | { ok: false; statusCode: 400 | 403 | 413 | 429 | 503; error: string; message: string };

/**
 * 一稿多投广播（LG-052 阶段一）：展开为 N 件独立消息——逐席派生 message_id
 * 保三态逐席追踪+幂等（任务书二.2 原条款不动）。整单原子：任一前置门不过=
 * 零落箱（无半投）。
 *
 * 约束保持：4KB 逐件（同稿一次校验）/TTL 逐件/pending 上限含展开件数
 * （空间不足整单 503）；限速计源操作数不计展开件数（BOD 预裁 2026-09-24：
 * 计数器仅对源操作记 1，约束值零变）。
 */
export function enqueueNotifyBroadcast(
  input: NotifyBroadcastInput,
  pathOverride?: string,
  now: Date = new Date(),
): NotifyBroadcastOutcome {
  // 源席白名单（与单投同门）
  if (!SOURCE_SEAT_WHITELIST.includes(input.source_seat)) {
    return { ok: false, statusCode: 403, error: 'forbidden_source_seat', message: `源席 '${input.source_seat}' 不在白名单（${SOURCE_SEAT_WHITELIST.join('、')}）` };
  }
  // 4KB 逐件（同稿同体，一次校验）
  const bodyBytes = Buffer.byteLength(input.body, 'utf-8');
  if (bodyBytes > NOTIFY_BODY_MAX_BYTES) {
    return { ok: false, statusCode: 413, error: 'body_too_large', message: `通知正文超限（${bodyBytes} 字节 > 上限 ${NOTIFY_BODY_MAX_BYTES}）` };
  }
  // targets 形校验
  const targets = input.targets.map((t) => String(t).trim()).filter((t) => t.length > 0);
  if (targets.length === 0) {
    return { ok: false, statusCode: 400, error: 'empty_targets', message: 'targets 不能为空' };
  }
  const dupTargets = targets.filter((t, i) => targets.indexOf(t) !== i);
  if (dupTargets.length > 0) {
    return { ok: false, statusCode: 400, error: 'duplicate_targets', message: `targets 含重复席：${[...new Set(dupTargets)].join('、')}` };
  }
  // 正名制逐席（名册+daemon 匹配）
  const unknown = targets.filter((t) => !TARGET_SEAT_ROSTER[t]);
  if (unknown.length > 0) {
    return { ok: false, statusCode: 400, error: 'unknown_target_seat', message: `目标席未在名册：${unknown.join('、')}（名册：${Object.keys(TARGET_SEAT_ROSTER).join('、')}）` };
  }
  const mismatched = targets.filter((t) => TARGET_SEAT_ROSTER[t].daemon !== input.target_daemon);
  if (mismatched.length > 0) {
    return { ok: false, statusCode: 400, error: 'daemon_seat_mismatch', message: `target_daemon 与名册不符：${mismatched.join('、')}` };
  }

  const path = pathOverride ?? notifyOutboxPath();
  const doc = readDoc(path);

  // pending 上限：空间按展开件数原子预留（不足整单拒=无半投）
  const pendingCount = doc.messages.filter((m) => m.status === 'pending' && !m.expired).length;
  if (pendingCount + targets.length > OUTBOX_MAX_PENDING) {
    return { ok: false, statusCode: 503, error: 'outbox_full', message: `通知箱空间不足（pending ${pendingCount}+广播 ${targets.length} > 上限 ${OUTBOX_MAX_PENDING}），待收端拉取后重试` };
  }

  // 限速：计源操作数（本广播=1 操作；BOD 预裁 2026-09-24）
  const windowStart = now.getTime() - 60_000;
  const recent = doc.messages.filter(
    (m) => m.source_seat === input.source_seat && new Date(m.enqueued_at).getTime() >= windowStart,
  ).length;
  if (recent >= RATE_LIMIT_PER_MINUTE) {
    return { ok: false, statusCode: 429, error: 'rate_limited', message: `触发限速（每源席每分钟 ${RATE_LIMIT_PER_MINUTE} 操作），请稍后重试` };
  }

  // 基 id：缺省自动；逐席派生确定性（幂等重播=同基同席=同 id 命中既有件）
  const baseId = input.message_id ?? `ntf-${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  const results: NotifyBroadcastPieceOutcome[] = [];
  let accepted = 0;
  let duplicates = 0;
  for (const seat of targets) {
    const messageId = `${baseId}--${seat}`;
    const existing = doc.messages.find((m) => m.message_id === messageId);
    if (existing) {
      results.push({ target_seat: seat, ok: true, message_id: messageId, duplicate: true });
      duplicates += 1;
      continue;
    }
    const message: NotifyMessage = {
      message_id: messageId,
      source_seat: input.source_seat,
      target_daemon: input.target_daemon,
      target_seat: seat,
      urgent: input.urgent,
      title: input.title,
      body: input.body,
      enqueued_at: now.toISOString(),
      status: 'pending',
      status_history: [{ status: 'accepted', at: now.toISOString() }],
      attempts: 0,
    };
    doc.messages.push(message);
    results.push({ target_seat: seat, ok: true, message_id: messageId, duplicate: false });
    accepted += 1;
  }
  if (accepted > 0) {
    writeDocAtomic(path, doc);
    // 台账逐件 accepted（SEC 白名单：元数据+title，零 body；broadcast_base 溯源）
    for (const r of results) {
      if (!r.duplicate) {
        appendLedger(ledgerPathFor(path), { at: now.toISOString(), event: 'accepted', message_id: r.message_id, source_seat: input.source_seat, target_seat: r.target_seat, urgent: input.urgent, title: input.title, broadcast_base: baseId });
      }
    }
  }
  return { ok: true, results, accepted, duplicates };
}

/** LG-052 阶段二：值席定向拉取（只取 seats 名册内件；attempts 仅对返回件+1——
 *  与全量 pullPending 隔离，防本地 TriMLC puller 与值席消费面互抢计数；
 *  TTL 语义照全量（过阈标 expired 不静默删，仅扫本名册件，他件归各自收端）。 */
export function pullPendingForSeats(
  seats: string[],
  pathOverride?: string,
  now: Date = new Date(),
): NotifyMessage[] {
  const path = pathOverride ?? notifyOutboxPath();
  const doc = readDoc(path);
  const set = new Set(seats);
  const pending = doc.messages.filter(
    (m) => m.status === 'pending' && !m.expired && set.has(m.target_seat),
  );
  for (const m of pending) m.attempts += 1;
  const cutoff = now.getTime() - OUTBOX_TTL_MS;
  for (const m of doc.messages) {
    if (m.status === 'pending' && !m.expired && set.has(m.target_seat) && new Date(m.enqueued_at).getTime() < cutoff) {
      m.expired = true;
      m.status_history.push({ status: 'expired', at: now.toISOString() });
      appendLedger(ledgerPathFor(path), { at: now.toISOString(), event: 'expired', message_id: m.message_id });
    }
  }
  writeDocAtomic(path, doc);
  return pending;
}

/** 收端拉取（replay）：pending 件按时间序（attempts+1）；TTL 标记不静默删。 */
export function pullPending(pathOverride?: string, now: Date = new Date()): NotifyMessage[] {  const path = pathOverride ?? notifyOutboxPath();
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
