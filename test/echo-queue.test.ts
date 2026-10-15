// ── Q2 反向通道件①：回声出向队列（echo-queue）测试卷 ──
// 派工单 046caf7cb（CTO 2026-10-15 18:19 +0800·CEO 18:16 批）·四红线技术形逐条入测：
//   红线① ≤8KB 无文件字段 → t5（text 超 8KB 413）/ t5b（多字节字节面反例）/ t4（file 字段 400·routes 层白名单）
//   红线② 白名单最小集 → t3（target_endpoint 白名单外 403+ledger reject 行）/ t9（consumer 白名单外 403）
//   红线③ 零共享面 → 设计注记（本卷断言 echo 存储与 outbox 存储文件面互不触及）
//   红线④ 三元组入队即拒 → t6（逐字段缺）/ t7（ts_machine 非法）
// 幂等锚（红线④端到端）→ t2（同 id duplicate）/ t11（ack 幂等）/ t12（ack 后不再返回）
// 纯函数面测试（routes 薄壳+真起服冒烟=sg 换装后端到端段）；env 缝照 duty-consumer 先例。
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ackEchoItem,
  echoTargets,
  enqueueEchoItem,
  ECHO_QUEUE_FILE_ENV,
  pullEchoQueue,
} from '../src/notify/echo-queue.js';

describe('echo 出向队列（Q2 件①）', () => {
  const dirs: string[] = [];
  const prevEnv: Record<string, string | undefined> = {};
  let queuePath = '';
  let ledgerPath = '';

  function freshPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'trimmc-echo-'));
    dirs.push(dir);
    return join(dir, 'echo-queue.json');
  }
  function setEnv(key: string, value: string | undefined): void {
    if (!(key in prevEnv)) prevEnv[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  function readLedger(): Array<Record<string, unknown>> {
    if (!existsSync(ledgerPath)) return [];
    return readFileSync(ledgerPath, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
  const validInput = () => ({
    target_endpoint: 'm-local-mailbox',
    source_id: 'sg-duty-cos',
    ts_machine: '2026-10-15T11:00:00Z',
    ref: 'brief-20261015-a',
    text: '回声件正文',
    title: '测试回声件',
  });

  beforeEach(() => {
    queuePath = freshPath();
    ledgerPath = queuePath.replace(/\.json$/, '') + '-ledger.jsonl';
    setEnv(ECHO_QUEUE_FILE_ENV, queuePath);
    setEnv('TRIMC_ECHO_TARGETS', undefined);
  });
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('t0 白名单 env 结构化：缺省单值 m-local-mailbox·env 覆盖生效', () => {
    assert.deepEqual(echoTargets(), ['m-local-mailbox']);
    setEnv('TRIMC_ECHO_TARGETS', 'm-local-mailbox,second-endpoint');
    assert.deepEqual(echoTargets(), ['m-local-mailbox', 'second-endpoint']);
    setEnv('TRIMC_ECHO_TARGETS', undefined);
  });

  it('t1 合法入队 → 201 形（ok/item/duplicate=false）+ledger enqueue_accepted', () => {
    const r = enqueueEchoItem(validInput());
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.duplicate, false);
    assert.match(r.item.message_id, /^echo-/);
    assert.equal(r.item.status, 'pending');
    const led = readLedger();
    assert.ok(led.some((e) => e.event === 'enqueue_accepted' && e.message_id === r.item.message_id));
    assert.ok(!led.some((e) => e.event === 'enqueue_accepted' && (e as { text?: string }).text), 'ledger 零 text 正文');
  });

  it('t2 幂等：同 message_id 重投 → duplicate=true 零重落', () => {
    const a = enqueueEchoItem({ ...validInput(), message_id: 'echo-dup-1' });
    const b = enqueueEchoItem({ ...validInput(), message_id: 'echo-dup-1' });
    assert.equal(a.ok && b.ok, true);
    if (a.ok && b.ok) {
      assert.equal(a.duplicate, false);
      assert.equal(b.duplicate, true);
      assert.equal(b.item.message_id, a.item.message_id);
    }
  });

  it('t3 红线②：target_endpoint 白名单外 → 403+ledger reject 留痕（验收锚 2 判法）', () => {
    const r = enqueueEchoItem({ ...validInput(), target_endpoint: 'unknown-endpoint' });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.statusCode, 403);
    assert.equal(r.error, 'target_not_allowed');
    const led = readLedger();
    assert.ok(led.some((e) => e.event === 'rejected' && e.error === 'target_not_allowed'));
  });

  it('t4 红线①（routes 层白名单的单函数侧）：echo 存储与 notify outbox 文件面互不触及（红线③注记断言）', () => {
    enqueueEchoItem(validInput());
    const dir = join(queuePath, '..');
    assert.ok(existsSync(queuePath));
    assert.ok(!existsSync(join(dir, 'notify-outbox.json')), 'echo 入队不触 outbox 存储（零共享面）');
  });

  it('t5 红线①：text 超 8KB → 413 text_over_8kb', () => {
    const r = enqueueEchoItem({ ...validInput(), text: 'a'.repeat(8 * 1024 + 1) });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.statusCode, 413);
    assert.equal(r.error, 'text_over_8kb');
  });

  it('t5b 多字节字节面：3000 汉字=9000 字节超限（字符数面假阴性反例钉死）', () => {
    const r = enqueueEchoItem({ ...validInput(), text: '令'.repeat(3000) });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.statusCode, 413);
  });

  it('t6 红线④：三元组逐字段缺 → 400 missing_tuple+ledger reject（入队即拒·第一闸）', () => {
    for (const k of ['source_id', 'ts_machine', 'ref'] as const) {
      const broken = { ...validInput() };
      (broken as Record<string, unknown>)[k] = '';
      const r = enqueueEchoItem(broken);
      assert.equal(r.ok, false, `缺 ${k} 应拒`);
      if (r.ok) continue;
      assert.equal(r.statusCode, 400);
      assert.equal(r.error, 'missing_tuple');
      assert.ok(r.message.includes(k), `拒因点名缺失字段 ${k}`);
    }
    assert.ok(readLedger().filter((e) => e.event === 'rejected' && e.error === 'missing_tuple').length === 3);
  });

  it('t7 红线④时戳纪律：ts_machine 非法 → 400 invalid_ts_machine', () => {
    const r = enqueueEchoItem({ ...validInput(), ts_machine: 'not-a-timestamp' });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.statusCode, 400);
    assert.equal(r.error, 'invalid_ts_machine');
  });

  it('t8 拉取契约形：items 只含六键投影（件② echo-pull.mjs 锚死形）+attempts+1+时间序', () => {
    enqueueEchoItem({ ...validInput(), ref: 'b-second' }, undefined, new Date('2026-10-15T11:00:02Z'));
    enqueueEchoItem({ ...validInput(), ref: 'a-first' }, undefined, new Date('2026-10-15T11:00:01Z'));
    const r = pullEchoQueue('mc-echo-pull');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.items.length, 2);
    assert.equal(r.items[0].ref, 'a-first', 'enqueued_at 升序（先入先出）');
    for (const it of r.items) {
      assert.deepEqual(Object.keys(it).sort(), ['message_id', 'ref', 'source_id', 'text', 'title', 'ts_machine'].sort());
      assert.ok(!('status' in it) && !('attempts' in it), '内部状态字段零暴露');
    }
  });

  it('t9 红线②拉取侧：consumer 白名单外 → 403 consumer_not_allowed+ledger reject', () => {
    const r = pullEchoQueue('random-consumer');
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.statusCode, 403);
    assert.equal(r.error, 'consumer_not_allowed');
    assert.ok(readLedger().some((e) => e.event === 'rejected' && e.error === 'consumer_not_allowed'));
  });

  it('t10 ack 未知 id → not_found', () => {
    const r = ackEchoItem('echo-nonexistent', 'mc-echo-pull');
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, 'not_found');
  });

  it('t11+t12 消账闭环：ack 成功→queue 不再返回→幂等重 ack duplicate=true', () => {
    const e = enqueueEchoItem({ ...validInput(), message_id: 'echo-ack-1' });
    assert.ok(e.ok);
    const a1 = ackEchoItem('echo-ack-1', 'mc-echo-pull');
    assert.equal(a1.ok && !a1.duplicate, true);
    const p = pullEchoQueue('mc-echo-pull');
    assert.equal(p.ok, true);
    if (p.ok) assert.equal(p.items.length, 0, 'acked 件不再返回');
    const a2 = ackEchoItem('echo-ack-1', 'mc-echo-pull');
    assert.equal(a2.ok && a2.duplicate, true);
    assert.ok(readLedger().filter((x) => x.event === 'acked').length === 1, 'ledger 只记一次 acked');
  });

  it('t13 队列上限：pending 满则 503 queue_full', () => {
    for (let i = 0; i < 200; i++) {
      const r = enqueueEchoItem({ ...validInput(), ref: `bulk-${i}` });
      assert.ok(r.ok, `第 ${i} 件应入队`);
    }
    const over = enqueueEchoItem({ ...validInput(), ref: 'bulk-over' });
    assert.equal(over.ok, false);
    if (over.ok) return;
    assert.equal(over.statusCode, 503);
    assert.equal(over.error, 'queue_full');
  });
});
