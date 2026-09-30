/**
 * Command Handler — deterministic command execution for cron job payloads.
 *
 * Design r1-1 §4.3: no LLM. A job fires → token replacement ({fromWeek}/
 * {toWeek}/{startDate}) → spawn bash → timeout → output capture → per-run log.
 *
 * runAs downgrade reuses the M1 session-bridge pattern: `runuser -u <user> --`
 * (fleet resolves to uid/gid 1001 via system accounts). Without runAs the
 * command runs as the process user (local development).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn, type SpawnOptions } from 'node:child_process';
import { computeWeekShiftTokens, type WeekShiftTokens } from './week-math.js';
import type { CronJob } from '@tricompany/agent-core';

/** Job payload contract (opaque in agent-core, validated here). */
export interface CommandJobPayload {
  command: string;
  cwd: string;
  /** Overrides DEFAULT_JOB_TIMEOUT_MS when > 0. */
  timeoutMs?: number;
  /** Username to downgrade to (e.g. "fleet"). Unset = process user. */
  runAs?: string;
}

/** Aligned with TriRLC cron DEFAULT_JOB_TIMEOUT_MS. */
export const DEFAULT_JOB_TIMEOUT_MS = 10 * 60 * 1000;

/** Error tail persisted to lastError / journal. */
const ERROR_TAIL_CHARS = 1000;

const WEEK_TOKEN_RE = /\{(fromWeek|toWeek|startDate)\}/g;

export interface CommandHandlerOptions {
  /** Per-run log directory (default: $TRIMC_CONFIG_DIR/cron/logs). */
  logDir: string;
  /** Spawn injection point (tests). */
  spawnFn?: typeof spawn;
  /** Disable file logging (tests). */
  logToFiles?: boolean;
}

export type CommandHandler = (job: CronJob) => Promise<void>;

interface CommandResult {
  code: number | null;
  out: string;
  err: string;
  timedOut: boolean;
}

export function createCommandHandler(options: CommandHandlerOptions): CommandHandler {
  const { logDir } = options;
  const spawnFn = options.spawnFn ?? spawn;
  const logToFiles = options.logToFiles ?? true;

  return async function handleCommandJob(job: CronJob): Promise<void> {
    const payload = job.payload as unknown as CommandJobPayload;
    if (
      !payload ||
      typeof payload.command !== 'string' ||
      payload.command.length === 0 ||
      typeof payload.cwd !== 'string' ||
      payload.cwd.length === 0
    ) {
      throw new Error('job payload requires string fields: command, cwd');
    }

    const tokens = computeWeekShiftTokens();
    const command = payload.command.replace(WEEK_TOKEN_RE, (match) => {
      const key = match.slice(1, -1) as keyof WeekShiftTokens;
      return tokens[key];
    });

    const timeoutMs =
      typeof payload.timeoutMs === 'number' && payload.timeoutMs > 0
        ? payload.timeoutMs
        : DEFAULT_JOB_TIMEOUT_MS;

    // runAs downgrade (M1 session-bridge pattern); unset = process user.
    const shell = '/bin/bash';
    const shellArgs = ['-e', '-c', command];
    const cmd = payload.runAs ? 'runuser' : shell;
    const cmdArgs = payload.runAs
      ? ['-u', payload.runAs, '--', shell, ...shellArgs]
      : shellArgs;

    const spawnOptions: SpawnOptions = {
      cwd: payload.cwd,
      env: {
        ...process.env,
        ...(payload.runAs ? { HOME: `/home/${payload.runAs}` } : {}),
      },
      // Detached so the whole process group (bash → python3 → git) dies on timeout.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    };

    const startedIso = new Date().toISOString();
    const result = await runWithTimeout(spawnFn, cmd, cmdArgs, spawnOptions, timeoutMs);

    const runStamp = startedIso.replace(/[:.]/g, '-');
    // `__` separates jobId from the timestamp (service.ts parses on it).
    const logPath = path.join(logDir, `${job.id}__${runStamp}.log`);
    const logText = buildLogText(job, command, payload, startedIso, timeoutMs, result);

    if (logToFiles) {
      await fs.mkdir(logDir, { recursive: true });
      await fs.writeFile(logPath, logText, { encoding: 'utf-8', mode: 0o600 });
    }
    console.log(`[trimc:cron] job ${job.name} (${job.id}) run finished, log: ${logPath}`);

    const failed = result.timedOut || result.code !== 0;
    if (failed) {
      const tail = (result.err || result.out || `exit ${result.code}`).slice(-ERROR_TAIL_CHARS);
      const message = result.timedOut
        ? `command timed out after ${timeoutMs}ms: ${tail}`
        : `command exited with code ${result.code}: ${tail}`;
      console.error(`[trimc:cron] job ${job.name} (${job.id}) failed: ${message.slice(0, 400)}`);
      throw new Error(message);
    }
  };
}

function runWithTimeout(
  spawnFn: typeof spawn,
  cmd: string,
  cmdArgs: string[],
  spawnOptions: SpawnOptions,
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawnFn(cmd, cmdArgs, spawnOptions);
    let out = '';
    let err = '';
    let settled = false;

    const settle = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      // Kill the whole process group; fall back to the child itself.
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
      settle({ code: null, out, err, timedOut: true });
    }, timeoutMs);

    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      err += d.toString();
    });
    child.on('error', (e) => {
      settle({ code: null, out, err: `${err}\nspawn error: ${e.message}`.trim(), timedOut: false });
    });
    child.on('close', (code) => {
      settle({ code, out, err, timedOut: false });
    });
  });
}

function buildLogText(
  job: CronJob,
  command: string,
  payload: CommandJobPayload,
  startedIso: string,
  timeoutMs: number,
  result: CommandResult,
): string {
  return [
    `job: ${job.name} (${job.id})`,
    `startedAt: ${startedIso}`,
    `timeoutMs: ${timeoutMs}`,
    `cwd: ${payload.cwd}`,
    `runAs: ${payload.runAs ?? '(process user)'}`,
    `command: ${command}`,
    '',
    '── stdout ──',
    result.out || '(no stdout)',
    '',
    '── stderr ──',
    result.err || '(no stderr)',
    '',
    result.timedOut
      ? `RESULT: timeout (${timeoutMs}ms)`
      : `RESULT: exit code ${result.code ?? '(spawn error)'}`,
  ].join('\n');
}
