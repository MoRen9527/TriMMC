// ── LG-033 b 直上窗 1：ProcessSupervisor 服务器版（长驻受管进程）──
// 参照=agent-core process-supervisor（run 型一次性：spawn/capture/timeout/registry），
// 本模块=长驻扩展非照抄（TriMMC 仓栈适配）：受管长驻进程+存活监控+重启计数退避
// +pause/resume 协议位（LG-033 rev2 ④：写接入走暂停释放协议，禁双活）。
//
// 设计约束（rev2 规格照守）：**全旗标每次 spawn 重传**——resume 不恢复旗标约束，
// 旗标集合由调用方持有，每次（首拉/重启/resume）spawn 均全量重建 argv。

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

export type SupervisorState =
  | 'idle'        // 未启动
  | 'starting'    // 拉起中
  | 'running'     // 长驻运行
  | 'paused'      // 已暂停（进程退出，resume 上下文保留——c 人工接入窗）
  | 'backoff'     // 退出后退避等待重启
  | 'stopped';    // 人为停止（不自动重启）

export interface SupervisorSpawnConfig {
  /** 可执行文件（如 claude CLI 路径；测试用 echo 替身）。 */
  binaryPath: string;
  /** 全旗标集合——每次 spawn 全量重传（含 --settings/crossSessionInbound 等）。 */
  args: string[];
  /** 工作目录钉死（如 /srv/fleet/TriMetaverse）。 */
  cwd: string;
  /** env 注入位（duty-env .trimmc 对齐由调用方展开传入）。 */
  env?: Record<string, string>;
  /** 重启退避上限次数（默认 5；超限熔断进 stopped 并 emits circuit-break）。 */
  maxRestarts?: number;
  /** 退避基数 ms（默认 1000，指数 ×2 封顶 30s）。 */
  backoffBaseMs?: number;
}

export interface SupervisorEvents {
  state: (state: SupervisorState, info: { restarts: number; reason?: string }) => void;
  exit: (info: { code: number | null; signal: string | null; restarts: number }) => void;
  restart: (info: { attempt: number; delayMs: number }) => void;
  'circuit-break': (info: { restarts: number }) => void;
  stderr: (line: string) => void;
}

/**
 * 长驻受管进程监督器（LG-033 b 窗 1 件①）。
 * - 全旗标重传：spawnOne() 每次以 config.args 全量重建 argv；
 * - 监控：child exit 事件+isAlive()+uptimeMs()；
 * - 重启计数退避：非人为退出→指数退避自动重启（上限熔断）；
 * - pause/resume 协议位：pause=人为退出但保留 resume 上下文进 paused 态
 *   （c 人工接入窗）；resume=以全旗标重拉（设计约束：resume 不恢复旗标约束——
 *   旗标由 config 全量重传，本模块不缓存旧进程旗标残留）。
 */
export class ManagedProcessSupervisor extends EventEmitter {
  private config: SupervisorSpawnConfig;
  private child: ChildProcess | null = null;
  private state: SupervisorState = 'idle';
  private restarts = 0;
  private startedAtMs = 0;
  private manualStop = false;
  private paused = false;
  private backoffTimer: NodeJS.Timeout | null = null;

  constructor(config: SupervisorSpawnConfig) {
    super();
    this.config = { ...config, args: [...config.args] }; // 防御性拷贝（旗标集合快照）
  }

  getState(): SupervisorState { return this.state; }
  getRestarts(): number { return this.restarts; }
  isAlive(): boolean { return this.child?.exitCode === null && this.child?.killed === false && this.child.pid !== undefined; }
  uptimeMs(): number { return this.startedAtMs ? Date.now() - this.startedAtMs : 0; }
  /** 当前进程 pid（监控/资源面用；未运行=null）。 */
  getPid(): number | null { return this.child?.pid ?? null; }

  private setState(s: SupervisorState, reason?: string): void {
    this.state = s;
    this.emit('state', s, { restarts: this.restarts, reason });
  }

  /** 首拉/重启/resume 统一入口——全旗标重传（每次 spawn 全量重建 argv）。 */
  start(): void {
    if (this.isAlive()) return;
    this.manualStop = false;
    this.spawnOne();
  }

  private spawnOne(): void {
    this.setState(this.paused ? 'paused' : 'starting');
    const child = spawn(this.config.binaryPath, this.config.args, {
      cwd: this.config.cwd,
      env: { ...process.env, ...this.config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.startedAtMs = Date.now();
    this.setState('running');

    child.stderr?.on('data', (chunk: Buffer) => {
      this.emit('stderr', chunk.toString('utf-8'));
    });

    child.on('exit', (code, signal) => {
      this.child = null;
      this.emit('exit', { code, signal, restarts: this.restarts });
      if (this.manualStop || this.paused) {
        // 人为停/pause 语义：不进重启链（pause=rev2 ④ 释放持有，resume 手动重拉）
        this.setState(this.paused ? 'paused' : 'stopped');
        return;
      }
      // 非人为退出→退避自动重启（熔断上限）
      if (this.restarts >= (this.config.maxRestarts ?? 5)) {
        this.setState('stopped', 'circuit-break');
        this.emit('circuit-break', { restarts: this.restarts });
        return;
      }
      this.restarts += 1;
      const base = this.config.backoffBaseMs ?? 1_000;
      const delayMs = Math.min(base * 2 ** (this.restarts - 1), 30_000);
      this.setState('backoff', `restart in ${delayMs}ms`);
      this.emit('restart', { attempt: this.restarts, delayMs });
      this.backoffTimer = setTimeout(() => {
        this.backoffTimer = null;
        this.spawnOne();
      }, delayMs);
    });
  }

  /**
   * 暂停（rev2 ④ 写接入协议）：人为退出进程但保留 resume 上下文（paused 态）——
   * c 人工接入窗开启；resume() 以全旗标重拉。
   */
  pause(): void {
    if (!this.isAlive()) return;
    this.paused = true;
    this.manualStop = true;
    this.child?.kill('SIGTERM');
  }

  /** 恢复（c 退出后）：全旗标重拉（设计约束：resume 不恢复旗标约束——旗标全量重传）。 */
  resume(): void {
    if (this.isAlive() || this.state !== 'paused') return;
    this.paused = false;
    this.manualStop = false;
    this.spawnOne();
  }

  /** 人为停止（不自动重启；清退避计时）。 */
  stop(): void {
    this.manualStop = true;
    this.paused = false;
    if (this.backoffTimer) { clearTimeout(this.backoffTimer); this.backoffTimer = null; }
    this.child?.kill('SIGTERM');
    if (!this.child) this.setState('stopped');
  }
}
