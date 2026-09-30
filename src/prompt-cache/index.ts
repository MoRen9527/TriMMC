// ── TriMMC Prompt Cache Module ──
// Phase 2 Tier 1: Cache annotation infrastructure.
//
// Exports:
//   Core: CacheState, CacheMetrics, CacheControlConfig
//   State: createCacheState, updateCacheState, resetCacheStateForNewSession
//   Hash:  computeSystemPromptHash, computeToolsHash
//   Metrics: estimateCacheHit, buildCacheMetrics
//   Config: getCacheControlConfig

export {
  createCacheState,
  updateCacheState,
  resetCacheStateForNewSession,
} from './cache-control.js';

export {
  computeSystemPromptHash,
  computeToolsHash,
} from './cache-control.js';

export {
  estimateCacheHit,
  buildCacheMetrics,
} from './cache-control.js';

export {
  getCacheControlConfig,
} from './cache-control.js';

export type {
  CacheState,
  CacheMetrics,
  CacheControlConfig,
} from './cache-control.js';
