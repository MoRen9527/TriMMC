/**
 * Cron Routes — HTTP handlers for /internal/v1/cron/*.
 *
 * Behavioral baseline: TriRLC cron routes (POST jobs → 201, list {ok,jobs,count},
 * log {ok,logs,count}, status {ok,status}). Returns true when the request was
 * handled; false lets the app.ts if-chain continue (final 404).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CronJobCreate, CronJobPatch } from '@tricompany/agent-core';
import { validateCronExpression } from '@tricompany/agent-core';
import type { CronService } from './service.js';

const CRON_PREFIX = '/internal/v1/cron';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf-8');
  try {
    return raw.length > 0 ? JSON.parse(raw) : {};
  } catch {
    return undefined;
  }
}

/** Validate a CronJobCreate payload: command/cwd are required by the command handler. */
function validateCreateInput(body: Record<string, unknown>): string | null {
  if (!body.name || typeof body.name !== 'string') return 'name is required';
  if (!body.schedule || typeof body.schedule !== 'object') return 'schedule is required';
  const schedule = body.schedule as Record<string, unknown>;
  if (schedule.kind !== 'cron' && schedule.kind !== 'every' && schedule.kind !== 'at') {
    return 'schedule.kind must be one of: at, every, cron';
  }
  if (schedule.kind === 'cron') {
    if (typeof schedule.cron !== 'string') return 'schedule.cron is required';
    const invalid = validateCronExpression(schedule.cron);
    if (invalid) return `invalid cron expression: ${invalid}`;
  }
  if (schedule.kind === 'every' && typeof schedule.everyMs !== 'number') {
    return 'schedule.everyMs is required for every schedules';
  }
  if (schedule.kind === 'at' && typeof schedule.atMs !== 'number') {
    return 'schedule.atMs is required for at schedules';
  }
  const payload = body.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload.command !== 'string' || typeof payload.cwd !== 'string') {
    return 'payload.command and payload.cwd (strings) are required';
  }
  return null;
}

export type CronRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean>;

export function createCronRouteHandler(service: CronService): CronRouteHandler {
  return async function handleCronRoutes(req, res): Promise<boolean> {
    const url = req.url ?? '';
    if (!url.startsWith(CRON_PREFIX)) return false;
    const method = req.method ?? 'GET';

    const jobsRunMatch = /^\/internal\/v1\/cron\/jobs\/([^/]+)\/run$/.exec(url);
    const jobMatch = /^\/internal\/v1\/cron\/jobs\/([^/]+)$/.exec(url);

    // ── POST /internal/v1/cron/jobs/{id}/run ──
    if (jobsRunMatch && method === 'POST') {
      const body = (await readJsonBody(req)) as { force?: boolean } | undefined;
      if (body === undefined) {
        sendJson(res, 400, { ok: false, error: 'invalid_json' });
        return true;
      }
      const result = await service.runJob(decodeURIComponent(jobsRunMatch[1]), body.force === true);
      if (!result.ok) {
        sendJson(res, 404, { ok: false, error: result.reason ?? 'run_failed' });
        return true;
      }
      sendJson(res, 200, result);
      return true;
    }

    // ── POST /internal/v1/cron/jobs ──
    if (url === '/internal/v1/cron/jobs' && method === 'POST') {
      const body = (await readJsonBody(req)) as Record<string, unknown> | undefined;
      if (body === undefined) {
        sendJson(res, 400, { ok: false, error: 'invalid_json' });
        return true;
      }
      const invalid = validateCreateInput(body);
      if (invalid) {
        sendJson(res, 400, { ok: false, error: 'bad_request', message: invalid });
        return true;
      }
      const job = await service.addJob(body as unknown as CronJobCreate);
      sendJson(res, 201, { ok: true, job });
      return true;
    }

    // ── GET /internal/v1/cron/jobs ──
    if (url === '/internal/v1/cron/jobs' && method === 'GET') {
      const jobs = await service.listJobs();
      sendJson(res, 200, { ok: true, jobs, count: jobs.length });
      return true;
    }

    // ── PATCH /internal/v1/cron/jobs/{id} ──
    if (jobMatch && method === 'PATCH') {
      const body = (await readJsonBody(req)) as CronJobPatch | undefined;
      if (body === undefined) {
        sendJson(res, 400, { ok: false, error: 'invalid_json' });
        return true;
      }
      const job = await service.updateJob(decodeURIComponent(jobMatch[1]), body);
      if (!job) {
        sendJson(res, 404, { ok: false, error: 'job_not_found' });
        return true;
      }
      sendJson(res, 200, { ok: true, job });
      return true;
    }

    // ── DELETE /internal/v1/cron/jobs/{id} ──
    if (jobMatch && method === 'DELETE') {
      const removed = await service.removeJob(decodeURIComponent(jobMatch[1]));
      if (!removed) {
        sendJson(res, 404, { ok: false, error: 'job_not_found' });
        return true;
      }
      sendJson(res, 200, { ok: true, removed: true });
      return true;
    }

    // ── GET /internal/v1/cron/log ──
    if (url.startsWith('/internal/v1/cron/log') && method === 'GET') {
      const urlObj = new URL(url, `http://${req.headers.host ?? 'localhost'}`);
      const jobId = urlObj.searchParams.get('jobId') ?? undefined;
      const limit = parseInt(urlObj.searchParams.get('limit') ?? '20', 10);
      const logs = await service.getLogs(jobId, Number.isFinite(limit) ? limit : 20);
      sendJson(res, 200, { ok: true, logs, count: logs.length });
      return true;
    }

    // ── GET /internal/v1/cron/status ──
    if (url === '/internal/v1/cron/status' && method === 'GET') {
      const status = await service.getStatus();
      sendJson(res, 200, { ok: true, status });
      return true;
    }

    return false;
  };
}
