// ── Config Sync 契约类型与校验（接收侧独立实现）──
// init-collab-i4-five-dim-sync i4-1 拆解 §一 schema 契约（TriMMC 侧）：
//
//   1. 五维分段 bundle：company / model / keys / employees / project，
//      单维失败 = 该维段 { status: 'unavailable', reason } 降级，不阻塞全链。
//   2. keys 维白名单字段：provider / ready / fingerprint / baseUrl——
//      额外字段拒绝（防未来滑变）；密钥材料零传输（只有指纹）。
//   3. 递归密钥材料字段拒绝：任意深度出现 api_key / apiKey / secret / token
//      且值为非空字符串 → 拒绝（SEC-20260813-001 双保险：服务器侧同规则，
//      防未来生成端被绕过）。
//   4. 幂等单调：bundleId 唯一；generatedAt 严格递增；同 bundleId 重复
//      apply = no-op；更旧 generatedAt = 忽略；更旧但 contentHash 异 = 告警。
//
// TriRLC 生成端 src/company/sync-bundle.ts 独立实现同一契约（跨仓共享包升级挂后续）。

import { createHash } from 'node:crypto';

// ── 五维键 ──

export const DIM_KEYS = ['company', 'model', 'keys', 'employees', 'project'] as const;
export type DimKey = (typeof DIM_KEYS)[number];

/** 单维降级段（§2.7 三态可见：该维收集失败 → unavailable 不阻塞全链）。 */
export interface DimUnavailable {
  status: 'unavailable';
  reason: string;
}

// ── 各维字段契约 ──

export interface BundleCompany {
  state: string;
  ceoName: string;
  onboardedAt: string;
}

export interface BundleModelCatalogEntry {
  id: string;
  provider: string;
  capabilities: string[];
}

export interface BundleModelProvider {
  provider: string;
  baseUrl?: string;
  port?: number;
}

export interface BundleModel {
  defaultModel: string;
  catalog: BundleModelCatalogEntry[];
  providers: BundleModelProvider[];
}

/** keys 维白名单字段（§一.1 纪律：额外字段拒绝）。 */
export interface BundleKeysProvider {
  provider: string;
  ready: boolean;
  fingerprint?: string;
  baseUrl?: string;
}

export interface BundleKeys {
  providers: BundleKeysProvider[];
  refreshIntervalS: number;
  fetchedAt: string;
}

export interface BundleEmployee {
  roleId: string;
  name: string;
}

export interface BundleEmployees {
  roster: BundleEmployee[];
  /** TriCompany 仓 HEAD sha40（§九 服务器侧校验兜底）。 */
  sourceCommit: string;
}

export interface BundleWorktree {
  path: string;
  branch: string;
}

export interface BundleProject {
  projectKey: string;
  repoUrl: string;
  defaultBranch: string;
  worktrees: BundleWorktree[];
  devHead: string;
}

export type BundleDim<T> = T | DimUnavailable;

export interface SyncBundle {
  schemaVersion: 1;
  bundleId: string;
  generatedAt: string;
  generatedBy: string;
  company: BundleDim<BundleCompany>;
  model: BundleDim<BundleModel>;
  keys: BundleDim<BundleKeys>;
  employees: BundleDim<BundleEmployees>;
  project: BundleDim<BundleProject>;
}

// ── 密钥材料字段拒绝（SEC-20260813-001）──

export const SECRET_FIELD_NAMES = ['api_key', 'apiKey', 'secret', 'token'] as const;

export const KEYS_PROVIDER_FIELDS = ['provider', 'ready', 'fingerprint', 'baseUrl'] as const;

/** 递归扫描：任意深度出现密钥材料字段名且值为非空字符串 → 拒绝。 */
export function findSecretField(node: unknown, path: string): string | null {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const hit = findSecretField(node[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if ((SECRET_FIELD_NAMES as readonly string[]).includes(key)) {
        if (typeof value === 'string' && value.length > 0) {
          return `${path}.${key}`;
        }
      }
      const hit = findSecretField(value, `${path}.${key}`);
      if (hit) return hit;
    }
  }
  return null;
}

// ── 结构校验 ──

export type BundleValidation =
  | { ok: true; bundle: SyncBundle }
  | { ok: false; error: string; message: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export function isDimUnavailable(v: unknown): v is DimUnavailable {
  return isRecord(v) && v.status === 'unavailable' && typeof v.reason === 'string';
}

function checkCompany(v: unknown): string | null {
  if (!isRecord(v)) return 'company must be an object';
  if (!isStr(v.state) || !isStr(v.ceoName) || !isStr(v.onboardedAt)) {
    return 'company.state/ceoName/onboardedAt must be non-empty strings';
  }
  return null;
}

function checkModel(v: unknown): string | null {
  if (!isRecord(v)) return 'model must be an object';
  if (!isStr(v.defaultModel)) return 'model.defaultModel must be a non-empty string';
  if (!Array.isArray(v.catalog) || !Array.isArray(v.providers)) {
    return 'model.catalog/providers must be arrays';
  }
  for (const entry of v.catalog) {
    if (!isRecord(entry) || !isStr(entry.id) || !isStr(entry.provider)) {
      return 'model.catalog[] needs id + provider strings';
    }
    if (!Array.isArray(entry.capabilities)) return 'model.catalog[].capabilities must be an array';
  }
  for (const p of v.providers) {
    if (!isRecord(p) || !isStr(p.provider)) return 'model.providers[].provider must be a string';
  }
  return null;
}

function checkKeys(v: unknown): string | null {
  if (!isRecord(v)) return 'keys must be an object';
  if (!Array.isArray(v.providers) || typeof v.refreshIntervalS !== 'number' || !isStr(v.fetchedAt)) {
    return 'keys.providers[]/refreshIntervalS/fetchedAt shape invalid';
  }
  for (const p of v.providers) {
    if (!isRecord(p)) return 'keys.providers[] must be an object';
    // 白名单字段：额外字段拒绝（防未来滑变，§一.1）
    for (const field of Object.keys(p)) {
      if (!(KEYS_PROVIDER_FIELDS as readonly string[]).includes(field)) {
        return `keys.providers[] field not whitelisted: ${field}`;
      }
    }
    if (!isStr(p.provider) || typeof p.ready !== 'boolean') {
      return 'keys.providers[] needs provider string + ready boolean';
    }
    if (p.fingerprint !== undefined && typeof p.fingerprint !== 'string') {
      return 'keys.providers[].fingerprint must be a string';
    }
    if (p.baseUrl !== undefined && typeof p.baseUrl !== 'string') {
      return 'keys.providers[].baseUrl must be a string';
    }
  }
  return null;
}

function checkEmployees(v: unknown): string | null {
  if (!isRecord(v)) return 'employees must be an object';
  if (!Array.isArray(v.roster) || !isStr(v.sourceCommit)) {
    return 'employees.roster[]/sourceCommit shape invalid';
  }
  for (const e of v.roster) {
    if (!isRecord(e) || !isStr(e.roleId) || !isStr(e.name)) {
      return 'employees.roster[] needs roleId + name strings';
    }
  }
  return null;
}

function checkProject(v: unknown): string | null {
  if (!isRecord(v)) return 'project must be an object';
  if (!isStr(v.projectKey) || !isStr(v.repoUrl) || !isStr(v.defaultBranch) || !isStr(v.devHead)) {
    return 'project.projectKey/repoUrl/defaultBranch/devHead must be non-empty strings';
  }
  if (!Array.isArray(v.worktrees)) return 'project.worktrees must be an array';
  for (const wt of v.worktrees) {
    if (!isRecord(wt) || !isStr(wt.path) || !isStr(wt.branch)) {
      return 'project.worktrees[] needs path + branch strings';
    }
  }
  return null;
}

const DIM_CHECKERS: Record<DimKey, (v: unknown) => string | null> = {
  company: checkCompany,
  model: checkModel,
  keys: checkKeys,
  employees: checkEmployees,
  project: checkProject,
};

/**
 * bundle schema 校验（§一契约 + 测试门禁①）：
 * 递归密钥材料字段拒绝 → 结构逐维校验（unavailable 降级段合法）→ 元字段。
 */
export function validateSyncBundle(raw: unknown): BundleValidation {
  const secretHit = findSecretField(raw, '$');
  if (secretHit) {
    return {
      ok: false,
      error: 'secret_field_rejected',
      message: `bundle contains key-material field at ${secretHit}（SEC-20260813-001：密钥材料零传输，仅允许配置面 + 指纹）`,
    };
  }
  if (!isRecord(raw)) {
    return { ok: false, error: 'bad_shape', message: 'bundle must be a JSON object' };
  }
  if (raw.schemaVersion !== 1) {
    return { ok: false, error: 'bad_schema_version', message: 'schemaVersion must be 1' };
  }
  if (!isStr(raw.bundleId)) {
    return { ok: false, error: 'bad_bundle_id', message: 'bundleId must be a non-empty string' };
  }
  if (!isStr(raw.generatedAt) || Number.isNaN(Date.parse(raw.generatedAt))) {
    return { ok: false, error: 'bad_generated_at', message: 'generatedAt must be a parseable ISO-8601 string' };
  }
  if (!isStr(raw.generatedBy)) {
    return { ok: false, error: 'bad_generated_by', message: 'generatedBy must be a non-empty string' };
  }
  for (const dim of DIM_KEYS) {
    const value = raw[dim];
    if (isDimUnavailable(value)) continue;
    const err = DIM_CHECKERS[dim](value);
    if (err) return { ok: false, error: 'bad_dim_shape', message: `${dim}: ${err}` };
  }
  return { ok: true, bundle: raw as unknown as SyncBundle };
}

// ── 内容指纹（两端同算法：稳定键序 JSON → SHA-256）──

/** 稳定键序序列化（对象键递归排序），保证两端 contentHash 一致。 */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * contentHash = SHA-256(稳定键序 JSON of 五维语义内容) 全量 hex。
 * 仅覆盖五维（company/model/keys/employees/project），不含 bundleId/
 * generatedAt/generatedBy 元字段——元字段每次生成必然不同，纳入会使
 * 「同内容旧 generatedAt 重放」与「生成端同内容幂等重跑」判定恒失效
 * （§一.4 矩阵语义 = 内容重放检测，非全帧指纹）。
 * 修正记录 ②（i4-4 终审裁决，OBS-1）：project.devHead 同口径排除——
 * devHead 是自引用事实（每次成功 run 必 commit bundle 推进 HEAD，下一轮
 * 收集值必变），纳入会使幂等重跑语义恒失效。两端同口径（生成端
 * sync-bundle.ts computeDimsContentHash 一致）。
 */
export function computeContentHash(bundle: SyncBundle): string {
  const { company, model, keys, employees, project } = bundle;
  return createHash('sha256')
    .update(canonicalize({ company, model, keys, employees, project: projectDimForHash(project) }), 'utf-8')
    .digest('hex');
}

/** 幂等哈希口径：project 维剔除 devHead（自引用字段，两端同口径）。 */
function projectDimForHash(project: unknown): unknown {
  if (typeof project === 'object' && project !== null && !Array.isArray(project)) {
    const { devHead: _omitted, ...rest } = project as Record<string, unknown>;
    return rest;
  }
  return project;
}

/** keys 维指纹 = SHA-256(材料).slice(0,8)（§一.2；材料仅内存内计算，即刻丢弃）。 */
export function computeKeyFingerprint(material: string): string {
  return createHash('sha256').update(material, 'utf-8').digest('hex').slice(0, 8);
}

// ── applied 落地清单（§三.1：applied.json + 各维文件）──

export type AppliedDimStatus = 'applied' | 'unavailable' | 'warning';

export interface AppliedManifest {
  schemaVersion: 1;
  bundleId: string;
  generatedAt: string;
  contentHash: string;
  /** 生成端身份（bundle.generatedBy）。 */
  sourceInstanceId: string;
  lastAppliedAt: string;
  dims: Record<DimKey, AppliedDimStatus>;
  /** 告警条（旧 generatedAt 异 hash / 多实例挂起等，MVP 记日志 + status 呈现）。 */
  warnings?: string[];
}

// ── status 端点响应契约（§三.3）──

export interface SyncStatusPayload {
  ok: true;
  applied: {
    bundleId: string;
    generatedAt: string;
    lastAppliedAt: string;
    sourceInstanceId: string;
  } | null;
  fleetHead: { branch: string; commit: string } | null;
  dims: Record<DimKey, AppliedDimStatus> | null;
  pending: { bundleId: string; generatedAt: string } | null;
  /** 已应用 project 维内容（i4-2 Phase D L1 三面比对服务器侧事实源；
   *  additive 字段，无 applied 或该维降级 = null）。 */
  project: BundleDim<BundleProject> | null;
  warnings: string[];
}
