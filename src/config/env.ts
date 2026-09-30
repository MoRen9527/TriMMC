export type TriMMCEnv = {
  port: number;
  tristacissBaseUrl: string;
  openclawGatewayUrl: string;
  vscodiumGlueBaseUrl: string;
  /** Working directory for tool execution */
  cwd: string;
  /** Root path for stateful memory files (from TRIMC_MEMDIR). When unset, memory injection is skipped. */
  memdirPath?: string;
  /** M1 Phase-2: session-bridge 降权账号（如 fleet）；不设则以当前用户直跑（本地开发） */
  runAsUser?: string;
  /** M1 Phase-2: claude 会话工作目录（默认 /srv/fleet） */
  bridgeCwd: string;
  /** cron scheduler 开关（TRIMC_CRON_ENABLED !== 'false' 时启用） */
  cronEnabled: boolean;
  /** cron per-run 日志目录（TRIMC_CRON_LOG_DIR）；不设则由 cron service 落 TRIMC_CONFIG_DIR/cron/logs */
  cronLogDir?: string;
  /** 模型 default 三级解析最高优先（TRIMC_DEFAULT_MODEL，i4-2 §四）；
   *  不设 → applied bundle model.defaultModel → 兜底常量。 */
  defaultModel?: string;
};

export function readEnv(): TriMMCEnv {
  return {
    port: Number(process.env.TRIMC_PORT ?? 8710),
    tristacissBaseUrl: process.env.TRISTACISS_BASE_URL ?? 'http://127.0.0.1:8008',
    openclawGatewayUrl: process.env.OPENCLOW_GATEWAY_URL ?? 'ws://127.0.0.1:8822',
    vscodiumGlueBaseUrl: process.env.VSCODIUM_GLUE_BASE_URL ?? 'http://127.0.0.1:8730',
    cwd: process.env.TRIMC_CWD ?? process.cwd(),
    memdirPath: process.env.TRIMC_MEMDIR || undefined,
    runAsUser: process.env.TRIMC_RUNAS || undefined,
    bridgeCwd: process.env.TRIMC_BRIDGE_CWD ?? '/srv/fleet',
    cronEnabled: process.env.TRIMC_CRON_ENABLED !== 'false',
    cronLogDir: process.env.TRIMC_CRON_LOG_DIR || undefined,
    defaultModel: process.env.TRIMC_DEFAULT_MODEL || undefined,
  };
}
