/**
 * Cron Service — TriMMC service-domain assembly over the shared agent-core scheduler.
 *
 * Reuses @tricompany/agent-core JobExecutor + job-store (cron loop, JSON
 * persistence, atomic writes). This adapter adds what the shared core
 * deliberately omits (r1-1 design §4.3):
 *   - stale-run recovery: on start(), any job left runningAtMs ≠ null by a
 *     crashed process is reset, otherwise it would be stuck running forever
 *   - degraded aggregation: consecutiveFailures = max over jobs
 *   - execution-log listing from per-run log files (no DB in the adapter)
 *
 * Behavioral baseline: TriRLC src/cron (runJob force semantics, timeout,
 * degraded threshold), NOT a code transplant (parity V1.1 §1).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  JobExecutor,
  loadJobStore,
  saveJobStore,
  buildJob,
  applyJobPatch,
  patchJobState,
  computeNextRunAtMs,
  type CronJob,
  type CronJobCreate,
  type CronJobPatch,
  type JobHandler,
  type JobExecutorOptions,
} from '@tricompany/agent-core';
import { createCommandHandler, type CommandHandlerOptions } from './command-handler.js';

/** Aligned with TriRLC CONSECUTIVE_FAILURE_DEGRADED_THRESHOLD. */
const DEGRADED_THRESHOLD = 3;

export type CronLogStatus = 'ok' | 'error' | 'timeout';

/** Execution log entry, aligned with TriRLC ExecutionLogEntry shape. */
export interface CronLogEntry {
  jobId: string;
  status: CronLogStatus;
  startedAt: string;
  /** log file mtime − startedAt; the file is written when the run ends. */
  durationMs: number | null;
  errorMessage: string | null;
}

export interface CronStatus {
  running: boolean;
  degraded: boolean;
  consecutiveFailures: number;
  jobCount: number;
}

export interface CronRunResult {
  ok: boolean;
  ran: boolean;
  reason?: string;
  jobId?: string;
}

export interface CronServiceOptions {
  /** Per-run log directory (from env; default $TRIMC_CONFIG_DIR/cron/logs). */
  logDir: string;
  /** Job handler; defaults to the deterministic command handler. */
  handler?: JobHandler;
  /** Executor tuning; defaults to agent-core (1s tick / 60s max delay). */
  executorOptions?: JobExecutorOptions;
}

export interface CronService {
  start(): Promise<void>;
  stop(): void;
  addJob(input: CronJobCreate): Promise<CronJob>;
  listJobs(): Promise<CronJob[]>;
  getJob(id: string): Promise<CronJob | null>;
  updateJob(id: string, patch: CronJobPatch): Promise<CronJob | null>;
  removeJob(id: string): Promise<boolean>;
  runJob(id: string, force?: boolean): Promise<CronRunResult>;
  getLogs(jobId?: string, limit?: number): Promise<CronLogEntry[]>;
  getStatus(): Promise<CronStatus>;
}

export function createCronService(options: CronServiceOptions): CronService {
  const handler = options.handler ?? createCommandHandler({ logDir: options.logDir });
  const executor = new JobExecutor(handler, options.executorOptions);
  const logDir = options.logDir;

  // ── helpers ──────────────────────────────────────────────────

  async function saveJobs(jobs: Record<string, CronJob>): Promise<void> {
    await saveJobStore(jobs);
  }

  // ── public API ───────────────────────────────────────────────

  return {
    async start(): Promise<void> {
      if (executor.isRunning) return;

      // Stale-run recovery: a crashed process leaves runningAtMs set forever.
      const jobs = await loadJobStore();
      let resetCount = 0;
      for (const job of Object.values(jobs)) {
        if (job.state.runningAtMs !== null) {
          jobs[job.id] = patchJobState(job, { runningAtMs: null });
          resetCount++;
        }
      }
      if (resetCount > 0) {
        await saveJobs(jobs);
        console.warn(`[trimc:cron] stale-run recovery: reset ${resetCount} job(s)`);
      }

      executor.start();
      const count = Object.keys(jobs).length;
      console.log(`[trimc:cron] service started with ${count} job(s)`);
    },

    stop(): void {
      executor.stop();
      console.log('[trimc:cron] service stopped');
    },

    async addJob(input: CronJobCreate): Promise<CronJob> {
      // Default enabled=true — an undefined enabled would read as disabled.
      const job = buildJob({ ...input, enabled: input.enabled !== false });
      const jobs = await loadJobStore();
      jobs[job.id] = job;
      await saveJobs(jobs);
      executor.tick();
      console.log(`[trimc:cron] job added: ${job.name} (${job.id})`);
      return job;
    },

    async listJobs(): Promise<CronJob[]> {
      const jobs = await loadJobStore();
      return Object.values(jobs).sort((a, b) => a.createdAtMs - b.createdAtMs);
    },

    async getJob(id: string): Promise<CronJob | null> {
      const jobs = await loadJobStore();
      return jobs[id] ?? null;
    },

    async updateJob(id: string, patch: CronJobPatch): Promise<CronJob | null> {
      const jobs = await loadJobStore();
      const job = jobs[id];
      if (!job) return null;
      jobs[id] = applyJobPatch(job, patch);
      await saveJobs(jobs);
      executor.tick();
      console.log(`[trimc:cron] job updated: ${jobs[id].name} (${id})`);
      return jobs[id];
    },

    async removeJob(id: string): Promise<boolean> {
      const jobs = await loadJobStore();
      if (!jobs[id]) return false;
      delete jobs[id];
      await saveJobs(jobs);
      executor.tick();
      console.log(`[trimc:cron] job removed: ${id}`);
      return true;
    },

    /**
     * Manual/forced run — semantics aligned with TriRLC runJobNow:
     * force overrides the disabled guard only; a running job is always
     * refused (single-instance guard for the migration window).
     */
    async runJob(id: string, force?: boolean): Promise<CronRunResult> {
      const jobs = await loadJobStore();
      const job = jobs[id];
      if (!job) return { ok: false, ran: false, reason: 'not-found' };
      if (!force && !job.enabled) return { ok: true, ran: false, reason: 'disabled' };
      if (job.state.runningAtMs !== null) return { ok: true, ran: false, reason: 'already-running' };

      const startedAt = Date.now();
      jobs[id] = patchJobState(job, { runningAtMs: startedAt, lastRunAtMs: startedAt });
      await saveJobs(jobs);

      let ok = false;
      let errorMsg: string | null = null;
      try {
        const result = handler(job);
        if (result instanceof Promise) await result;
        ok = true;
      } catch (err: unknown) {
        errorMsg = err instanceof Error ? err.message : String(err);
      }

      const endedAt = Date.now();
      const freshJobs = await loadJobStore();
      const fresh = freshJobs[id];
      if (!fresh) {
        return { ok: true, ran: true, reason: `job deleted during run (${ok ? 'ok' : 'error'})` };
      }

      const nextRun = computeNextRunAtMs(fresh.schedule, endedAt, fresh.staggerMs);
      freshJobs[id] = patchJobState(fresh, {
        runningAtMs: null,
        lastRunStatus: ok ? 'ok' : 'error',
        lastError: errorMsg,
        consecutiveErrors: ok ? 0 : fresh.state.consecutiveErrors + 1,
        lastDurationMs: endedAt - startedAt,
        runCount: fresh.state.runCount + 1,
        nextRunAtMs: nextRun,
      });
      await saveJobs(freshJobs);
      executor.tick();

      return {
        ok: true,
        ran: true,
        jobId: id,
        reason: ok ? 'status=ok' : `error: ${errorMsg ?? 'unknown'}`,
      };
    },

    /**
     * Execution log listing from per-run log files (<jobId>__<ISO stamp>.log),
     * newest first. No DB — files are the audit source (design §4.4).
     */
    async getLogs(jobId?: string, limit = 20): Promise<CronLogEntry[]> {
      let names: string[];
      try {
        names = await fs.readdir(logDir);
      } catch {
        return [];
      }
      names.sort();

      const entries: CronLogEntry[] = [];
      for (const name of names) {
        if (!name.endsWith('.log')) continue;
        const sep = name.indexOf('__');
        if (sep < 0) continue;
        const fileJobId = name.slice(0, sep);
        if (jobId && fileJobId !== jobId) continue;
        entries.push(await parseLogFile(logDir, name, fileJobId));
      }

      entries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      return entries.slice(0, Math.max(0, limit));
    },

    async getStatus(): Promise<CronStatus> {
      const jobs = await loadJobStore();
      const values = Object.values(jobs);
      let consecutiveFailures = 0;
      for (const job of values) {
        if (job.state.consecutiveErrors > consecutiveFailures) {
          consecutiveFailures = job.state.consecutiveErrors;
        }
      }
      return {
        running: executor.isRunning,
        degraded: consecutiveFailures >= DEGRADED_THRESHOLD,
        consecutiveFailures,
        jobCount: values.length,
      };
    },
  };
}

// ── log file parsing ───────────────────────────────────────────

async function parseLogFile(
  dir: string,
  name: string,
  jobId: string,
): Promise<CronLogEntry> {
  const filePath = path.join(dir, name);
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();

    const headBuf = Buffer.alloc(2048);
    const head = await handle.read(headBuf, 0, headBuf.length, 0);
    const headText = head.buffer.subarray(0, head.bytesRead).toString('utf-8');

    const tailBuf = Buffer.alloc(4096);
    const tail = await handle.read(
      tailBuf,
      0,
      tailBuf.length,
      Math.max(0, stat.size - tailBuf.length),
    );
    const tailText = tail.buffer.subarray(0, tail.bytesRead).toString('utf-8');

    const startedMatch = /^startedAt: (\S+)/m.exec(headText);
    const startedAt = startedMatch ? startedMatch[1] : new Date(stat.birthtimeMs).toISOString();

    let status: CronLogStatus = 'error';
    let errorMessage: string | null = null;
    const resultMatch = /RESULT: timeout|RESULT: exit code (\d+)|RESULT: \(spawn error\)/m.exec(tailText);
    if (resultMatch) {
      if (resultMatch[0].includes('timeout')) {
        status = 'timeout';
      } else if (resultMatch[0].includes('spawn error')) {
        status = 'error';
      } else {
        status = Number(resultMatch[1]) === 0 ? 'ok' : 'error';
      }
    }
    if (status !== 'ok') {
      const errMatch = /── stderr ──\n([\s\S]*?)\n\nRESULT:/m.exec(tailText);
      errorMessage = errMatch ? errMatch[1].trim().slice(-500) || null : null;
    }

    const durationMs = Number.isFinite(Date.parse(startedAt))
      ? Math.max(0, Math.round(stat.mtimeMs - Date.parse(startedAt)))
      : null;

    return { jobId, status, startedAt, durationMs, errorMessage };
  } catch {
    return { jobId, status: 'error', startedAt: '', durationMs: null, errorMessage: 'log unreadable' };
  } finally {
    await handle.close();
  }
}
