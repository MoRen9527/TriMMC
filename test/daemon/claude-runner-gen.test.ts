// ── LG-033 b 窗 2 世代校验修复单测（STE 勘定竞态实锤；CTO 令 2026-09-08）──
// 正反路径：陈旧 result 不结算新请求（行级+settle 级双层）/匹配 result 正常结算
// +并发压力（多请求快速连续发再收，末态全正确）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeSessionRunner, type StreamJsonMessage } from '../../src/daemon/claude-runner.js';

const TD = mkdtempSync(join(tmpdir(), 'lg033-gen-'));

/** echo 替身：每行回 assistant（content=echo:原请求 JSON）。 */
const ECHO = join(TD, 'echo.mjs');
writeFileSync(
  ECHO,
  [
    "import { createInterface } from 'node:readline';",
    "const rl = createInterface({ input: process.stdin });",
    "rl.on('line', (line) => {",
    "  try {",
    "    const msg = JSON.parse(line);",
    "    process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'echo:' + JSON.stringify(msg) }] } }) + '\\n');",
    "  } catch { /* ignore */ }",
    "});",
  ].join('\n'),
);

function wait(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

/** 白盒句柄：私有面直调（世代校验单测不可黑盒达——时序注入需直控）。 */
function internals(runner: ClaudeSessionRunner) {
  return runner as unknown as {
    gen: number;
    staleLines: number;
    staleSettles: number;
    pendingQueue: Array<{ gen: number; resolve: (m: StreamJsonMessage) => void; reject: (e: Error) => void; sentAtMs: number }>;
    handleLine: (line: string, boundPid: number | null) => void;
    dispatchMessage: (msg: StreamJsonMessage) => void;
    flushPending: (reason: string) => void;
    childRef: () => { pid: number | null } | null;
  };
}

describe('LG-033 settleNext 世代校验（STE 竞态修复）', () => {
  test('正路径：当前代 assistant 行正常结算 pending', async () => {
    const runner = new ClaudeSessionRunner({ binaryPath: process.execPath, args: [ECHO], headlessArgs: [], cwd: TD });
    const it = internals(runner);
    it.gen = 0;
    // 白盒：直推 pending（模拟 request 后状态——不起进程）
    let resolved: StreamJsonMessage | null = null;
    it.pendingQueue.push({ gen: 0, resolve: (m) => { resolved = m; }, reject: () => {}, sentAtMs: 0 });
    it.dispatchMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'r1' }] } });
    assert.ok(resolved, '当前代行应结算 pending');
    assert.equal((resolved as { message?: { content?: Array<{ text?: string }> } }).message?.content?.[0]?.text, 'r1');
    assert.equal(it.pendingQueue.length, 0);
    runner.supervisorApi.stop();
  });

  test('反路径① 行级：旧代 pid 迟到行丢弃（不结算+staleLines 计数）', async () => {
    const runner = new ClaudeSessionRunner({ binaryPath: process.execPath, args: [ECHO], headlessArgs: [], cwd: TD });
    const it = internals(runner);
    it.gen = 0;
    let resolved: StreamJsonMessage | null = null;
    it.pendingQueue.push({ gen: 0, resolve: (m) => { resolved = m; }, reject: () => {}, sentAtMs: 0 });
    // 模拟旧代迟到行：boundPid=999999（≠当前 child pid=null——无进程态仍判旧代丢弃）
    it.handleLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'STALE' }] } }), 999999);
    assert.equal(it.staleLines, 1);
    assert.equal(it.pendingQueue.length, 1, '陈旧行不得结算 pending');
    assert.equal(resolved, null);
    // 当前代行（boundPid=null=无进程态一致）→正常结算
    it.handleLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'FRESH' }] } }), it.childRef()?.pid ?? null);
    assert.ok(resolved, '当前代行应结算');
    assert.match((resolved as { message?: { content?: Array<{ text?: string }> } }).message?.content?.[0]?.text ?? '', /FRESH/);
    runner.supervisorApi.stop();
  });

  test('反路径② settle 级：flush 推进世代后陈旧代 pending 丢弃+staleSettles 计数', async () => {
    const runner = new ClaudeSessionRunner({ binaryPath: process.execPath, args: [ECHO], headlessArgs: [], cwd: TD });
    const it = internals(runner);
    it.gen = 0;
    let rejectedMsg = '';
    it.pendingQueue.push({ gen: 0, resolve: () => {}, reject: (e) => { rejectedMsg = e.message; }, sentAtMs: 0 });
    it.flushPending('stopped'); // 世代推进 0→1+旧 pending reject
    assert.match(rejectedMsg, /flushed/);
    // 模拟陈旧代遗留 pending（gen=0）+陈旧 settle 尝试
    it.gen = 1;
    let staleRejected = false;
    it.pendingQueue.push({ gen: 0, resolve: () => {}, reject: () => { staleRejected = true; }, sentAtMs: 0 });
    it.dispatchMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'STALE-SETTLE' }] } });
    assert.equal(staleRejected, true, '陈旧代 pending 应被 reject 丢弃');
    assert.equal(it.staleSettles, 1);
    runner.supervisorApi.stop();
  });

  test('并发压力：10 请求快速连续发再收，FIFO 末态全正确零串扰', async () => {
    const runner = new ClaudeSessionRunner({ binaryPath: process.execPath, args: [ECHO], headlessArgs: [], cwd: TD });
    runner.supervisorApi.start();
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline && !runner.supervisorApi.isAlive()) await wait(100);
    assert.equal(runner.supervisorApi.isAlive(), true);
    const ps: Array<Promise<StreamJsonMessage>> = [];
    for (let i = 0; i < 10; i++) {
      ps.push(runner.request({ type: 'user', message: { content: `req-${i}` } }));
    }
    const msgs = await Promise.all(ps.map((p) => Promise.race([p, wait(5000).then(() => 'TIMEOUT')])));
    for (let i = 0; i < 10; i++) {
      const m = msgs[i] as { message?: { content?: Array<{ text?: string }> } };
      assert.notEqual(m, 'TIMEOUT', `req-${i} 超时`);
      const text = m.message?.content?.[0]?.text ?? '';
      assert.match(text, new RegExp(`req-${i}`), `第 ${i} 请求串扰: ${text}`);
    }
    const audit = runner.getStaleAudit();
    assert.equal(audit.staleSettles, 0, '正常流零世代丢弃');
    runner.supervisorApi.stop();
  });
});
