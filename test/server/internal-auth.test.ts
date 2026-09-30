/**
 * internal-auth tests — P0 加固（2026-08-25）：/internal/* token 鉴权门。
 * 真实 createTriMCApp 装配；TRIMC_INTERNAL_TOKEN 动态切换验证四种形态。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { overrideConfigDir, resetConfigDir, invalidateJobStoreCache } from '@tricompany/agent-core';
import { createTriMMCApp } from '../../src/server/app.js';
import { readEnv, type TriMMCEnv } from '../../src/config/env.js';

const TOKEN = 'test-token-0123456789abcdef';

describe('TriMMC /internal token auth gate', () => {
  let app: { start(): Promise<void>; stop(): Promise<void>; port: number };
  let tmpConfigDir: string;
  let baseUrl: string;
  const prevConfigDir = process.env.TRIMC_CONFIG_DIR;
  const prevToken = process.env.TRIMC_INTERNAL_TOKEN;

  before(async () => {
    tmpConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trimc-auth-'));
    process.env.TRIMC_CONFIG_DIR = tmpConfigDir;
    overrideConfigDir(tmpConfigDir);
    invalidateJobStoreCache();
    const env: TriMMCEnv = { ...readEnv(), port: 0, cronEnabled: false };
    app = createTriMMCApp(env);
    await app.start();
    baseUrl = `http://127.0.0.1:${app.port}`;
  });

  after(async () => {
    await app.stop();
    resetConfigDir();
    invalidateJobStoreCache();
    if (prevConfigDir === undefined) delete process.env.TRIMC_CONFIG_DIR;
    else process.env.TRIMC_CONFIG_DIR = prevConfigDir;
    if (prevToken === undefined) delete process.env.TRIMC_INTERNAL_TOKEN;
    else process.env.TRIMC_INTERNAL_TOKEN = prevToken;
  });

  it('token 配置后：缺头 → 401', async () => {
    process.env.TRIMC_INTERNAL_TOKEN = TOKEN;
    const res = await fetch(`${baseUrl}/internal/v1/config/sync/status`);
    assert.equal(res.status, 401);
  });

  it('token 配置后：错头 → 401', async () => {
    process.env.TRIMC_INTERNAL_TOKEN = TOKEN;
    const res = await fetch(`${baseUrl}/internal/v1/config/sync/status`, {
      headers: { 'x-internal-token': 'wrong-token' },
    });
    assert.equal(res.status, 401);
  });

  it('token 配置后：对头（X-Internal-Token）→ 放行', async () => {
    process.env.TRIMC_INTERNAL_TOKEN = TOKEN;
    const res = await fetch(`${baseUrl}/internal/v1/config/sync/status`, {
      headers: { 'x-internal-token': TOKEN },
    });
    assert.equal(res.status, 200);
  });

  it('token 配置后：Bearer 形态同样放行；healthz 保持公开', async () => {
    process.env.TRIMC_INTERNAL_TOKEN = TOKEN;
    const bearer = await fetch(`${baseUrl}/internal/v1/config/sync/status`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(bearer.status, 200);
    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);
  });

  it('token 未配置：旧行为放行（兼容未迁移调用方）', async () => {
    delete process.env.TRIMC_INTERNAL_TOKEN;
    const res = await fetch(`${baseUrl}/internal/v1/config/sync/status`);
    assert.equal(res.status, 200);
  });
});
