/**
 * app-sync-status smoke — real createTriMMCApp assembly（i4-2 §三.3）：
 * GET /internal/v1/config/sync/status inline 路由挂载 + 磁盘真源读取。
 * TRIMC_CONFIG_DIR / TRIMC_FLEET_ROOT 指向临时目录隔离（生产 env 不可达）。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { overrideConfigDir, resetConfigDir, invalidateJobStoreCache } from '@tricompany/agent-core';
import { createTriMMCApp } from '../../src/server/app.js';
import { readEnv, type TriMMCEnv } from '../../src/config/env.js';
import { resetAppliedCacheForTest } from '../../src/config-sync/status.js';

const originalFetch = globalThis.fetch;

describe('TriMMC app config-sync status assembly', () => {
  let app: { start(): Promise<void>; stop(): Promise<void>; port: number };
  let tmpConfigDir: string;
  let tmpFleetRoot: string;
  let baseUrl: string;
  const prevConfigDir = process.env.TRIMC_CONFIG_DIR;
  const prevFleetRoot = process.env.TRIMC_FLEET_ROOT;

  before(async () => {
    tmpConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trimc-app-sync-'));
    tmpFleetRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'trimc-fleet-sync-'));
    process.env.TRIMC_CONFIG_DIR = tmpConfigDir;
    process.env.TRIMC_FLEET_ROOT = tmpFleetRoot;
    overrideConfigDir(tmpConfigDir);
    invalidateJobStoreCache();
    resetAppliedCacheForTest();

    const env: TriMMCEnv = { ...readEnv(), port: 0, cronEnabled: false };
    app = createTriMMCApp(env);
    await app.start();
    baseUrl = `http://127.0.0.1:${app.port}`;
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await app.stop();
    resetConfigDir();
    invalidateJobStoreCache();
    resetAppliedCacheForTest();
    if (prevConfigDir === undefined) delete process.env.TRIMC_CONFIG_DIR;
    else process.env.TRIMC_CONFIG_DIR = prevConfigDir;
    if (prevFleetRoot === undefined) delete process.env.TRIMC_FLEET_ROOT;
    else process.env.TRIMC_FLEET_ROOT = prevFleetRoot;
  });

  it('空态 status → 200 { ok:true, applied/fleetHead/dims/pending 全 null }', async () => {
    const res = await fetch(`${baseUrl}/internal/v1/config/sync/status`);
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean; applied: unknown; fleetHead: unknown; pending: unknown; warnings: unknown[] };
    assert.equal(body.ok, true);
    assert.equal(body.applied, null);
    assert.equal(body.fleetHead, null);
    assert.equal(body.pending, null);
    assert.deepEqual(body.warnings, []);
  });

  it('applied 落盘后 status 呈现 applied 摘要 + pending 版本差', async () => {
    const dir = path.join(tmpConfigDir, 'init-sync');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'applied.json'),
      JSON.stringify({
        schemaVersion: 1,
        bundleId: 'bundle-old',
        generatedAt: '2026-08-13T10:00:00.000Z',
        contentHash: 'hash-old',
        sourceInstanceId: 'trilc-init-0.9.0@a1b2c3d4',
        lastAppliedAt: '2026-08-13T10:05:00.000Z',
        dims: { company: 'applied', model: 'applied', keys: 'applied', employees: 'warning', project: 'applied' },
      }),
      'utf-8',
    );
    const bundleDir = path.join(tmpFleetRoot, 'TriMetaverse', 'docs', 'registry', 'init-sync');
    await fs.mkdir(bundleDir, { recursive: true });
    await fs.writeFile(
      path.join(bundleDir, 'sync-config.json'),
      JSON.stringify({
        schemaVersion: 1,
        bundleId: 'bundle-new',
        generatedAt: '2026-08-14T10:00:00.000Z',
        generatedBy: 'trilc-init-0.9.0@a1b2c3d4',
        company: { state: 'initialized', ceoName: 'MoRen', onboardedAt: '2026-08-14T09:00:00.000Z' },
        model: { defaultModel: 'tmv-deepseek-v4-pro', catalog: [], providers: [] },
        keys: { providers: [], refreshIntervalS: 900, fetchedAt: '2026-08-14T09:59:00.000Z' },
        employees: { roster: [], sourceCommit: '1111111111111111111111111111111111111111' },
        project: { projectKey: 'trimetaverse', repoUrl: 'https://x', defaultBranch: 'dev', worktrees: [], devHead: '2222222222222222222222222222222222222222' },
      }),
      'utf-8',
    );
    const res = await fetch(`${baseUrl}/internal/v1/config/sync/status`);
    const body = await res.json() as { applied: { bundleId: string } | null; dims: Record<string, string> | null; pending: { bundleId: string } | null };
    assert.equal(body.applied?.bundleId, 'bundle-old');
    assert.equal(body.dims?.employees, 'warning');
    assert.equal(body.pending?.bundleId, 'bundle-new');
  });

  it('非 GET 方法 → 404（路由仅 GET）', async () => {
    const res = await fetch(`${baseUrl}/internal/v1/config/sync/status`, { method: 'POST' });
    assert.equal(res.status, 404);
  });
});
