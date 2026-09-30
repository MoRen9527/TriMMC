#!/usr/bin/env node
/**
 * trimc CLI — cron 子命令（行为对标 trilc cron CLI：add/list/update/remove/run/log/status）。
 *
 * 服务地址默认 http://127.0.0.1:8712（TRIMC_URL 可覆盖；2026-09-30 8710→8712+loopback
 * 迁移窗随批——8710 公网面退役，loopback 端口正名 8712）。
 * `trimc cron add --plane-shift` 一键安装周平面迁移五段链 job（r1-1 方案 §5.1 模板）。
 */

import type { CronJobPatch } from '@tricompany/agent-core';
// TASK-TRIMODEL-RECOVERY-LADDER-01 波③：TriModel 直连恢复梯命令族（core=TriCode trimodel-cli，
// 本 bin 只做 CoreIO 注入+runCli 派发——core 零仓感知，仓特有项在此注入）。
import { defaultL2FlagPath, makeCoreIO, runCli, type ProbeReading } from '@trimetaverse/tricode/trimodel-cli';
import { runConfigSyncApply } from './config-sync/apply.js';
import { resolveInternalToken } from './internal-token.js';

// ── service address ─────────────────────────────────────────────

function serviceUrl(): string {
  return process.env.TRIMC_URL ?? 'http://127.0.0.1:8712';
}

// ── HTTP client ─────────────────────────────────────────────────

async function cronRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  const url = `${serviceUrl()}${path}`;
  const token = resolveInternalToken();
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'X-Internal-Token': token } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`ERROR: cannot reach trimc server at ${serviceUrl()} (${msg})`);
    process.exit(1);
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const err =
      json && typeof json.error === 'string' ? json.error : `HTTP ${res.status}`;
    const detail = json && typeof json.message === 'string' ? `: ${json.message}` : '';
    if (res.status === 401 && !token) {
      console.error(
        'HINT: TRIMC_INTERNAL_TOKEN 未配置（env 或 <TriMC 仓>/docker/.env 同名键），/internal/* 调用被 401 拒绝。',
      );
    }
    throw new Error(`${err}${detail}`);
  }
  return json;
}

// ── plane-shift preset ──────────────────────────────────────────

/**
 * r1-1 方案 §5.1 命令模板 + §6.2 预设参数。
 * Token {fromWeek}/{toWeek}/{startDate} 由服务器端 command-handler 替换。
 */
const PLANE_SHIFT_PRESET = {
  name: 'weekly-plane-shift',
  schedule: { kind: 'cron' as const, cron: '59 23 * * 0', timezone: 'Asia/Shanghai' }, // 2026-08-25 对齐现役 job（原 0 23 漂移已销账）
  payload: {
    command: [
      // python3.8 显式指定：服务器系统 Python 3.6.8 不支持
      // `from __future__ import annotations`（r1-2 checklist #2 实测，
      // 按 CTO 三级预案定案 A'：dnf module install python38）。
      'cd /srv/fleet/TriCompany && python3.8 -m runtime.cognition.weekly_plane_shift \\',
      '  --from {fromWeek} --to {toWeek} --start-date {startDate} \\',
      '  --operating-root /srv/fleet/TriMetaverse/docs/workflow/operating-records --sync \\',
      '&& cd /srv/fleet/TriMetaverse \\',
      '&& git add docs/workflow/operating-records \\',
      '&& (git diff --cached --quiet || git -c user.name="TriMC Scheduler" -c user.email="trimc@tri.company" \\',
      '     commit -m "ops: weekly plane shift {fromWeek}->{toWeek} (TriMC scheduler)") \\',
      // 夜航01 任务1③（2026-09-14）：push 被拒（非快进）→再拉取→merge 归账→重推。
      // 台账锚：lg033-pool-sync-runbook §2.4（双向冲突 merge-only，禁跨 hub rebase 已推提交）。
      // merge 冲突则整链非零失败暴露→人工裁决线；不 force。
      '&& (git push /srv/git/TriMetaverse.git HEAD:dev \\',
      '    || (git fetch /srv/git/TriMetaverse.git dev \\',
      '        && git merge --no-edit FETCH_HEAD \\',
      '        && git push /srv/git/TriMetaverse.git HEAD:dev))',
    ].join('\n'),
    cwd: '/srv/fleet',
    runAs: 'fleet',
  },
};

// ── config-sync-apply preset（i4-2 §三.2）───────────────────────

/**
 * 五维同步接收侧 job（init-collab-i4-five-dim-sync）：
 *   schedule = every 15min（§6.4.1 建议值）
 *   D6：ff pull 归属 job 第一步——现无 fleet pull 机制，本 job 自带；
 *   pull 失败（plane-shift 同 clone 写窗/网络）= 跳过本轮 + 下轮自愈。
 *   runAs fleet（OBS-20260814-002 身份纪律：服务器侧一切 git = fleet 单身份）。
 *   第二步调 apply 执行体（读→校验→版本比对→落地→退出码），
 *   非 0 退出 → cron job lastError + per-run 日志（既有机制复用）。
 */
const SYNC_APPLY_PRESET = {
  name: 'config-sync-apply',
  schedule: { kind: 'every' as const, everyMs: 900000 },
  payload: {
    command: [
      'cd /srv/fleet/TriMetaverse && git pull --ff-only \\',
      '&& node /srv/fleet/TriMC/dist/src/cli.js config-sync apply',
    ].join('\n'),
    cwd: '/srv/fleet',
    runAs: 'fleet',
  },
};

// ── subcommands ─────────────────────────────────────────────────

type Args = string[];

function requireValue(args: Args, i: number, flag: string): string {
  const value = args[i + 1];
  if (!value) {
    console.error(`ERROR: ${flag} requires a value.`);
    process.exit(1);
  }
  return value;
}

async function cmdAdd(args: Args): Promise<void> {
  let name = '';
  let schedule: Record<string, unknown> | null = null;
  let command = '';
  let cwd = '';
  let runAs: string | undefined;
  let timeoutMs: number | undefined;
  let enabled = true;
  let planeShift = false;
  let syncApply = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--plane-shift') {
      planeShift = true;
    } else if (args[i] === '--sync-apply') {
      syncApply = true;
    } else if (args[i] === '--name') {
      name = requireValue(args, i, '--name');
      i++;
    } else if (args[i] === '--cron') {
      schedule = { kind: 'cron', cron: requireValue(args, i, '--cron') };
      i++;
    } else if (args[i] === '--tz') {
      const tz = requireValue(args, i, '--tz');
      if (schedule && schedule.kind === 'cron') schedule.timezone = tz;
      i++;
    } else if (args[i] === '--every') {
      const everyMs = parseInt(requireValue(args, i, '--every'), 10);
      if (!Number.isFinite(everyMs) || everyMs <= 0) {
        console.error('ERROR: --every requires a positive integer (ms).');
        process.exit(1);
      }
      schedule = { kind: 'every', everyMs };
      i++;
    } else if (args[i] === '--command') {
      command = requireValue(args, i, '--command');
      i++;
    } else if (args[i] === '--cwd') {
      cwd = requireValue(args, i, '--cwd');
      i++;
    } else if (args[i] === '--run-as') {
      runAs = requireValue(args, i, '--run-as');
      i++;
    } else if (args[i] === '--timeout') {
      timeoutMs = parseInt(requireValue(args, i, '--timeout'), 10);
      i++;
    } else if (args[i] === '--disabled') {
      enabled = false;
    } else if (!args[i].startsWith('-') && !name) {
      name = args[i];
    }
  }

  // Preset path
  if (planeShift) {
    name = name || PLANE_SHIFT_PRESET.name;
    schedule = { ...PLANE_SHIFT_PRESET.schedule };
    command = command || PLANE_SHIFT_PRESET.payload.command;
    cwd = cwd || PLANE_SHIFT_PRESET.payload.cwd;
    runAs = runAs ?? PLANE_SHIFT_PRESET.payload.runAs;
  }
  if (syncApply) {
    name = name || SYNC_APPLY_PRESET.name;
    schedule = { ...SYNC_APPLY_PRESET.schedule };
    command = command || SYNC_APPLY_PRESET.payload.command;
    cwd = cwd || SYNC_APPLY_PRESET.payload.cwd;
    runAs = runAs ?? SYNC_APPLY_PRESET.payload.runAs;
  }

  if (!name) {
    console.error('ERROR: name is required (--name <name> or positional).');
    process.exit(1);
  }
  if (!schedule) {
    console.error(
      'ERROR: schedule is required (--cron "<expr>" [--tz <tz>], --every <ms>, --plane-shift, or --sync-apply).',
    );
    process.exit(1);
  }
  if (!command || !cwd) {
    console.error('ERROR: --command and --cwd are required (or use --plane-shift).');
    process.exit(1);
  }

  const payload: Record<string, unknown> = { command, cwd };
  if (runAs) payload.runAs = runAs;
  if (timeoutMs) payload.timeoutMs = timeoutMs;

  const result = await cronRequest('POST', '/internal/v1/cron/jobs', {
    name,
    schedule,
    payload,
    enabled,
  });
  const job = (result as Record<string, unknown>).job;
  console.log('[OK] job created:', JSON.stringify(job, null, 2));
}

async function cmdList(): Promise<void> {
  const result = (await cronRequest('GET', '/internal/v1/cron/jobs')) as {
    jobs: Array<Record<string, unknown>>;
    count: number;
  };
  if (result.jobs.length === 0) {
    console.log('No cron jobs.');
    return;
  }
  console.log(`\n${'ID'.padEnd(24)} ${'NAME'.padEnd(24)} ${'SCHEDULE'.padEnd(26)} ${'STATE'.padEnd(10)} ${'LAST RUN'}`);
  console.log('-'.repeat(104));
  for (const j of result.jobs) {
    const schedule = j.schedule as Record<string, unknown>;
    const scheduleStr =
      schedule.kind === 'every'
        ? `every ${schedule.everyMs}ms`
        : schedule.kind === 'at'
          ? `at ${schedule.atMs}`
          : `${schedule.cron}${schedule.timezone ? ` (${schedule.timezone})` : ''}`;
    const state = j.state as Record<string, unknown>;
    const stateStr = state.runningAtMs !== null ? 'running' : j.enabled === false ? 'disabled' : 'idle';
    const lastRunStr = state.lastRunAtMs ? new Date(state.lastRunAtMs as number).toISOString().slice(0, 19) : '-';
    console.log(
      `${String(j.id).slice(0, 22).padEnd(24)} ${String(j.name).slice(0, 22).padEnd(24)} ${String(scheduleStr).slice(0, 24).padEnd(26)} ${stateStr.padEnd(10)} ${lastRunStr}`,
    );
  }
  console.log(`\n${result.count} job(s)`);
}

async function cmdRun(args: Args): Promise<void> {
  const jobId = args[0];
  if (!jobId) {
    console.error('ERROR: job ID required. Usage: trimc cron run <id> [--force]');
    process.exit(1);
  }
  const force = args.includes('--force');
  const result = await cronRequest('POST', `/internal/v1/cron/jobs/${encodeURIComponent(jobId)}/run`, { force });
  console.log('[OK] run result:', JSON.stringify(result, null, 2));
}

async function cmdLog(args: Args): Promise<void> {
  let jobId: string | undefined;
  let limit = 20;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--job-id') {
      jobId = requireValue(args, i, '--job-id');
      i++;
    } else if (args[i] === '--limit') {
      limit = parseInt(requireValue(args, i, '--limit'), 10);
      i++;
    }
  }
  const query = new URLSearchParams();
  if (jobId) query.set('jobId', jobId);
  query.set('limit', String(limit));
  const result = (await cronRequest('GET', `/internal/v1/cron/log?${query}`)) as {
    logs: Array<Record<string, unknown>>;
    count: number;
  };
  if (result.logs.length === 0) {
    console.log('No execution logs.');
    return;
  }
  for (const l of result.logs) {
    console.log(
      `${l.startedAt}  ${String(l.jobId).slice(0, 8)}…  ${l.status}  ${l.durationMs ?? '?'}ms${l.errorMessage ? `\n    error: ${l.errorMessage}` : ''}`,
    );
  }
  console.log(`\n${result.count} log(s)`);
}

async function cmdStatus(): Promise<void> {
  const result = (await cronRequest('GET', '/internal/v1/cron/status')) as {
    status: Record<string, unknown>;
  };
  console.log(JSON.stringify(result.status, null, 2));
}

async function cmdUpdate(args: Args): Promise<void> {
  let pendingTz: string | undefined;
  const jobId = args[0];
  if (!jobId) {
    console.error(
      'ERROR: job ID required. Usage: trimc cron update <id> [--enable|--disable] [--name <n>] [--cron <expr>] [--timezone <tz>] [--every <ms>]',
    );
    process.exit(1);
  }
  const patch: CronJobPatch = {};
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--enable') {
      patch.enabled = true;
    } else if (args[i] === '--disable') {
      patch.enabled = false;
    } else if (args[i] === '--name') {
      patch.name = requireValue(args, i, '--name');
      i++;
    } else if (args[i] === '--cron') {
      patch.schedule = { kind: 'cron', cron: requireValue(args, i, '--cron') };
      i++;
    } else if (args[i] === '--timezone' || args[i] === '--tz') {
      const tzv = requireValue(args, i, '--timezone');
      if (patch.schedule && patch.schedule.kind === 'cron') {
        (patch.schedule as Record<string, unknown>).timezone = tzv;
      } else {
        pendingTz = tzv; // --tz 先于 --cron 出现：暂存，构建 schedule 时合并
      }
      i++;
    } else if (args[i] === '--every') {
      const everyMs = parseInt(requireValue(args, i, '--every'), 10);
      if (!Number.isFinite(everyMs) || everyMs <= 0) {
        console.error('ERROR: --every requires a positive integer (ms).');
        process.exit(1);
      }
      patch.schedule = { kind: 'every', everyMs };
      i++;
    }
  }
  if (patch.schedule && patch.schedule.kind === 'cron' && !patch.schedule.timezone) {
    const tzFromJob = pendingTz ?? (await safeGetTimezone(jobId));
    if (tzFromJob) (patch.schedule as Record<string, unknown>).timezone = tzFromJob;
  }
  if (pendingTz && (!patch.schedule || patch.schedule.kind !== 'cron')) {
    console.error('WARN: --timezone requires a cron schedule (--cron); flag ignored.');
  }
  if (Object.keys(patch).length === 0) {
    console.error('ERROR: no patch fields. Use --enable, --disable, --name, --cron, or --every.');
    process.exit(1);
  }
  const result = await cronRequest('PATCH', `/internal/v1/cron/jobs/${encodeURIComponent(jobId)}`, patch);
  console.log('[OK] job updated:', JSON.stringify((result as Record<string, unknown>).job, null, 2));
}

async function safeGetTimezone(jobId: string): Promise<string | undefined> {
  try {
    const r = await cronRequest('GET', `/internal/v1/cron/jobs/${encodeURIComponent(jobId)}`);
    const job = (r as Record<string, unknown>).job as { schedule?: { timezone?: string } } | undefined;
    return job?.schedule?.timezone;
  } catch {
    return undefined;
  }
}

async function cmdRemove(args: Args): Promise<void> {
  const jobId = args[0];
  if (!jobId) {
    console.error('ERROR: job ID required. Usage: trimc cron remove <id>');
    process.exit(1);
  }
  await cronRequest('DELETE', `/internal/v1/cron/jobs/${encodeURIComponent(jobId)}`);
  console.log('[OK] job removed.');
}

// ── config-sync subcommands ─────────────────────────────────────

/**
 * `trimc config-sync apply`（i4-2 §三.2）：五维同步接收侧执行体。
 * 读 fleet 工作树 bundle → 校验 → 版本比对 → 落地。退出码 0 = no-op/成功；
 * 1 = invalid-bundle / 落地异常（cron job lastError 面）。
 */
async function cmdConfigSyncApply(args: Args): Promise<void> {
  let fleetRoot: string | undefined;
  let configDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--fleet-root') {
      fleetRoot = requireValue(args, i, '--fleet-root');
      i++;
    } else if (args[i] === '--config-dir') {
      configDir = requireValue(args, i, '--config-dir');
      i++;
    }
  }
  try {
    const result = await runConfigSyncApply({
      ...(fleetRoot ? { fleetRoot } : {}),
      ...(configDir ? { configDir } : {}),
    });
    console.log('[OK] config-sync apply:', JSON.stringify(result, null, 2));
    if (result.outcome === 'invalid-bundle') {
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`ERROR: config-sync apply failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

// ── TriModel 直连恢复梯命令族（波③ 范围②④）────────────────────

/** 旧 bin 名调用识别（argv[1] basename 词干；覆盖 POSIX symlink 与直调命名面）。
 * 已知限制（技术债如实标记）：Windows npm .cmd/.ps1 shim 的 argv[1]=真实 cli.js 路径，
 * 调名不达子进程——该面弃用提示候 M3 删旧键窗随文档收口，不静默不假装。 */
function legacyBinInvocation(oldName: string): boolean {
  const raw = process.argv[1] ?? '';
  const stem = (raw.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(cmd|ps1|exe|js|cjs|mjs)$/, '');
  return stem === oldName;
}

/** cron engine 探活回调（core status 实时探活用；回调型注入=core 零端点知识）。
 * 读数面=本机 trimc 服务 /internal/v1/cron/status 值面（可达+ok 即 up）。 */
function cronEngineProbe(): { name: string; probe: () => Promise<ProbeReading> } {
  return {
    name: 'cron-engine',
    probe: async () => {
      try {
        const token = resolveInternalToken();
        const res = await fetch(`${serviceUrl()}/internal/v1/cron/status`, {
          headers: token ? { 'X-Internal-Token': token } : {},
        });
        return { up: res.ok, detail: res.ok ? 'cron/status 200' : `HTTP ${res.status}` };
      } catch (err) {
        return { up: false, detail: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

/** `model` 父命令：TriCode core runCli 派发（cron/config-sync 家族命令零触碰；退出码直通）。
 * CoreIO 注入：who=审计身份（门⑤ 落行）、machine=四象限路由键（joint-plan 问3 21:44 勘正版：
 * trimmc=sg Linux·M 服务域）、probes=cron engine 值面。 */
async function runModelCommand(restArgs: string[]): Promise<void> {
  const io = makeCoreIO({
    who: 'trimmc-cmd',
    binName: 'trimmc',
    machine: 'sg-m',
    probes: [cronEngineProbe()],
    l2FlagPath: defaultL2FlagPath(),
  });
  process.exitCode = await runCli(restArgs, io);
}

// ── LG-058 P1 config 卡面命令族（daemon 进程内执行；CLI=触发器）──
// 形态对标 TriRLC/TriMLC config 家族（N4）；HTTP 复用既有 cronRequest（已带
// X-Internal-Token 三链解析：env→docker/.env→cwd 探测链，internal-token.ts）。
// 梯语义=§4.3 层级合并裁：env 逃生门 > 卡面 cache（fresh/stale-grace）>
// fleet bundle > 常量兜底——「即时生效」要求刷新与 env apply 落 daemon 运行态。

function ts(n: unknown): string {
  return typeof n === 'number' && n > 0 ? new Date(n).toISOString() : '-';
}

async function cmdConfig(args: string[]): Promise<void> {
  const sub = args[0] ?? 'show';
  try {
    switch (sub) {
      case 'pull': {
        const r = await cronRequest('POST', '/internal/v1/config/pull') as {
          ok?: boolean; mode?: string; defaultModel?: string | null; source?: string;
          message?: string; attribution?: string | null;
        };
        console.log(`config pull: ${r.ok ? 'OK' : 'FAILED'} (mode=${r.mode})`);
        console.log(`  default model: ${r.defaultModel ?? '-'}   source: ${r.source}`);
        console.log(`  ${r.message ?? ''}`);
        if (r.attribution) console.log(`  attribution: ${r.attribution}`);
        if (!r.ok) process.exitCode = 1;
        break;
      }
      case 'show':
      case 'cache': {
        if (sub === 'cache' && args[1] === 'clear') {
          const r = await cronRequest('DELETE', '/internal/v1/config/cache') as {
            hadCache?: boolean; removedFiles?: string[];
          };
          console.log(`config cache clear: done (hadCache=${!!r.hadCache}, removed=${(r.removedFiles ?? []).length} file(s))`);
          console.log('  梯语义验证：接 `config pull` 强制回 tier1；daemon env 现值待下次成功 pull 覆盖');
          break;
        }
        const r = await cronRequest('GET', '/internal/v1/config/show') as {
          face?: string; hasCache?: boolean; fresh?: boolean; staleGrace?: boolean;
          defaultModel?: string | null; effectiveModel?: string | null; effectiveSource?: string;
          fetchedAt?: number | null; expiresAt?: number | null; refreshIntervalS?: number | null;
          providerCount?: number; providers?: string[];
          lastFetchAt?: number | null; lastFetchError?: string | null; lastAttribution?: string | null;
          ladder?: { model?: string; source?: string } | null;
        };
        console.log(`config show (face=${r.face}):`);
        console.log(`  effective model: ${r.effectiveModel ?? '-'}   source: ${r.effectiveSource}`);
        if (r.hasCache) {
          console.log(`  cache: ${r.fresh ? 'fresh' : r.staleGrace ? 'stale-grace (tier2.5)' : 'expired'}  fetched ${ts(r.fetchedAt)}  expires ${ts(r.expiresAt)}  refresh=${r.refreshIntervalS ?? '-'}s`);
          console.log(`  providers(${r.providerCount}): ${(r.providers ?? []).join(', ') || '-'}`);
        } else {
          console.log('  cache: none (bundle/env 梯语义)');
        }
        if (r.ladder) {
          console.log(`  ladder(§4.3): model=${r.ladder.model ?? '-'}  source=${r.ladder.source ?? '-'}  (env 逃生门 > 卡面 > fleet bundle > 常量)`);
        }
        console.log(`  last fetch: ${ts(r.lastFetchAt)}${r.lastFetchError ? `  error: ${r.lastFetchError}` : ''}${r.lastAttribution ? `  attribution: ${r.lastAttribution}` : ''}`);
        break;
      }
      case 'verify': {
        const r = await cronRequest('POST', '/internal/v1/config/verify') as {
          ok?: boolean; connectivity?: string; credentials?: string; decryptHealth?: string;
          cardPresent?: boolean; defaultModel?: string | null; providers?: number; message?: string;
        };
        console.log(`config verify: ${r.ok ? 'HEALTHY' : 'UNHEALTHY'}`);
        console.log(`  connectivity: ${r.connectivity}   credentials: ${r.credentials}   decrypt: ${r.decryptHealth}`);
        console.log(`  card_present: ${r.cardPresent}   default model: ${r.defaultModel ?? '-'}   providers: ${r.providers ?? 0}`);
        console.log(`  ${r.message ?? ''}`);
        if (!r.ok) process.exitCode = 1;
        break;
      }
      default:
        console.error(`ERROR: unknown config subcommand '${sub}'. Usage: trimmc config <pull|show|verify|cache [clear]>`);
        process.exitCode = 1;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/fetch failed|ECONNREFUSED/i.test(msg)) {
      console.error(`ERROR: daemon 无响应（${serviceUrl()}）——先起 trimmc daemon 再试`);
    } else {
      console.error(`ERROR: ${msg}`);
    }
    process.exitCode = 1;
  }
}

// ── dispatch ────────────────────────────────────────────────────

const USAGE = `Usage: trimmc <cron|config-sync|config|model> ...

  cron add    --name <n> --cron "<expr>" [--tz <tz>] --command <cmd> --cwd <dir>
              [--run-as <user>] [--timeout <ms>] [--disabled]
              | --plane-shift           (install the weekly plane shift job preset)
              | --sync-apply            (install the config sync apply job preset, every 15min)
  cron <list|run <id>|log|status|update <id>|remove <id>>

  config-sync apply [--fleet-root <dir>] [--config-dir <dir>]
                                        (apply the fleet five-dim sync bundle)

  config <pull|show|verify|cache [clear]>  (TriModel 卡面配置族 LG-058；梯=§4.3)

  model <restore-direct|config|status>   (TriModel 兜底直连恢复梯命令族；无参=help)`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // 正名过渡期（范围④）：旧名调用→单行弃用引导（stderr，不阻塞），随后照常执行。
  if (legacyBinInvocation('trimc')) {
    console.error('[trimc] 提示：命令已正名为 trimmc（trimc=过渡期别名，M3 版本移除）；本次照常执行。');
  }
  if (argv.length === 0) {
    console.log(USAGE);
    return;
  }
  if (argv[0] === 'model') {
    await runModelCommand(argv.slice(1));
    return;
  }
  if (argv[0] === 'cron' && argv.length === 1) {
    console.log(USAGE);
    return;
  }
  if (argv[0] === 'config') {
    await cmdConfig(argv.slice(1));
    return;
  }
  if (argv[0] === 'config-sync') {
    const sub = argv[1];
    if (sub === 'apply') {
      await cmdConfigSyncApply(argv.slice(2));
      return;
    }
    console.error(`ERROR: unknown config-sync subcommand: ${sub}`);
    console.error(USAGE);
    process.exit(1);
  }
  if (argv[0] !== 'cron') {
    console.error(`ERROR: unknown command "${argv[0]}".`);
    console.error(USAGE);
    process.exit(1);
  }

  const subcommand = argv[1];
  const args = argv.slice(2);
  try {
    switch (subcommand) {
      case 'add':
        await cmdAdd(args);
        break;
      case 'list':
        await cmdList();
        break;
      case 'run':
        await cmdRun(args);
        break;
      case 'log':
        await cmdLog(args);
        break;
      case 'status':
        await cmdStatus();
        break;
      case 'update':
        await cmdUpdate(args);
        break;
      case 'remove':
        await cmdRemove(args);
        break;
      default:
        console.error(`ERROR: unknown cron subcommand: ${subcommand}`);
        console.error(USAGE);
        process.exit(1);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`ERROR: ${msg}`);
    process.exit(1);
  }
}

void main();
