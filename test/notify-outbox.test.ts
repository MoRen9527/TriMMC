// ── LG-036 notify outbox 测试（TriMMC 发端；方案 acaae9fc）──
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  enqueueNotify,
  enqueueNotifyBroadcast,
  pullPending,
  queryStatus,
  transitionStatus,
  NOTIFY_BODY_MAX_BYTES,
  OUTBOX_MAX_PENDING,
  SOURCE_SEAT_WHITELIST,
  TARGET_SEAT_ROSTER,
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

// ── LG-052 阶段一：一稿多投广播（展开制）──
describe('notify broadcast（LG-052 一稿多投）', () => {
  const dirs: string[] = [];
  function freshPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'trimc-notify-bc-'));
    dirs.push(dir);
    return join(dir, 'notify-outbox.json');
  }
  after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

  const bc = (path: string, over: Record<string, unknown> = {}) => enqueueNotifyBroadcast({
    source_seat: 'bod', target_daemon: 'trimlc',
    targets: ['m-fsd', 'm-cto', 'm-coo'],
    urgent: 'normal', title: '全席通报', body: '通道口径公告', message_id: 'ntf-bc-1', ...over,
  }, path);

  it('名册扩面：13 员工席 opsName 在册+bod/coo 保留', () => {
    for (const seat of ['m-cos', 'm-cao', 'm-cfo', 'm-cho', 'm-cmo', 'm-coo', 'm-cpo', 'm-cto', 'm-cso', 'm-fsd', 'm-rdt', 'm-dee', 'm-ste']) {
      assert.ok(TARGET_SEAT_ROSTER[seat], `${seat} 应在册`);
      assert.equal(TARGET_SEAT_ROSTER[seat].daemon, 'trimlc');
    }
    assert.ok(TARGET_SEAT_ROSTER.bod && TARGET_SEAT_ROSTER.coo, '治理短名保留');
    assert.ok(TARGET_SEAT_ROSTER['m-duty-cos'], '阶段二值席收端在册（daemon=trimmc）');
    assert.equal(TARGET_SEAT_ROSTER['m-duty-cos'].daemon, 'trimmc');
    assert.equal(Object.keys(TARGET_SEAT_ROSTER).length, 16, '13 员工+bod/coo 治理短名+值席收端');
  });

  it('白名单扩面：治理链三席入列+m-duty-cos 保留', () => {
    for (const s of ['bod', 'm-cos', 'm-coo', 'm-duty-cos']) {
      assert.ok(SOURCE_SEAT_WHITELIST.includes(s), `${s} 应在白名单`);
    }
  });

  it('广播展开：N 件逐席派生 id，三态逐席独立', () => {
    const path = freshPath();
    const r = bc(path);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.results.length, 3);
    assert.equal(r.accepted, 3);
    assert.deepEqual(r.results.map((x) => x.message_id), ['ntf-bc-1--m-fsd', 'ntf-bc-1--m-cto', 'ntf-bc-1--m-coo']);
    // 逐席独立三态：只确认 m-fsd 件，余两件不受影响
    assert.equal(transitionStatus('ntf-bc-1--m-fsd', 'forwarded', path).ok, true);
    const st = queryStatus(null, path);
    assert.equal(st.find((m) => m.message_id === 'ntf-bc-1--m-fsd')?.status, 'forwarded');
    assert.equal(st.find((m) => m.message_id === 'ntf-bc-1--m-cto')?.status, 'pending');
    assert.equal(st.find((m) => m.message_id === 'ntf-bc-1--m-coo')?.status, 'pending');
  });

  it('广播幂等：同基 id 重播=逐席 duplicate+箱内不增', () => {
    const path = freshPath();
    bc(path);
    const r2 = bc(path);
    assert.equal(r2.ok, true);
    if (!r2.ok) return;
    assert.equal(r2.accepted, 0);
    assert.equal(r2.duplicates, 3);
    assert.equal(queryStatus(null, path).length, 3, '箱内仍 3 件');
  });

  it('整单原子：名册外席在列 → 400 零落箱（无半投）', () => {
    const path = freshPath();
    const r = bc(path, { targets: ['m-fsd', 'nobody'] });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.statusCode, 400);
    assert.equal(queryStatus(null, path).length, 0, '零落箱');
  });

  it('重复席 → 400 整单拒', () => {
    const r = bc(freshPath(), { targets: ['m-fsd', 'm-fsd'] });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.statusCode, 400);
      assert.equal(r.error, 'duplicate_targets');
    }
  });

  it('pending 上限原子性：空间不足整单 503 零落箱', () => {
    const path = freshPath();
    const messages = [];
    for (let i = 0; i < OUTBOX_MAX_PENDING - 1; i++) {
      messages.push({
        message_id: `ntf-pre-${i}`, source_seat: 'bod', target_daemon: 'trimlc', target_seat: 'bod',
        urgent: 'normal', title: `t${i}`, body: 'b', enqueued_at: new Date(Date.now() - 3600_000).toISOString(),
        status: 'pending', status_history: [{ status: 'accepted', at: new Date().toISOString() }], attempts: 0,
      });
    }
    writeFileSync(path, JSON.stringify({ messages }, null, 2) + '\n', 'utf-8');
    const r = bc(path); // 需 3 空位，仅余 1 → 503
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.statusCode, 503);
    assert.equal(queryStatus(null, path).length, OUTBOX_MAX_PENDING - 1, '零新增（无半投）');
  });

  it('限速操作数语义：窗口内既有 9 件（他席目标）广播作第 10 操作可发', () => {
    const path = freshPath();
    for (let i = 0; i < 9; i++) {
      enqueueNotify({ source_seat: 'bod', target_daemon: 'trimlc', target_seat: 'coo', urgent: 'normal', title: `t${i}`, body: 'b' }, path);
    }
    const r = bc(path); // 广播=窗口第 10 操作（计 1 不计展开 3 件）→ 放行
    assert.equal(r.ok, true, '广播计操作数=1，不受展开件数挤兑');
    // 下一操作（第 11）→ 429
    const r2 = bc(path, { message_id: 'ntf-bc-2' });
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.equal(r2.statusCode, 429);
  });

  it('单投路径零变化：bod/coo 双投与既有用例同形（回归哨兵）', () => {
    const path = freshPath();
    const r = enqueueNotify({ source_seat: 'm-duty-cos', target_daemon: 'trimlc', target_seat: 'bod', urgent: 'normal', title: '候裁决', body: 'x', message_id: 'ntf-reg-1' }, path);
    assert.equal(r.ok, true);
    const r2 = enqueueNotify({ source_seat: 'm-duty-cos', target_daemon: 'trimlc', target_seat: 'coo', urgent: 'normal', title: '候裁决', body: 'x', message_id: 'ntf-reg-2' }, path);
    assert.equal(r2.ok, true);
    assert.equal(queryStatus(null, path).length, 2);
  });
});
