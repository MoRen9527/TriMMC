// ── TriMMC Duty Notify Consumer（LG-052 阶段二：sg 值席收端消费面）──
//
// 跨面链路「本机发→sg 值席收→confirm 三态回写」的 sg 侧收端：
//   本机 POST /internal/v1/notify（target_seat=m-duty-cos，target_daemon=trimmc）
//   → sg outbox 落箱 → 本消费者同进程定向拉取（pullPendingForSeats，零 HTTP 回环）
//   → 交付面：normal=值席信箱落箱即 delivered（信箱可见=送达，TriMLC puller 同
//   语义）；urgent=tmux display-message 弹显成功才 delivered——失败=滞留 forwarded
//   态（status 面可见未送达、不静默丢；与 TriMLC urgent 语义同构，自动重投=
//   replay 扩展候 P2）。
//
// 与本地 TriMLC puller 的共存：本地 puller 名册外（m-duty-cos ∉ seats.json）自动
// 跳过且不 confirm——值席件全权归本消费者；attempts 定向隔离（pullPendingForSeats）。
//
// env 门：TRIMC_NOTIFY_DUTY_SEATS 未设=不启动（零行为）；TRIMC_NOTIFY_DUTY_TMUX
//= 值席 tmux 会话名（urgent 弹显目标；未设时 urgent 件按信箱落箱语义交付）。
'use strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pullPendingForSeats, transitionStatus } from './outbox.js';

/** 值席信箱件（与 TriMLC letter-store NotifyLetter 同形——跨面信箱语义一致）。 */
interface DutyLetter {
  message_id: string;
  source_seat: string;
  target_seat: string;
  urgent: 'urgent' | 'normal';
  title: string;
  body: string;
  received_at: string;
  delivery: 'toast' | 'mailbox';
  delivered_at: string;
  read: boolean;
}

function readMailbox(path: string): { letters: DutyLetter[] } {
  if (!existsSync(path)) return { letters: [] };
  try {
    const doc = JSON.parse(readFileSync(path, 'utf-8')) as { letters?: DutyLetter[] };
    const letters = Array.isArray(doc?.letters) ? doc.letters : [];
    return { letters };
  } catch {
    return { letters: [] };
  }
}

function writeMailboxAtomic(path: string, doc: { letters: DutyLetter[] }): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf-8');
  renameSync(tmp, path);
}

/** 落箱（幂等=message_id 去重；返回是否新落）。 */
function storeDutyLetter(path: string, letter: Omit<DutyLetter, 'received_at' | 'delivered_at' | 'read'>, now: Date): boolean {
  const doc = readMailbox(path);
  if (doc.letters.some((l) => l.message_id === letter.message_id)) return false;
  doc.letters.push({
    ...letter,
    received_at: now.toISOString(),
    delivered_at: now.toISOString(),
    read: false,
  });
  writeMailboxAtomic(path, doc);
  return true;
}

/** tmux 弹显（非侵入横幅 display-message；成功=true——仅 urgent 面使用）。
 *  LG-052 销账挂账修：service=root 身份与值席 tmux server（fleet uid 1001）
 *  socket 错位——TRIMC_NOTIFY_DUTY_TMUX_SOCK 设定时经 `-S` 旗直达目标 socket
 *  （SDE 03:0x 取证修形验证）；未设=默认 socket（现行为，信箱语义兜底不回退）。 */
export async function showTmuxMessage(session: string, title: string, body: string): Promise<boolean> {
  return new Promise((resolveP) => {
    try {
      const text = `${title} | ${body.slice(0, 200)}`;
      const sock = process.env.TRIMC_NOTIFY_DUTY_TMUX_SOCK?.trim();
      const args = sock
        ? ['-S', sock, 'display-message', '-t', session, text]
        : ['display-message', '-t', session, text];
      const child = spawn('tmux', args, { stdio: 'ignore' });
      const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolveP(false); }, 10_000);
      child.on('close', (code) => { clearTimeout(timer); resolveP(code === 0); });
      child.on('error', () => { clearTimeout(timer); resolveP(false); });
    } catch {
      resolveP(false);
    }
  });
}

export interface DutyConsumerOptions {
  /** 值席名册（target_seat 集合，如 ['m-duty-cos']）。 */
  dutySeats: string[];
  /** 值席信箱路径（缺省 cwd/notify-mailbox.json——与 outbox 默认同目录族）。 */
  mailboxPath?: string;
  /** urgent 弹显 tmux 会话名（未设=urgent 件按信箱落箱语义交付）。 */
  tmuxSession?: string;
  intervalMs?: number;
  /** 注入缝（测试）：urgent 交付执行（默认 showTmuxMessage）。 */
  onUrgentDeliver?: (title: string, body: string) => Promise<boolean>;
}

export interface DutyConsumerHandle {
  stop: () => void;
  /** 手动触发一轮（测试/手动刷新）。 */
  tickOnce: () => Promise<{ pulled: number; delivered: number; failed: number }>;
}

/** 值席信箱路径解析（TRIMC_NOTIFY_MAILBOX 同族 env；缺省 cwd）。 */
export function dutyMailboxPath(): string {
  const env = process.env.TRIMC_NOTIFY_MAILBOX?.trim();
  if (env) return resolve(env);
  return resolve(process.cwd(), 'notify-mailbox.json');
}

/** 启动值席消费面（调用方保证 dutySeats 非空；间隔轮询自家 outbox）。 */
export function startDutyConsumer(opts: DutyConsumerOptions): DutyConsumerHandle {
  const intervalMs = opts.intervalMs ?? 30_000;
  const mailboxPath = opts.mailboxPath ?? dutyMailboxPath();
  let stopped = false;
  let running = false;

  async function tickOnce(): Promise<{ pulled: number; delivered: number; failed: number }> {
    if (running) return { pulled: 0, delivered: 0, failed: 0 };
    running = true;
    try {
      const pending = pullPendingForSeats(opts.dutySeats);
      let delivered = 0;
      let failed = 0;
      for (const m of pending) {
        // 拉走确认（forwarded）——同进程直调，失败不阻断落箱（下轮幂等重放）
        transitionStatus(m.message_id, 'forwarded');
        const stored = storeDutyLetter(
          mailboxPath,
          {
            message_id: m.message_id,
            source_seat: m.source_seat,
            target_seat: m.target_seat,
            urgent: m.urgent,
            title: m.title,
            body: m.body,
            delivery: m.urgent === 'urgent' ? 'toast' : 'mailbox',
          },
          new Date(),
        );
        // 最后一跳：urgent=tmux 弹显（未配会话=信箱落箱语义即达）；normal=落箱即达
        let deliveredOk = true;
        if (m.urgent === 'urgent' && opts.tmuxSession) {
          deliveredOk = opts.onUrgentDeliver
            ? await opts.onUrgentDeliver(m.title, m.body)
            : await showTmuxMessage(opts.tmuxSession, m.title, m.body);
        }
        if (deliveredOk) {
          delivered += 1;
          transitionStatus(m.message_id, 'delivered');
        } else {
          failed += 1; // urgent 弹显失败：滞留 forwarded（status 面可见未送达，不静默；与 TriMLC 同构）
        }
        void stored;
      }
      return { pulled: pending.length, delivered, failed };
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => { if (!stopped) void tickOnce(); }, intervalMs);
  if (typeof timer === 'object' && 'unref' in timer) (timer as { unref: () => void }).unref();

  return {
    stop: () => { stopped = true; clearInterval(timer); },
    tickOnce,
  };
}

/**
 * env 门装配（server 启动接线用）：TRIMC_NOTIFY_DUTY_SEATS 未设=返回 null
 *（零行为）；TRIMC_NOTIFY_DUTY_TMUX 未设=urgent 按信箱落箱语义。
 */
export function maybeStartDutyConsumerFromEnv(): DutyConsumerHandle | null {
  const seatsRaw = process.env.TRIMC_NOTIFY_DUTY_SEATS?.trim();
  if (!seatsRaw) return null;
  const dutySeats = seatsRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (dutySeats.length === 0) return null;
  const tmuxSession = process.env.TRIMC_NOTIFY_DUTY_TMUX?.trim() || undefined;
  console.log(`[trimc] duty notify consumer: seats=${dutySeats.join(',')}${tmuxSession ? ` tmux=${tmuxSession}` : ''}`);
  return startDutyConsumer({ dutySeats, tmuxSession });
}
