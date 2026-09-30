// ── TriMMC Prompt Cache Tests ──
// Phase 2 Tier 1: Cache annotation infrastructure unit tests.

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import type { Message, ToolDefinition } from 'trimodel';
import {
  createCacheState,
  updateCacheState,
  computeSystemPromptHash,
  computeToolsHash,
  estimateCacheHit,
  buildCacheMetrics,
  getCacheControlConfig,
  resetCacheStateForNewSession,
} from '../../src/prompt-cache/index.js';

// ── Test Helpers ──

const MOCK_SYSTEM: Message = { role: 'system', content: 'You are a helpful assistant.' };
const MOCK_USER: Message = { role: 'user', content: 'Hello' };
const MOCK_TOOLS: ToolDefinition[] = [
  { type: 'function', function: { name: 'test_tool', description: 'A test tool', parameters: {} } },
  { type: 'function', function: { name: 'test_tool2', description: 'Another test tool', parameters: {} } },
];

// ── Hash Utilities ──

describe('computeSystemPromptHash', () => {
  it('returns null when no system message exists', () => {
    assert.strictEqual(computeSystemPromptHash([MOCK_USER]), null);
  });

  it('returns null when system message has null content', () => {
    assert.strictEqual(computeSystemPromptHash([{ role: 'system', content: null }]), null);
  });

  it('returns a 64-char hex string for valid system prompt', () => {
    const hash = computeSystemPromptHash([MOCK_SYSTEM, MOCK_USER]);
    assert.ok(typeof hash === 'string');
    assert.strictEqual(hash!.length, 64);
  });

  it('returns same hash for identical content', () => {
    const h1 = computeSystemPromptHash([MOCK_SYSTEM]);
    const h2 = computeSystemPromptHash([{ role: 'system', content: 'You are a helpful assistant.' }]);
    assert.strictEqual(h1, h2);
  });

  it('returns different hash for different content', () => {
    const h1 = computeSystemPromptHash([MOCK_SYSTEM]);
    const h2 = computeSystemPromptHash([{ role: 'system', content: 'Different prompt' }]);
    assert.notStrictEqual(h1, h2);
  });
});

describe('computeToolsHash', () => {
  it('returns null for undefined tools', () => {
    assert.strictEqual(computeToolsHash(undefined), null);
  });

  it('returns null for empty tools array', () => {
    assert.strictEqual(computeToolsHash([]), null);
  });

  it('returns a 64-char hex string for valid tools', () => {
    const hash = computeToolsHash(MOCK_TOOLS);
    assert.ok(typeof hash === 'string');
    assert.strictEqual(hash!.length, 64);
  });

  it('returns same hash for identical tools (canonical key order)', () => {
    const tools2: ToolDefinition[] = [
      { function: { name: 'test_tool', description: 'A test tool', parameters: {} }, type: 'function' as const },
      { function: { name: 'test_tool2', description: 'Another test tool', parameters: {} }, type: 'function' as const },
    ];
    assert.strictEqual(computeToolsHash(MOCK_TOOLS), computeToolsHash(tools2));
  });
});

// ── State Management ──

describe('createCacheState', () => {
  it('returns a fresh state with all nulls/zeros', () => {
    const state = createCacheState();
    assert.strictEqual(state.systemPromptHash, null);
    assert.strictEqual(state.toolsHash, null);
    assert.strictEqual(state.lastTurn, 0);
    assert.strictEqual(state.systemPromptChanged, false);
    assert.strictEqual(state.toolsChanged, false);
    assert.strictEqual(state.prevPromptTokens, null);
  });
});

describe('updateCacheState', () => {
  it('sets hashes on first update without flagging changes', () => {
    const state = createCacheState();
    updateCacheState(state, [MOCK_SYSTEM], MOCK_TOOLS, 1);

    assert.ok(state.systemPromptHash !== null);
    assert.ok(state.toolsHash !== null);
    assert.strictEqual(state.systemPromptChanged, false);
    assert.strictEqual(state.toolsChanged, false);
    assert.strictEqual(state.lastTurn, 1);
  });

  it('detects system prompt change on second update', () => {
    const state = createCacheState();
    updateCacheState(state, [MOCK_SYSTEM], MOCK_TOOLS);
    updateCacheState(state, [{ role: 'system', content: 'New prompt' }], MOCK_TOOLS);

    assert.strictEqual(state.systemPromptChanged, true);
    assert.strictEqual(state.toolsChanged, false);
  });

  it('detects tool change on second update', () => {
    const state = createCacheState();
    updateCacheState(state, [MOCK_SYSTEM], MOCK_TOOLS);
    const newTools: ToolDefinition[] = [
      { type: 'function', function: { name: 'new_tool', description: 'New', parameters: {} } },
    ];
    updateCacheState(state, [MOCK_SYSTEM], newTools);

    assert.strictEqual(state.toolsChanged, true);
    assert.strictEqual(state.systemPromptChanged, false);
  });

  it('resets change flags when content returns to original', () => {
    const state = createCacheState();
    updateCacheState(state, [MOCK_SYSTEM], MOCK_TOOLS);
    updateCacheState(state, [{ role: 'system', content: 'Changed' }], MOCK_TOOLS);
    assert.strictEqual(state.systemPromptChanged, true);

    // Third update — system prompt didn't change from second to third
    updateCacheState(state, [{ role: 'system', content: 'Changed' }], MOCK_TOOLS);
    assert.strictEqual(state.systemPromptChanged, false);
  });
});

// ── Cache Hit Estimation ──

describe('estimateCacheHit', () => {
  it('returns no-hit on first call (no baseline)', () => {
    const state = createCacheState();
    const result = estimateCacheHit(state, 5000);
    assert.strictEqual(result.hit, false);
    assert.strictEqual(result.savedTokens, 0);
  });

  it('returns no-hit when cache was invalidated (system prompt changed)', () => {
    const state = createCacheState();
    state.systemPromptHash = 'old';
    state.prevPromptTokens = 20000;
    state.systemPromptChanged = true;

    const result = estimateCacheHit(state, 5000);
    assert.strictEqual(result.hit, false);
    // prevPromptTokens should be updated to current
    assert.strictEqual(state.prevPromptTokens, 5000);
  });

  it('returns hit when tokens drop >= 2000 (absolute threshold)', () => {
    const state = createCacheState();
    state.systemPromptHash = 'h1';
    state.prevPromptTokens = 20000;
    state.systemPromptChanged = false;

    const result = estimateCacheHit(state, 17000);
    assert.strictEqual(result.hit, true);
    assert.strictEqual(result.savedTokens, 3000);
  });

  it('returns hit when tokens drop >= 5% (percentage threshold)', () => {
    const state = createCacheState();
    state.systemPromptHash = 'h1';
    state.prevPromptTokens = 1000;
    state.systemPromptChanged = false;

    // 6% drop: 1000 → 940
    const result = estimateCacheHit(state, 940);
    assert.strictEqual(result.hit, true);
    assert.strictEqual(result.savedTokens, 60);
  });

  it('returns no-hit when drop is small and under both thresholds', () => {
    const state = createCacheState();
    state.systemPromptHash = 'h1';
    state.prevPromptTokens = 10000;
    state.systemPromptChanged = false;

    // 1% drop (100 tokens): under 2000 absolute, under 5%
    const result = estimateCacheHit(state, 9900);
    assert.strictEqual(result.hit, false);
    assert.strictEqual(result.savedTokens, 0);
  });

  it('returns no-hit when tokens increase (cache miss)', () => {
    const state = createCacheState();
    state.systemPromptHash = 'h1';
    state.prevPromptTokens = 5000;
    state.systemPromptChanged = false;

    const result = estimateCacheHit(state, 8000);
    assert.strictEqual(result.hit, false);
    assert.strictEqual(result.savedTokens, 0);
  });
});

// ── Metrics ──

describe('buildCacheMetrics', () => {
  it('builds a complete metrics snapshot on first turn', () => {
    const state = createCacheState();
    // First turn: initialize cache state properly through updateCacheState
    updateCacheState(state, [MOCK_SYSTEM], MOCK_TOOLS, 1);
    // Turn 1: first API call, no prior baseline — no hit possible
    const m1 = buildCacheMetrics(state, 15000, 1);

    assert.strictEqual(m1.turn, 1);
    assert.strictEqual(m1.promptTokens, 15000);
    assert.strictEqual(m1.estimatedCacheHit, false);
    assert.strictEqual(m1.estimatedSavedTokens, 0);
    assert.strictEqual(m1.cacheInvalidated, false);
  });

  it('reports cache hit on second turn when tokens drop', () => {
    const state = createCacheState();
    updateCacheState(state, [MOCK_SYSTEM], MOCK_TOOLS, 1);
    buildCacheMetrics(state, 15000, 1); // Turn 1 baseline

    // Turn 2: same system prompt + tools, but fewer tokens → cache hit
    updateCacheState(state, [MOCK_SYSTEM], MOCK_TOOLS, 2);
    const m2 = buildCacheMetrics(state, 8000, 2);

    assert.strictEqual(m2.turn, 2);
    assert.strictEqual(m2.estimatedCacheHit, true);
    assert.strictEqual(m2.estimatedSavedTokens, 7000);
    assert.strictEqual(m2.cacheInvalidated, false);
  });

  it('reports cacheInvalidated when system prompt changed', () => {
    const state = createCacheState();
    state.systemPromptHash = 'old';
    state.prevPromptTokens = 10000;
    state.systemPromptChanged = true;

    const m = buildCacheMetrics(state, 12000, 2);
    assert.strictEqual(m.cacheInvalidated, true);
  });
});

// ── Cache Control Config ──

describe('getCacheControlConfig', () => {
  it('returns disabled for DeepSeek (current default)', () => {
    const config = getCacheControlConfig('deepseek-v4-pro');
    assert.strictEqual(config.enabled, false);
    assert.strictEqual(config.ttl, '5min');
    assert.strictEqual(config.annotateSystemPrompt, false);
    assert.strictEqual(config.annotateLastMessage, false);
  });

  it('returns disabled for any model currently', () => {
    const config = getCacheControlConfig('claude-sonnet-4-5');
    assert.strictEqual(config.enabled, false);
  });
});

// ── Session Lifecycle ──

describe('resetCacheStateForNewSession', () => {
  it('clears all state fields', () => {
    const state = createCacheState();
    state.systemPromptHash = 'h1';
    state.toolsHash = 't1';
    state.lastTurn = 5;
    state.systemPromptChanged = true;
    state.toolsChanged = true;
    state.prevPromptTokens = 10000;

    resetCacheStateForNewSession(state);

    assert.strictEqual(state.systemPromptHash, null);
    assert.strictEqual(state.toolsHash, null);
    assert.strictEqual(state.lastTurn, 0);
    assert.strictEqual(state.systemPromptChanged, false);
    assert.strictEqual(state.toolsChanged, false);
    assert.strictEqual(state.prevPromptTokens, null);
  });
});
