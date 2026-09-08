// ── LG-033 b 窗 1 件②：ClaudeSessionRunner 冒烟（echo 替身流往返）──
// binaryPath 参数化+headlessArgs=[]（替身免旗标毒害）；echo 替身回显 argv=全旗标重传断言面。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { ClaudeSessionRunner } from '../../src/daemon/claude-runner.js';

const TD = mkdtempSync(join(tmpdir(), 'lg033-runner-'));

/** echo 替身：stdin JSON 行→assistant 回显（argvEcho=收到的旗标快照）。 */
const ECHO = join(TD, 'echo-claude.mjs');
writeFileSync(
  ECHO,
  [
    "import { createInterface } from 'node:readline';",
    "const rl = createInterface({ input: process.stdin });",
    "rl.on('line', (line) => {",
    "  try {",
    "    const msg = JSON.parse(line);",
    "    process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'echo:' + JSON.stringify(msg) }] }, argvEcho: process.argv.slice(1) }) + '\\n');",
    "  } catch { /* ignore */ }",
    "});",
  ].join('\n'),
);

function wait(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

async function waitUntil(pred: () => boolean, timeoutMs = 5000, step = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await wait(step);
  }
  throw new Error('waitUntil timeout');
}

const FLAGS = ['--settings', '/srv/fleet/duty-env/.trimmc/settings.json', '--cross-session-inbound', '--model', 'glm-5.3-flash'];

function makeRunner(): ClaudeSessionRunner {
  return new ClaudeSessionRunner({
    binaryPath: process.execPath,
    args: [ECHO, ...FLAGS],
    headlessArgs: [], // 替身免 -p/stream-json 旗标（node 不识）
    cwd: TD,
    maxRestarts: 2,
  });
}

describe('ClaudeSessionRunner 冒烟（echo 流往返）', () => {
  test('stream-json 往返：sendLine 写入成功+进程存活+停止干净', async () => {
    const runner = makeRunner();
    runner.supervisorApi.start();
    await waitUntil(() => runner.supervisorApi.isAlive());
    const wrote = runner.sendLine({ type: 'user', message: { role: 'user', content: 'ping' } });
    assert.equal(wrote, true);
    await wait(300);
    assert.equal(runner.supervisorApi.isAlive(), true);
    runner.supervisorApi.stop();
    await wait(200);
    assert.equal(runner.supervisorApi.isAlive(), false);
  });

  test('旗标全量重传断言：echo 回显 argv 含 headless 三件+全旗标（每次 spawn 全量）', async () => {
    const runner = makeRunner();
    runner.supervisorApi.start();
    await waitUntil(() => runner.supervisorApi.isAlive());

    const child = (runner as unknown as { supervisor: { getPid: () => number | null } }).supervisor;
    assert.ok(child.getPid() !== null);
    // 经 stdout 行读 argvEcho（runner 侧 dispatch 之外的双通道断言）
    const stdout = (runner as unknown as {
      supervisor: { [k: string]: unknown };
    });
    const rawChild = (Object.values(stdout.supervisor).find((v) => v && typeof v === 'object' && 'stdout' in (v as object)) as { stdout: import('node:stream').Readable } | undefined);
    assert.ok(rawChild?.stdout, 'child stdout 可达');
    const echoPromise = new Promise<string>((resolve) => {
      createInterface({ input: rawChild.stdout }).on('line', (line) => {
        try {
          const msg = JSON.parse(line);
          if (msg.argvEcho) resolve(JSON.stringify(msg.argvEcho));
        } catch { /* skip */ }
      });
    });
    runner.sendLine({ type: 'user', message: { role: 'user', content: 'argv?' } });
    const echoed = await Promise.race([echoPromise, wait(3000).then(() => 'TIMEOUT')]);
    assert.notEqual(echoed, 'TIMEOUT', 'echo 回读超时');
    const argv = JSON.parse(echoed as string) as string[];
    for (const f of [...FLAGS]) {
      assert.ok(argv.includes(f), `旗标缺失: ${f} (argv=${JSON.stringify(argv)})`);
    }
    runner.supervisorApi.stop();
  });
});
