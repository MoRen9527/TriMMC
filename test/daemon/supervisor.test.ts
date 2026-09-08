// ── LG-033 b 窗 1 件①：ManagedProcessSupervisor 生命周期单测 ──
// 起动/存活/监控/退出退避重启计数/pause-resume 协议位/熔断上限。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagedProcessSupervisor } from '../../src/daemon/supervisor.js';

const TD = mkdtempSync(join(tmpdir(), 'lg033-sup-'));

/** 长驻替身：node 脚本，SIGTERM 前常驻。 */
const LONGRUN = join(TD, 'longrun.mjs');
writeFileSync(LONGRUN, 'setInterval(() => {}, 1000);\n');

/** 即退替身：立刻 exit（触发退避重启链）。 */
const EXITING = join(TD, 'exiting.mjs');
writeFileSync(EXITING, 'process.exit(0);\n');

function wait(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

describe('ManagedProcessSupervisor 生命周期', () => {
  test('起动→running→存活→人为 stop→stopped（不自动重启）', async () => {
    const sup = new ManagedProcessSupervisor({ binaryPath: process.execPath, args: [LONGRUN], cwd: TD, backoffBaseMs: 50 });
    sup.start();
    await wait(300);
    assert.equal(sup.isAlive(), true);
    assert.equal(sup.getState(), 'running');
    assert.ok(sup.getPid() !== null);
    sup.stop();
    await wait(200);
    assert.equal(sup.isAlive(), false);
    assert.equal(sup.getState(), 'stopped');
    assert.equal(sup.getRestarts(), 0);
  });

  test('即退替身：退避自动重启计数递增（restart 事件链）', async () => {
    const sup = new ManagedProcessSupervisor({
      binaryPath: process.execPath, args: [EXITING], cwd: TD,
      backoffBaseMs: 20, maxRestarts: 3,
    });
    const restarts: number[] = [];
    sup.on('restart', (info) => restarts.push(info.attempt));
    sup.start();
    // Windows spawn 开销+全量套件并行负载——轮询等熔断态（15s 上限）
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && sup.getState() !== 'stopped') await wait(100);
    assert.equal(sup.getState(), 'stopped'); // 熔断（maxRestarts=3 耗尽）
    assert.equal(sup.getRestarts(), 3);
    assert.deepEqual(restarts, [1, 2, 3]);
  });

  test('pause-resume 协议位：pause 进 paused 态（进程退出）→resume 全旗标重拉回 running', async () => {
    const sup = new ManagedProcessSupervisor({ binaryPath: process.execPath, args: [LONGRUN], cwd: TD, backoffBaseMs: 50 });
    sup.start();
    await wait(300);
    assert.equal(sup.isAlive(), true);
    sup.pause();
    await wait(200);
    assert.equal(sup.isAlive(), false);
    assert.equal(sup.getState(), 'paused'); // c 人工接入窗（进程退出+上下文保留）
    sup.resume();
    await wait(300);
    assert.equal(sup.isAlive(), true);
    assert.equal(sup.getState(), 'running');
    assert.equal(sup.getRestarts(), 0); // pause/resume 非故障链不计重启
    sup.stop();
  });

  test('pause 态下子进程意外退出不误入重启链（paused 保持）', async () => {
    const sup = new ManagedProcessSupervisor({ binaryPath: process.execPath, args: [EXITING], cwd: TD, backoffBaseMs: 50, maxRestarts: 5 });
    // 直接以 pause 语义启动即退替身：首拉后立即 pause 标记——用 paused 首拉路径验证
    (sup as unknown as { paused: boolean }).paused = true; // 模拟 pause 后首拉
    sup.start();
    await wait(400);
    assert.equal(sup.getState(), 'paused'); // 退出后回 paused 不进 backoff
    assert.equal(sup.getRestarts(), 0);
  });
});
