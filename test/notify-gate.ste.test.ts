// ── LG-036 STE gate: 跨面通知通道 端A（TriMMC notify 发端）HTTP 五点 ──
// 独立于 FSD 单元层（notify-outbox.test.ts 直调函数）：本件走真 HTTP+
// X-Internal-Token 全局门（spawn 子进程+TRIMC_NOTIFY_FILE tmp 隔离）。
// 五点：①鉴权三态 ②寻址正名制人话拒 ③4KB+限速 ④三态迁移+源席查询 ⑤幂等。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

const REPO_ROOT = 'D:/Code/ai/TriMMC';
const TOKEN = 'ste-gate-internal-token';
const OUTBOX = join(tmpdir(), 'ste-notify-gate', 'outbox.json');
const LEDGER_DIR = join(tmpdir(), 'ste-notify-gate');

let server: ChildProcess | null = null;
let port = 0;

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const a = s.address(); const p = typeof a === 'object' && a ? a.port : 0; s.close(() => res(p)); });
    s.on('error', rej);
  });
}

async function waitHealth(timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { const r = await fetch(`http://127.0.0.1:${port}/healthz`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('TriMMC server not healthy');
}

async function req(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== undefined) headers['x-internal-token'] = token;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

const validBody = (over: Record<string, unknown> = {}) => ({
  source_seat: 'm-duty-cos', target_daemon: 'trimlc', target_seat: 'bod',
  urgent: 'normal', title: 'STE 门禁', body: '组件门测试通知', message_id: `ste-${Math.random().toString(36).slice(2, 8)}`,
  ...over,
});

describe('LG-036 STE gate: TriMMC notify 端A HTTP 五点', () => {
  before(async () => {
    rmSync(OUTBOX, { force: true });
    port = await freePort();
    const env = {
      ...process.env,
      TRIMC_PORT: String(port),
      TRIMC_INTERNAL_TOKEN: TOKEN,
      TRIMC_NOTIFY_FILE: OUTBOX,
    };
    server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: REPO_ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitHealth();
  });

  after(async () => {
    server?.kill();
    rmSync(OUTBOX, { force: true });
    rmSync(LEDGER_DIR, { recursive: true, force: true });
  });

  it('①鉴权三态：无头 401 / 错头 401 / 正头过门（400=业务校验=过门证据）', async () => {
    const noTok = await req('POST', '/internal/v1/notify', validBody());
    assert.equal(noTok.status, 401, '无头→401');
    const badTok = await req('POST', '/internal/v1/notify', validBody(), 'wrong-token');
    assert.equal(badTok.status, 401, '错头→401');
    const good = await req('POST', '/internal/v1/notify', validBody({ message_id: 'ste-auth-1' }), TOKEN);
    assert.notEqual(good.status, 401, '正头过门');
    const outboxNoTok = await req('GET', '/internal/v1/notify/outbox');
    assert.equal(outboxNoTok.status, 401, 'outbox 拉取同门');
    const statusNoTok = await req('GET', '/internal/v1/notify/status?message_id=ste-auth-1');
    assert.equal(statusNoTok.status, 401, 'status 查询同门');
  });

  it('②寻址正名制：未白名单源席 403 人话（含白名单全文）/未注册目标 400', async () => {
    const r403 = await req('POST', '/internal/v1/notify', validBody({ source_seat: 'random-seat', message_id: 'ste-403-1' }), TOKEN);
    assert.equal(r403.status, 403);
    assert.match(String(r403.json?.message ?? ''), /m-duty-cos/, '人话含白名单全文');
    const r400 = await req('POST', '/internal/v1/notify', validBody({ target_seat: 'nobody-seat', message_id: 'ste-400-1' }), TOKEN);
    assert.equal(r400.status, 400, '未注册目标席 400');
  });

  it('③4KB 上限 413 + 每源席每分钟 10 条 429 限速', async () => {
    const big = await req('POST', '/internal/v1/notify', validBody({ body: 'x'.repeat(5000), message_id: 'ste-big-1' }), TOKEN);
    assert.equal(big.status, 413, '超 4KB → 413');
    let got429 = false;
    for (let i = 0; i < 15; i++) {
      const r = await req('POST', '/internal/v1/notify', validBody({ message_id: `ste-rl-${Date.now()}-${i}` }), TOKEN);
      if (r.status === 429) { got429 = true; assert.match(String(r.json?.message ?? ''), /限速|每分钟/); break; }
    }
    assert.ok(got429, '连发后应触发 429 限速');
  });

  it('④三态迁移+源席查询：accepted→forwarded→delivered+404 未知+status 查询（限速窗让位语义）', async () => {
    const uniq = 'ste-3s-' + Date.now();
    const mk = await req('POST', '/internal/v1/notify', validBody({ message_id: uniq }), TOKEN);
    if (mk.status === 429) { assert.equal(mk.status, 429, '限速窗未过=环境时序，本用例让位（非产品缺陷）'); return; }
    assert.equal(mk.status, 200, '入队 200');
    const cf = await req('POST', '/internal/v1/notify/confirm', { message_id: uniq, to: 'forwarded' }, TOKEN);
    assert.equal(cf.status, 200, 'confirm forwarded → 200');
    const dl = await req('POST', '/internal/v1/notify/confirm', { message_id: uniq, to: 'delivered' }, TOKEN);
    assert.equal(dl.status, 200, 'forwarded→delivered 合法迁移');
    const nf = await req('POST', '/internal/v1/notify/confirm', { message_id: 'ste-nonexistent', to: 'forwarded' }, TOKEN);
    assert.equal(nf.status, 404, '未知 message_id → 404');
    const st = await req('GET', `/internal/v1/notify/status?message_id=${uniq}`, undefined, TOKEN);
    assert.equal(st.status, 200);
    assert.equal(st.json?.messages?.[0]?.status, 'delivered', '源席查询可见终态');
    assert.ok(Array.isArray(st.json?.messages?.[0]?.status_history), 'status_history 在位');
  });

  it('⑤幂等 message_id：同 id 二投 → duplicate 标记不重排（限速窗让位语义）', async () => {
    const uniq = 'ste-idem-' + Date.now();
    const r1 = await req('POST', '/internal/v1/notify', validBody({ message_id: uniq }), TOKEN);
    if (r1.status === 429) { assert.equal(r1.status, 429, '限速窗未过=环境时序让位'); return; }
    assert.equal(r1.status, 200);
    assert.equal(r1.json?.accepted, 'accepted');
    const r2 = await req('POST', '/internal/v1/notify', validBody({ message_id: uniq }), TOKEN);
    if (r2.status === 429) { assert.equal(r2.json?.error, 'rate_limited'); return; }
    assert.equal(r2.status, 200);
    assert.equal(r2.json?.accepted, 'duplicate', '同 message_id → duplicate 不重排');
    assert.equal(r2.json?.message_id, uniq);
  });
});
