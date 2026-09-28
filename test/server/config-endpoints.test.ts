// ── LG-058 P1 config 端点真链路（HTTP 层，MMC 服务域面）──
//
// STE 纪律（09-15 第三次命中教训）：新端点必配真链路案——单测直调四函数
// 不覆盖 app.ts 路由注册/URL 拼写/门集成，此处以 createTriMCApp 真实
// HTTP 全链路补位。mock TriModel 上游随 boot pull 自然进食。
// 形态对标 TriRLC/TriMLC config-endpoints.test.ts（P0 真链路族）。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTriMCApp } from '../../src/server/app.js';
import { readEnv } from '../../src/config/env.js';
import { stopKeyCache } from '../../src/config/key-cache.js';
import { resetAppliedCacheForTest } from '../../src/config-sync/status.js';
import { resetModelCacheForTest } from '../../src/config-sync/default-model.js';

const SAVED_ENV: Record<string, string | undefined> = {};

let tmpConfigDir: string;
let app: ReturnType<typeof createTriMCApp>;
let mock: Server;
let mockPort: number;

const TOKEN = 'trimc-config-e2e-token';

before(async () => {
  for (const k of [
    'TRIMC_CONFIG_DIR', 'TRIMC_PORT', 'TRIMC_TRIMODEL_API_URL', 'TRIMC_INTERNAL_TOKEN',
    'TRIMC_DEFAULT_MODEL', 'TRIMODEL_API_TOKEN', 'TRIMODEL_KEY_STORAGE_MODE',
    'TRIMODEL_ADMIN_TOKEN', 'TRIMODEL_FACE_ID', 'TRIMC_FLEET_ROOT',
    'TRIMC_NOTIFY_DUTY_SEATS', 'TRIMC_CRON_ENABLED',
  ]) {
    SAVED_ENV[k] = process.env[k];
  }

  tmpConfigDir = mkdtempSync(join(tmpdir(), 'trimc-config-e2e-'));
  process.env.TRIMC_CONFIG_DIR = tmpConfigDir;
  process.env.TRIMC_FLEET_ROOT = tmpConfigDir; // bundle 探测隔离（无 fleet 工作树）
  process.env.TRIMC_CRON_ENABLED = 'false';
  delete process.env.TRIMC_NOTIFY_DUTY_SEATS;
  delete process.env.TRIMC_DEFAULT_MODEL;
  process.env.TRIMODEL_KEY_STORAGE_MODE = 's3'; // 明文沙箱模式
  delete process.env.TRIMODEL_ADMIN_TOKEN;
  delete process.env.TRIMODEL_API_TOKEN;
  delete process.env.TRIMODEL_FACE_ID; // face 默认 'mmc'

  // mock TriModel 上游：pull 卡面 + status 回写面
  mock = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    if (url.pathname === '/v1/config/cards/mmc' && url.searchParams.get('view') === 'pull') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        object: 'config.card-pull', face: 'mmc', card_present: true,
        default_model: 'deepseek-v4-pro',
        entries: {
          e1: { provider: 'deepseek', model: 'deepseek-v4-pro', api_key: 'sk-e2e-1', enabled: true, updated_at: '2026-09-29T01:00:00Z' },
          e3: { provider: 'anthropic', model: 'claude-fallback', api_key: 'sk-e2e-3', enabled: true, updated_at: '2026-09-29T01:30:00Z', base_url: 'https://anthropic.example' },
        },
        strategy: null,
        refresh_interval_s: 900,
      }));
      return;
    }
    if (url.pathname === '/v1/config/cards/mmc/status' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
  mockPort = (mock.address() as { port: number }).port;

  process.env.TRIMC_TRIMODEL_API_URL = `http://127.0.0.1:${mockPort}`;
  process.env.TRIMC_INTERNAL_TOKEN = TOKEN;

  const env = { ...readEnv(), port: 0, cronEnabled: false };
  app = createTriMCApp(env);
  await app.start();
});

after(async () => {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { await app.stop(); } catch { /* swallow */ }
  stopKeyCache();
  resetModelCacheForTest();
  resetAppliedCacheForTest();
  await new Promise<void>((resolve) => mock.close(() => resolve()));
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(tmpConfigDir, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
});

async function request(method: string, path: string, withToken: boolean): Promise<{ status: number; json: any }> {
  const res = await fetch(`${'http://127.0.0.1'}:${(app as { port: number }).port}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(withToken ? { 'x-internal-token': TOKEN } : {}),
    },
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* keep null */ }
  return { status: res.status, json };
}

describe('LG-058 P1 config 端点真链路（MMC HTTP 层）', () => {
  it('内部门：config 五路由无 token 全 401（token 配置态=校验生效）', async () => {
    const cases: Array<[string, string]> = [
      ['POST', '/internal/v1/config/pull'],
      ['GET', '/internal/v1/config/show'],
      ['POST', '/internal/v1/config/verify'],
      ['GET', '/internal/v1/config/cache'],
      ['DELETE', '/internal/v1/config/cache'],
    ];
    for (const [method, path] of cases) {
      const { status, json } = await request(method, path, false);
      assert.equal(status, 401, `${method} ${path} 应 401`);
      assert.ok(String(json?.error ?? '').startsWith('unauthorized'), `${method} ${path} 错误码应 unauthorized 族`);
    }
  });

  it('boot pull 落 cache：show=tier2-cache-fresh + ladder=card-fresh + providers 读数', async () => {
    const { status, json } = await request('GET', '/internal/v1/config/show', true);
    assert.equal(status, 200);
    assert.equal(json.object, 'config.show');
    assert.equal(json.face, 'mmc');
    assert.equal(json.hasCache, true);
    assert.equal(json.fresh, true);
    assert.equal(json.effectiveSource, 'tier2-cache-fresh');
    assert.equal(json.effectiveModel, 'deepseek-v4-pro');
    assert.equal(json.providerCount, 2);
    assert.equal(json.refreshIntervalS, 900);
    assert.ok(json.lastFetchAt > 0);
    // §4.3 全梯投影（服务域面扩展字段）：卡面 fresh 接管（无 bundle 无 env）
    assert.equal(json.ladder.source, 'card-fresh');
    assert.equal(json.ladder.model, 'deepseek-v4-pro');
  });

  it('POST pull 即时生效：mode=full + tier1-card 归因', async () => {
    const { status, json } = await request('POST', '/internal/v1/config/pull', true);
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.mode, 'full');
    assert.equal(json.source, 'tier1-card');
    assert.equal(json.defaultModel, 'deepseek-v4-pro');
  });

  it('POST verify 三查全 ok：connectivity/credentials/decrypt + card_present', async () => {
    const { status, json } = await request('POST', '/internal/v1/config/verify', true);
    assert.equal(status, 200);
    assert.equal(json.object, 'config.verify');
    assert.equal(json.ok, true);
    assert.equal(json.connectivity, 'ok');
    assert.equal(json.credentials, 'ok');
    assert.equal(json.decryptHealth, 'ok');
    assert.equal(json.cardPresent, true);
    assert.equal(json.providers, 2);
  });

  it('GET cache 读数面 = describeConfig 投影', async () => {
    const { status, json } = await request('GET', '/internal/v1/config/cache', true);
    assert.equal(status, 200);
    assert.equal(json.object, 'config.cache');
    assert.equal(json.hasCache, true);
  });

  it('DELETE cache 双清+回梯底：cleared 后 show=tier3-env + ladder=constant', async () => {
    const del = await request('DELETE', '/internal/v1/config/cache', true);
    assert.equal(del.status, 200);
    assert.equal(del.json.object, 'config.cache-cleared');
    assert.equal(del.json.cleared, true);
    assert.equal(del.json.hadCache, true);
    assert.ok(del.json.removedFiles.length >= 1, '至少清掉 canonical 载体');

    const show = await request('GET', '/internal/v1/config/show', true);
    assert.equal(show.status, 200);
    assert.equal(show.json.hasCache, false);
    assert.equal(show.json.effectiveSource, 'tier3-env');
    // §4.3 梯底：无卡无 bundle（沙箱）→ 兜底常量
    assert.equal(show.json.ladder.source, 'constant');
    assert.equal(show.json.ladder.model, 'deepseek-v4-pro');
  });
});
