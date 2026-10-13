// ── LG-058 P1 §4.3 层级合并裁全梯走查（MMC 服务域面）──
// 四级解析 resolveDefaultModelDetailed：env 逃生门 > 卡面 cache（fresh）>
// fleet bundle（applied model.json）> 兜底常量。真实 mock 卡面拉取进食 +
// 沙箱 TRIMC_CONFIG_DIR 落 bundle——四梯位逐级验证接管序。
// card-stale-grace 梯位由 key-cache.test.ts 单测族覆盖（内部 expiresAt 不可
// 时间旅行，本文件不重复）；bundle 读取 mtime 轻缓存经 resetModelCacheForTest 清。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveDefaultModelDetailed,
  DEFAULT_MODEL_FALLBACK,
  resetModelCacheForTest,
} from '../../src/config-sync/default-model.js';
import { initKeyCache, stopKeyCache } from '../../src/config/key-cache.js';
import { resetAppliedCacheForTest, dimFilePath } from '../../src/config-sync/status.js';

const SAVED_ENV: Record<string, string | undefined> = {};
const PIN_KEYS = [
  'TRIMC_CONFIG_DIR', 'TRIMC_DEFAULT_MODEL', 'TRIMODEL_KEY_STORAGE_MODE',
  'TRIMODEL_ADMIN_TOKEN', 'TRIMODEL_API_TOKEN', 'TRIMODEL_FACE_ID',
];

let tmpConfigDir: string;
let mock: Server;
let mockPort: number;

before(async () => {
  for (const k of PIN_KEYS) SAVED_ENV[k] = process.env[k];
  tmpConfigDir = mkdtempSync(join(tmpdir(), 'trimc-ladder-'));
  process.env.TRIMC_CONFIG_DIR = tmpConfigDir;
  delete process.env.TRIMC_DEFAULT_MODEL;
  process.env.TRIMODEL_KEY_STORAGE_MODE = 's3'; // 明文沙箱模式
  delete process.env.TRIMODEL_ADMIN_TOKEN;
  delete process.env.TRIMODEL_API_TOKEN;
  delete process.env.TRIMODEL_FACE_ID;

  mock = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    if (url.pathname === '/v1/config/cards/mmc' && url.searchParams.get('view') === 'pull') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        object: 'config.card-pull', face: 'mmc', card_present: true,
        default_model: 'tmv-card-ladder-model', entries: {}, strategy: null,
        refresh_interval_s: 900,
      }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
  mockPort = (mock.address() as { port: number }).port;
});

after(async () => {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
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

describe('LG-058 P1 §4.3 default model ladder（MMC）', () => {
  it('tier1 card-fresh：卡面 cache 压 bundle/常量（活配置压基座）', async () => {
    await initKeyCache(`http://127.0.0.1:${mockPort}`, tmpConfigDir);
    const r = await resolveDefaultModelDetailed();
    assert.equal(r.model, 'tmv-card-ladder-model');
    assert.equal(r.source, 'card-fresh');
  });

  it('tier0 env-escape：TRIMC_DEFAULT_MODEL 显式覆盖压卡面（运维逃生门最高）', async () => {
    process.env.TRIMC_DEFAULT_MODEL = 'ops-override-model';
    try {
      const r = await resolveDefaultModelDetailed();
      assert.equal(r.model, 'ops-override-model');
      assert.equal(r.source, 'env-escape');
    } finally {
      delete process.env.TRIMC_DEFAULT_MODEL;
    }
  });

  it('tier2b fleet-bundle：cache 清除后 applied model.defaultModel 接管', async () => {
    stopKeyCache(); // 卡面 cache 退场（>7d 丢弃语义终点同形）
    mkdirSync(join(tmpConfigDir, 'init-sync'), { recursive: true });
    writeFileSync(dimFilePath(tmpConfigDir, 'model'), JSON.stringify({
      defaultModel: 'bundle-ladder-model',
      catalog: [{ id: 'bundle-ladder-model', provider: 'deepseek' }],
    }));
    resetModelCacheForTest(); // bundle mtime 轻缓存清（换帧读取）
    const r = await resolveDefaultModelDetailed();
    assert.equal(r.model, 'bundle-ladder-model');
    assert.equal(r.source, 'fleet-bundle');
  });

  it('tier3 constant：无卡无 bundle 落兜底常量（与现状零回归锚）', async () => {
    const modelPath = dimFilePath(tmpConfigDir, 'model');
    if (existsSync(modelPath)) rmSync(modelPath);
    resetModelCacheForTest();
    const r = await resolveDefaultModelDetailed();
    assert.equal(r.model, DEFAULT_MODEL_FALLBACK);
    assert.equal(r.source, 'constant');
  });
});
