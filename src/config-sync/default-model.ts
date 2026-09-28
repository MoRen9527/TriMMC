// ── 模型层 default 收敛（§四）──
// LG-058 P1 §4.3 层级合并裁（2026-09-29，P0 方案显式呈裁采认）——四级解析
// （读取时解析；bundle 维 mtime 轻缓存，D3 同口径）：
//   env TRIMC_DEFAULT_MODEL（运维逃生门，最高优先）>
//   TriModel 卡面 tier1/tier2（config/key-cache.ts：fresh→card-fresh，
//   TTL 过期 7 天宽限内→card-stale-grace，>7 天丢弃落下一级）>
//   applied bundle model.defaultModel（TRIMC_CONFIG_DIR/init-sync/model.json）>
//   常量兜底（旧名仅存在于兜底常量位——无卡无 applied 时行为与现状一致，零回归面）。
// 理由（方案 §4.3 本席裁采认文）：卡面=活配置管理面（网页/CLI 可改可审计），
// bundle=基座分发面（随 TriCompany 仓走，低频）——活配置压基座、显式压活配置。
//
// flash 变体（/hello 端点）：applied bundle model.catalog 内 flash 别名
// （id 含 flash 的 tmv-* 正典名）> FLASH_MODEL_FALLBACK 常量。契约只设
// TRIMC_DEFAULT_MODEL 一个 env 条目，flash 无独立 env（i4-1 §四）。
//
// 旧名 deepseek-v4-pro/flash 不再出现在源码常量（除本文件兜底常量位）。

import { readFile, stat } from 'node:fs/promises';
import { dimFilePath, defaultConfigDir } from './status.js';
import { getKeyCache } from '../config/key-cache.js';
import type { BundleModel } from './types.js';

// ── 兜底常量位（旧名唯一允许位置；trimodel registry 向后兼容别名）──

export const DEFAULT_MODEL_FALLBACK = 'deepseek-v4-pro';
export const FLASH_MODEL_FALLBACK = 'deepseek-v4-flash';

// ── model.json 读取（mtime 轻缓存，TTL ≤ 10s）──

interface ModelFileCacheEntry {
  mtimeMs: number;
  readAtMs: number;
  model: BundleModel | null;
}

let _modelFileCache: { path: string; entry: ModelFileCacheEntry } | null = null;

const MODEL_CACHE_TTL_MS = 10_000;

export function resetModelCacheForTest(): void {
  _modelFileCache = null;
}

async function readAppliedModel(configDir: string): Promise<BundleModel | null> {
  const path = dimFilePath(configDir, 'model');
  let st;
  try {
    st = await stat(path);
  } catch {
    return null;
  }
  if (
    _modelFileCache &&
    _modelFileCache.path === path &&
    _modelFileCache.entry.mtimeMs === st.mtimeMs &&
    Date.now() - _modelFileCache.entry.readAtMs < MODEL_CACHE_TTL_MS
  ) {
    return _modelFileCache.entry.model;
  }
  let model: BundleModel | null = null;
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<BundleModel>;
    // unavailable 降级段（status 字段）或坏形状 → null（落入下一级）
    if (typeof parsed.defaultModel === 'string' && Array.isArray(parsed.catalog)) {
      model = parsed as BundleModel;
    }
  } catch {
    model = null;
  }
  _modelFileCache = { path, entry: { mtimeMs: st.mtimeMs, readAtMs: Date.now(), model } };
  return model;
}

// ── §4.3 四级解析（LG-058 P1）──

/** 生效来源归因码（config show ladder 投影用；§4.3 梯位命名）。 */
export type DefaultModelSource =
  | 'env-escape'
  | 'card-fresh'
  | 'card-stale-grace'
  | 'fleet-bundle'
  | 'constant';

/**
 * default/pro 模型全梯解析（模型+来源归因）：
 * env 逃生门 > 卡面 cache（fresh/stale-grace）> fleet bundle > 兜底常量。
 */
export async function resolveDefaultModelDetailed(
  configDir: string = defaultConfigDir(),
): Promise<{ model: string; source: DefaultModelSource }> {
  const envModel = process.env.TRIMC_DEFAULT_MODEL?.trim();
  if (envModel) return { model: envModel, source: 'env-escape' };
  const cache = getKeyCache();
  if (cache?.defaultModel) {
    const fresh = Date.now() <= cache.expiresAt;
    return { model: cache.defaultModel, source: fresh ? 'card-fresh' : 'card-stale-grace' };
  }
  const applied = await readAppliedModel(configDir);
  if (applied?.defaultModel) return { model: applied.defaultModel, source: 'fleet-bundle' };
  return { model: DEFAULT_MODEL_FALLBACK, source: 'constant' };
}

/** default/pro 模型：env > 卡面 cache > applied model.defaultModel > 兜底常量。 */
export async function resolveDefaultModel(configDir: string = defaultConfigDir()): Promise<string> {
  return (await resolveDefaultModelDetailed(configDir)).model;
}

/**
 * flash 模型：applied catalog 内 flash 别名（id 匹配 /flash/i 的正典名）
 * > 兜底常量。无 applied 时行为与现状一致（旧名兜底），零回归面。
 */
export async function resolveFlashModel(configDir: string = defaultConfigDir()): Promise<string> {
  const applied = await readAppliedModel(configDir);
  if (applied) {
    const flash = applied.catalog.find((entry) => /flash/i.test(entry.id));
    if (flash?.id) return flash.id;
  }
  return FLASH_MODEL_FALLBACK;
}
