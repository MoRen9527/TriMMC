// ── LG-052 阶段二：sg 值席收端消费面测试（TriMMC duty-consumer）──
// 覆盖：env 门/定向拉取隔离（不抢 trimlc 件）/normal 落箱即达/urgent tmux 失败
// 重投+成功达/urgent 未配会话=信箱语义/幂等不重拉。outbox 路径走
// TRIMC_NOTIFY_FILE env 缝，信箱走 opts 注入。
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enqueueNotify, pullPending, queryStatus, NOTIFY_FILE_ENV } from '../src/notify/outbox.js';
import {
  maybeStartDutyConsumerFromEnv,
  startDutyConsumer,
} from '../src/notify/duty-consumer.js';

describe('duty notify consumer（LG-052 sg 值席收端）', () => {
  const dirs: string[] = [];
  const prevEnv: Record<string, string | undefined> = {};
  function freshPaths(): { outbox: string; mailbox: string } {
    const dir = mkdtempSync(join(tmpdir(), 'trimmc-duty-'));
    dirs.push(dir);
    return { outbox: join(dir, 'notify-outbox.json'), mailbox: join(dir, 'notify-mailbox.json') };
  }
  function setEnv(key: string, value: string | undefined): void {
    if (!(key in prevEnv)) prevEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  beforeEach(() => {
    setEnv(NOTIFY_FILE_ENV, undefined);
    setEnv('TRIMC_NOTIFY_DUTY_SEATS', undefined);
    setEnv('TRIMC_NOTIFY_DUTY_TMUX', undefined);
  });
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const enqueueDuty = (path: string, over: Record<string, unknown> = {}) => enqueueNotify({
    source_seat: 'bod', target_daemon: 'trimmc', target_seat: 'm-duty-cos',
    urgent: 'normal', title: '跨面件', body: '本机发→sg 值席收', message_id: 'duty-1', ...over,
  }, path);

  it('env 门：未设 TRIMC_NOTIFY_DUTY_SEATS=null 零行为；设值=handle', () => {
    assert.equal(maybeStartDutyConsumerFromEnv(), null);
    setEnv('TRIMC_NOTIFY_DUTY_SEATS', 'm-duty-cos');
    const h = maybeStartDutyConsumerFromEnv();
    assert.ok(h, '设值应出 handle');
    h?.stop();
  });

  it('normal 件：定向拉取→forwarded+信箱落箱→delivered 三态回写', async () => {
    const { outbox, mailbox } = freshPaths();
    setEnv(NOTIFY_FILE_ENV, outbox);
    enqueueDuty(outbox);
    const h = startDutyConsumer({ dutySeats: ['m-duty-cos'], mailboxPath: mailbox });
    const r = await h.tickOnce();
    h.stop();
    assert.deepEqual(r, { pulled: 1, delivered: 1, failed: 0 });
    const st = queryStatus('duty-1', outbox)[0];
    assert.equal(st.status, 'delivered');
    assert.deepEqual(st.status_history.map((x) => x.status), ['accepted', 'forwarded', 'delivered']);
    const mb = JSON.parse(readFileSync(mailbox, 'utf-8')) as { letters: Array<{ message_id: string; target_seat: string }> };
    assert.equal(mb.letters.length, 1);
    assert.equal(mb.letters[0].target_seat, 'm-duty-cos');
  });

  it('定向隔离：trimlc 件（target bod）不被值席轮次拉取（attempts 不动）', async () => {
    const { outbox, mailbox } = freshPaths();
    setEnv(NOTIFY_FILE_ENV, outbox);
    enqueueDuty(outbox);
    enqueueNotify({ source_seat: 'bod', target_daemon: 'trimlc', target_seat: 'bod', urgent: 'normal', title: '本地件', body: 'b', message_id: 'local-1' }, outbox);
    const h = startDutyConsumer({ dutySeats: ['m-duty-cos'], mailboxPath: mailbox });
    const r = await h.tickOnce();
    h.stop();
    assert.deepEqual(r, { pulled: 1, delivered: 1, failed: 0 }, '只取值席件');
    const localSt = queryStatus('local-1', outbox)[0];
    assert.equal(localSt.status, 'pending', 'trimlc 件保持 pending（归本地 puller）');
    assert.equal(localSt.attempts, 0, '值席轮次不动他件 attempts');
    assert.equal(pullPending(outbox).length, 1, '全量拉取面仍见本地件');
  });

  it('urgent：tmux 弹显失败=滞留 forwarded（可见未送达不静默）；成功=delivered', async () => {
    const { outbox, mailbox } = freshPaths();
    setEnv(NOTIFY_FILE_ENV, outbox);
    enqueueDuty(outbox, { urgent: 'urgent', message_id: 'duty-u1', title: 'fail-case' });
    enqueueDuty(outbox, { urgent: 'urgent', message_id: 'duty-u2', title: 'ok-case' });
    const h = startDutyConsumer({
      dutySeats: ['m-duty-cos'], mailboxPath: mailbox, tmuxSession: 'm-duty-cos',
      onUrgentDeliver: async (title) => title.includes('ok'),
    });
    const r1 = await h.tickOnce();
    h.stop();
    assert.deepEqual(r1, { pulled: 2, delivered: 1, failed: 1 });
    assert.equal(queryStatus('duty-u1', outbox)[0].status, 'forwarded', '失败滞留 forwarded（status 面可见未送达）');
    assert.equal(queryStatus('duty-u2', outbox)[0].status, 'delivered', '成功即达');
  });

  it('urgent 未配 tmux 会话=信箱落箱语义即达', async () => {
    const { outbox, mailbox } = freshPaths();
    setEnv(NOTIFY_FILE_ENV, outbox);
    enqueueDuty(outbox, { urgent: 'urgent', message_id: 'duty-u2' });
    const h = startDutyConsumer({ dutySeats: ['m-duty-cos'], mailboxPath: mailbox });
    const r = await h.tickOnce();
    h.stop();
    assert.deepEqual(r, { pulled: 1, delivered: 1, failed: 0 });
    assert.equal(queryStatus('duty-u2', outbox)[0].status, 'delivered');
  });

  it('幂等：delivered 件不重拉', async () => {
    const { outbox, mailbox } = freshPaths();
    setEnv(NOTIFY_FILE_ENV, outbox);
    enqueueDuty(outbox);
    const h = startDutyConsumer({ dutySeats: ['m-duty-cos'], mailboxPath: mailbox });
    await h.tickOnce();
    const r2 = await h.tickOnce();
    h.stop();
    assert.deepEqual(r2, { pulled: 0, delivered: 0, failed: 0 });
  });
});
