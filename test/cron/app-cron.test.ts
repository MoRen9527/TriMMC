/**
 * app-cron smoke — real createTriMMCApp assembly:
 * healthz cron block + cron routes wired into the server if-chain + lifecycle.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { overrideConfigDir, resetConfigDir, invalidateJobStoreCache } from '@tricompany/agent-core';
import { createTriMMCApp } from '../../src/server/app.js';
import { readEnv, type TriMMCEnv } from '../../src/config/env.js';

const originalFetch = globalThis.fetch;

describe('TriMMC app cron assembly', () => {
  let app: { start(): Promise<void>; stop(): Promise<void>; port: number };
  let tmpDir: string;
  let baseUrl: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trimc-app-cron-'));
    overrideConfigDir(tmpDir);
    invalidateJobStoreCache();

    const env: TriMMCEnv = { ...readEnv(), port: 0 };
    app = createTriMMCApp(env);
    await app.start();
    baseUrl = `http://127.0.0.1:${app.port}`;
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await app.stop();
    resetConfigDir();
    invalidateJobStoreCache();
  });

  it('healthz exposes the cron block', async () => {
    const res = await originalFetch(`${baseUrl}/healthz`);
    const body = (await res.json()) as Record<string, unknown>;
    const cron = body.cron as Record<string, unknown>;
    assert.equal(cron.enabled, true, 'cron service should start with the app');
    assert.equal(cron.jobCount, 0);
    assert.equal(cron.degraded, false);
    assert.equal(cron.consecutiveFailures, 0);
  });

  it('cron job lifecycle works through the assembled app', async () => {
    const created = await originalFetch(`${baseUrl}/internal/v1/cron/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'smoke-job',
        schedule: { kind: 'at', atMs: 4_000_000_000_000 },
        payload: { command: 'echo smoke', cwd: '/tmp' },
      }),
    });
    assert.equal(created.status, 201);
    const job = ((await created.json()) as { job: { id: string } }).job;

    const list = await (await originalFetch(`${baseUrl}/internal/v1/cron/jobs`)).json();
    assert.equal((list as { count: number }).count, 1);

    const status = await (
      await originalFetch(`${baseUrl}/internal/v1/cron/status`)
    ).json();
    assert.equal((status as { status: { jobCount: number } }).status.jobCount, 1);

    const removed = await originalFetch(`${baseUrl}/internal/v1/cron/jobs/${job.id}`, {
      method: 'DELETE',
    });
    assert.equal(removed.status, 200);
  });

  it('healthz cron.jobCount reflects persisted jobs after app restart', async () => {
    // Persist a job, restart the app, confirm the store survives.
    await originalFetch(`${baseUrl}/internal/v1/cron/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'persist-job',
        schedule: { kind: 'at', atMs: 4_000_000_000_000 },
        payload: { command: 'echo persist', cwd: '/tmp' },
      }),
    });

    await app.stop();
    const env: TriMMCEnv = { ...readEnv(), port: 0 };
    app = createTriMMCApp(env);
    await app.start();
    baseUrl = `http://127.0.0.1:${app.port}`;

    const res = await originalFetch(`${baseUrl}/healthz`);
    const cron = ((await res.json()) as { cron: { jobCount: number } }).cron;
    assert.equal(cron.jobCount, 1, 'job store persists across restarts');
  });
});
