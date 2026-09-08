// ── LG-033 b 直上窗 1+2：claude 进程封装（headless stream-json 流管理）──
// 窗 1：-p 双向流长驻形态+cwd 钉+env 注入位+台账钩子接口。
// 窗 2（本版）：流管理深化——Reader 单实例生命周期（restart/resume 重绑防双读）
// +请求关联队列（sendLine→按序 resolve，result 终态收束）+三钩子实装
// （onToolUse/onRelay/onSystemEvent 结构化事件）+坏行计数审计位。
// 测试形态：binaryPath 参数化——echo 替身脚本（stream-json 往返）替代真 claude。

import { createInterface, type Interface } from 'node:readline';
import { ManagedProcessSupervisor, type SupervisorSpawnConfig, type SupervisorState } from './supervisor.js';

export interface ClaudeRunnerOptions {
  /** claude 可执行路径（默认 'claude'；测试传 echo 替身脚本）。 */
  binaryPath?: string;
  /** 全旗标集合（--settings/crossSessionInbound 等——每次 spawn 全量重传）。 */
  args: string[];
  /** headless 形态旗标（默认 -p + 双向 stream-json；测试替身传 [] 免旗标毒害）。 */
  headlessArgs?: string[];
  /** 工作目录钉死（默认 /srv/fleet/TriMetaverse）。 */
  cwd?: string;
  /** duty-env 注入位（.trimmc 展开后的 env 键值）。 */
  env?: Record<string, string>;
  maxRestarts?: number;
}

/** stream-json 单行消息形态（user/assistant/system/result 事件族）。 */
export interface StreamJsonMessage {
  type: string;
  subtype?: string;
  relayNote?: string;
  isError?: boolean;
  [key: string]: unknown;
}

/** 台账钩子（窗 2 实装：结构化事件审计面——换棒/工具调用/系统态）。 */
export interface ClaudeRunnerHooks {
  onToolUse?: (info: { tool: string; at: number }) => void;
  onRelay?: (info: { note: string; at: number }) => void;
  onSystemEvent?: (info: { subtype: string; at: number }) => void;
  onResult?: (info: { isError: boolean; at: number }) => void;
  onParseError?: (info: { line: string; at: number }) => void;
}

/** 单次请求的 pending 项（窗 2：请求关联——按序 FIFO resolve）。 */
interface PendingRequest {
  resolve: (msg: StreamJsonMessage) => void;
  reject: (err: Error) => void;
  sentAtMs: number;
}

export class ClaudeSessionRunner {
  private supervisor: ManagedProcessSupervisor;
  private hooks: ClaudeRunnerHooks = {};
  // ── 窗 2 流管理：Reader 单实例+pending 队列 ──
  private rl: Interface | null = null;
  private rlBoundPid: number | null = null; // 绑定进程代际（防旧 Reader 读新进程）
  private pendingQueue: PendingRequest[] = [];
  private parseErrorCount = 0;

  constructor(options: ClaudeRunnerOptions) {
    const spawnConfig: SupervisorSpawnConfig = {
      binaryPath: options.binaryPath ?? 'claude',
      args: [
        ...(options.headlessArgs ?? ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json']),
        ...options.args,
      ],
      cwd: options.cwd ?? '/srv/fleet/TriMetaverse',
      env: options.env,
      maxRestarts: options.maxRestarts,
    };
    this.supervisor = new ManagedProcessSupervisor(spawnConfig);
    this.supervisor.on('state', (s: SupervisorState) => {
      if (s === 'running') this.attachLineReader();
      if (s === 'paused' || s === 'stopped') this.flushPending('process not running');
    });
  }

  setHooks(hooks: ClaudeRunnerHooks): void {
    this.hooks = { ...hooks };
  }

  /** 坏行累计（审计位；read 面经 getParseErrorCount）。 */
  getParseErrorCount(): number { return this.parseErrorCount; }

  /** 台账/监控委托面（pause/resume/状态——rev2 ④ 协议位）。 */
  get supervisorApi(): {
    start: () => void; pause: () => void; resume: () => void; stop: () => void;
    getState: () => string; getRestarts: () => number; isAlive: () => boolean; getPid: () => number | null;
  } {
    return {
      start: () => this.supervisor.start(),
      pause: () => this.supervisor.pause(),
      resume: () => this.supervisor.resume(),
      stop: () => this.supervisor.stop(),
      getState: () => this.supervisor.getState(),
      getRestarts: () => this.supervisor.getRestarts(),
      isAlive: () => this.supervisor.isAlive(),
      getPid: () => this.supervisor.getPid(),
    };
  }

  /**
   * 窗 2：请求关联发送——写入一行并在流上等下一轮 assistant（FIFO 按序）。
   * result 终态先行时以 result 收束。进程不可写→立即 reject。
   */
  async request(msg: StreamJsonMessage): Promise<StreamJsonMessage> {
    const wrote = this.sendLine(msg);
    if (!wrote) throw new Error('claude stdin not writable (process not running)');
    return new Promise<StreamJsonMessage>((resolve, reject) => {
      this.pendingQueue.push({ resolve, reject, sentAtMs: Date.now() });
    });
  }

  /** 写一行 stream-json 到 claude stdin。 */
  sendLine(obj: StreamJsonMessage): boolean {
    const child = this.childRef();
    if (!child?.stdin) return false;
    return child.stdin.write(JSON.stringify(obj) + '\n');
  }

  /** 窗 2：Reader 单实例重绑（代际 pid 校验——restart/resume 后旧 Reader 关闭防双读）。 */
  private attachLineReader(): void {
    const child = this.childRef();
    if (!child?.stdout) return;
    if (this.rl && this.rlBoundPid === child.pid) return; // 同代际已绑
    if (this.rl) this.rl.close(); // 旧代际 Reader 关闭（防 restart 后双读）
    this.rlBoundPid = child.pid;
    this.rl = createInterface({ input: child.stdout });
    this.rl.on('line', (line) => this.handleLine(line));
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: StreamJsonMessage;
    try {
      msg = JSON.parse(trimmed) as StreamJsonMessage;
    } catch {
      this.parseErrorCount += 1;
      this.hooks.onParseError?.({ line: trimmed.slice(0, 200), at: Date.now() });
      return;
    }
    this.dispatchMessage(msg);
  }

  /** 窗 2：事件分发（三钩子实装+pending 队列收束）。 */
  protected dispatchMessage(msg: StreamJsonMessage): void {
    const at = Date.now();
    if (msg.type === 'assistant') {
      const content = (msg as { message?: { content?: Array<{ type: string; name?: string; text?: string }> } }).message?.content;
      for (const block of content ?? []) {
        if (block.type === 'tool_use' && block.name) this.hooks.onToolUse?.({ tool: block.name, at });
      }
      this.settleNext(msg);
      return;
    }
    if (msg.type === 'system') {
      this.hooks.onSystemEvent?.({ subtype: String(msg.subtype ?? ''), at });
      return;
    }
    if (typeof msg.relayNote === 'string') {
      this.hooks.onRelay?.({ note: msg.relayNote, at });
      return;
    }
    if (msg.type === 'result') {
      this.hooks.onResult?.({ isError: msg.isError === true, at });
      this.settleNext(msg);
      return;
    }
    // 其他类型（user 回显/stream 事件等）不进钩子，交 request 关联面按需
    this.settleNext(msg);
  }

  /** FIFO 收束一个 pending（assistant 结果或 result 终态）。 */
  private settleNext(msg: StreamJsonMessage): void {
    const pending = this.pendingQueue.shift();
    if (pending) pending.resolve(msg);
  }

  /** 进程停/paused：flush 全部 pending（reject——请求方感知失败）。 */
  private flushPending(reason: string): void {
    for (const p of this.pendingQueue.splice(0)) {
      p.reject(new Error(`claude stream flushed: ${reason}`));
    }
  }

  private childRef(): { stdin: { write: (d: string) => boolean }; stdout: import('node:stream').Readable | null; pid: number | null } | null {
    return (this.supervisor as unknown as { child: { stdin: { write: (d: string) => boolean }; stdout: import('node:stream').Readable | null; pid: number | null } | null }).child;
  }
}
