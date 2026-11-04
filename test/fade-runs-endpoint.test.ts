/**
 * fade runs endpoint wiring — real createTriMMCApp assembly (LG-092 工序 2):
 * 统一 token 门覆盖 /internal/v1/fade/runs + 端点壳契约（401/400/200 形）。
 * fade 模块单测归随搬件（fade-store/state-machine/closing-gate/driver/
 * recovery/skill-loader）；本件只验 app 挂接面（TriMLC fade-boot-wiring 的
 * TriMMC 适配替代形——TriMMC app/env 形不同案）。
 * 驱动深度边界：壳断言不锁定 finalState 值（真驱动面=TriMLC 在役 daemon E2E
 * + 工序 3 sg 活体验证·CTO 门禁「新增零红+既有不扩散」壳面判据）。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createTriMMCApp } from '../src/server/app.js';
import { readEnv, type TriMMCEnv } from '../src/config/env.js';

const originalFetch = globalThis.fetch;

describe('fade runs endpoint wiring (in-process app)', () => {
  let app: { start(): Promise<void>; stop(): Promise<void>; port: number };
  let tmpDir: string;
  let baseUrl: string;
  const envKeys = ['TRIMC_INTERNAL_TOKEN', 'TRIMC_CONFIG_DIR', 'TRIMMC_TRI_SKILL_ROOT'];
  const savedEnv: Record<string, string | undefined> = {};
  const TOKEN = 'test-token-fade-0123456789abcdef';

  const authFetch = (url: string, init?: RequestInit) =>
    originalFetch(url, { ...init, headers: { ...init?.headers, 'x-internal-token': TOKEN } });

  before(async () => {
    for (const k of envKeys) savedEnv[k] = process.env[k];
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trimmc-fade-runs-'));
    process.env.TRIMC_INTERNAL_TOKEN = TOKEN;
    process.env.TRIMC_CONFIG_DIR = tmpDir; // fade.db 落位（boot 链运行时读）
    delete process.env.TRIMMC_TRI_SKILL_ROOT; // 缺省 scriptDir 解析形
    const env: TriMMCEnv = { ...readEnv(), port: 0 };
    app = createTriMMCApp(env);
    await app.start();
    baseUrl = `http://127.0.0.1:${app.port}`;
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await app.stop();
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('fade/runs sits behind the unified internal token gate (401 without token)', async () => {
    const res = await originalFetch(`${baseUrl}/internal/v1/fade/runs`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(res.status, 401);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.error, 'unauthorized: missing or invalid X-Internal-Token');
  });

  it('400 runId_required on missing runId', async () => {
    const res = await authFetch(`${baseUrl}/internal/v1/fade/runs`, {
      method: 'POST',
      body: JSON.stringify({ treeDir: '/tmp/whatever' }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.error, 'runId_required');
  });

  it('400 treeDir_required on missing treeDir', async () => {
    const res = await authFetch(`${baseUrl}/internal/v1/fade/runs`, {
      method: 'POST',
      body: JSON.stringify({ runId: 'wire-400' }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.error, 'treeDir_required');
  });

  it('200 fade.run envelope on valid body (drive fail-soft · terminal state not locked)', async () => {
    const res = await authFetch(`${baseUrl}/internal/v1/fade/runs`, {
      method: 'POST',
      body: JSON.stringify({ runId: 'wire-smoke-1', treeDir: path.join(tmpDir, 'tree') }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.object, 'fade.run');
    assert.equal(body.created, true);
    assert.ok(typeof body.finalState === 'string', `finalState missing: ${JSON.stringify(body)}`);
    assert.ok(typeof body.gated === 'boolean', `gated missing: ${JSON.stringify(body)}`);
  });
});
