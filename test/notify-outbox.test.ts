// ── LG-036 notify outbox 测试（TriMMC 发端；方案 acaae9fc）──
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  enqueueNotify,
  pullPending,
  queryStatus,
  transitionStatus,
  NOTIFY_BODY_MAX_BYTES,
  OUTBOX_MAX_PENDING,
} from '../src/notify/outbox.js';

describe('notify outbox（TriMMC 发端）', () => {
  const dirs: string[] = [];
  function freshPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'trimc-notify-'));
    dirs.push(dir);
    return join(dir, 'notify-outbox.json');
  }
  after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

  const ok = (path: string, over: Record<string, unknown> = {}) => enqueueNotify({
    source_seat: 'm-duty-cos', target_daemon: 'trimlc', target_seat: 'bod',
    urgent: 'normal', title: '候裁决', body: '请裁决 X', message_id: 'ntf-test-1', ...over,
  }, path);

  it('白名单：非 m-duty-cos 源席 → 403', () => {
    const r = ok(freshPath(), { source_seat: 'random-seat' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.statusCode, 403);
  });

  it('正名制：未名目标席 400；daemon/席不匹配 400', () => {
    const a = ok(freshPath(), { target_seat: 'nobody' });
    assert.equal(a.ok, false);
    const b = ok(freshPath(), { target_daemon: 'wrong-daemon' });
    assert.equal(b.ok, false);
  });

  it('4KB 上限 → 413', () => {
    const r = ok(freshPath(), { body: 'x'.repeat(NOTIFY_BODY_MAX_BYTES + 1) });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.statusCode, 413);
  });

  it('正常入队 → accepted/pending + 台账文件在（零 body 入台账）', () => {
    const path = freshPath();
    const r = ok(path);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.message.status, 'pending');
    const ledger = join(path.replace(/\.json$/, '') + '-ledger.jsonl');
    assert.ok(existsSync(ledger), '台账在卷');
    const ledgerText = readFileSync(ledger, 'utf-8');
    assert.equal(ledgerText.includes('请裁决 X'), false, '台账零 body 正文（SEC 白名单）');
  });

  it('幂等：同 message_id → duplicate 标记+单件在箱', () => {
    const path = freshPath();
    const r1 = ok(path);
    const r2 = ok(path);
    assert.equal(r1.ok && r2.ok, true);
    if (r1.ok && r2.ok) {
      assert.equal(r1.duplicate, false);
      assert.equal(r2.duplicate, true);
    }
    assert.equal(queryStatus(null, path).length, 1);
  });

  it('限速：同源席每分钟 10 条，第 11 条 → 429', () => {
    const path = freshPath();
    for (let i = 0; i < 10; i++) {
      enqueueNotify({ source_seat: 'm-duty-cos', target_daemon: 'trimlc', target_seat: 'bod', urgent: 'normal', title: `t${i}`, body: 'b' }, path);
    }
    const r = ok(path, { message_id: undefined, title: 't11' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.statusCode, 429);
  });

  it('上限：pending 满 → 503（直构 doc 绕限速——跨分钟积累场景）', () => {
    const path = freshPath();
    const dir = path.slice(0, path.lastIndexOf('\\')) || path.slice(0, path.lastIndexOf('/'));
    const messages = [];
    for (let i = 0; i < OUTBOX_MAX_PENDING; i++) {
      messages.push({
        message_id: `ntf-pre-${i}`, source_seat: 'm-duty-cos', target_daemon: 'trimlc', target_seat: 'bod',
        urgent: 'normal', title: `t${i}`, body: 'b', enqueued_at: new Date(Date.now() - 3600_000 + i * 1000).toISOString(),
        status: 'pending', status_history: [{ status: 'accepted', at: new Date().toISOString() }], attempts: 0,
      });
    }
    // 跨分钟错峰：全部落到窗口外，限速不触发
    for (const m of messages) m.enqueued_at = new Date(Date.now() - 3600_000).toISOString();
    writeFileSync(path, JSON.stringify({ messages }, null, 2) + '\n', 'utf-8');
    void dir;
    const r = ok(path, { message_id: 'ntf-over', title: 'over' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.statusCode, 503);
  });

  it('三态闭环：pending→forwarded→delivered+状态史在卷+非法迁移拒', () => {
    const path = freshPath();
    ok(path);
    assert.equal(pullPending(path).length, 1, '拉取（replay）');
    assert.equal(transitionStatus('ntf-test-1', 'forwarded', path).ok, true, '收端 confirm forwarded');
    assert.equal(transitionStatus('ntf-test-1', 'delivered', path).ok, true, 'letter-store 终态 delivered');
    assert.equal(transitionStatus('ntf-test-1', 'forwarded', path).ok, false, 'delivered→forwarded 非法拒');
    const st = queryStatus('ntf-test-1', path);
    assert.equal(st[0].status, 'delivered');
    const history = st[0].status_history.map((h) => h.status);
    assert.deepEqual(history, ['accepted', 'forwarded', 'delivered']);
  });

  it('replay 语义：未确认前重出/确认 forwarded 后不重出', () => {
    const path = freshPath();
    ok(path);
    assert.equal(pullPending(path).length, 1, '首拉');
    assert.equal(pullPending(path).length, 1, '未确认=重出（断链重投语义）');
    transitionStatus('ntf-test-1', 'forwarded', path);
    assert.equal(pullPending(path).length, 0, '确认 forwarded 后不重出');
  });
});
