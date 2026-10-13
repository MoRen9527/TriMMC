// ── Cost Controller ──
// 3-layer budget: company-daily, employee-daily, per-task
// Source: TriMMC/docs/engineering/employee-orchestration-design.md §3.4

import type {
  EmployeeRecord,
  ModelTier,
  ModelTierPolicy,
  BudgetState,
  CostRecord,
} from './types.js';

// ── Model Tier Policies ──

const TIERS: Record<ModelTier, ModelTierPolicy> = {
  thinking: {
    tier: 'thinking',
    maxTokensPerTurn: 250_000,
    allowedModels: ['gpt-5.1', 'claude-4.5', 'gemini-3.0-pro'],
    defaultModel: 'claude-4.5',
    fallbackChain: ['gpt-5.1', 'gemini-3.0-pro'],
  },
  balanced: {
    tier: 'balanced',
    maxTokensPerTurn: 100_000,
    allowedModels: ['claude-4.5', 'gpt-5.1'],
    defaultModel: 'claude-4.5',
    fallbackChain: ['gpt-5.1'],
  },
  fast: {
    tier: 'fast',
    maxTokensPerTurn: 32_000,
    allowedModels: ['gpt-5.1-nano', 'haiku'],
    defaultModel: 'gpt-5.1-nano',
    fallbackChain: ['haiku'],
  },
};

// ── Pricing (USD per 1M tokens, approximate) ──

const PRICING: Record<string, number> = {
  'gpt-5.1': 15.0,
  'claude-4.5': 15.0,
  'gemini-3.0-pro': 10.0,
  'gpt-5.1-nano': 2.0,
  haiku: 1.0,
};

// ── Default Caps ──

const DEFAULT_COMPANY_DAILY = 50.0;   // USD
const DEFAULT_COMPANY_MONTHLY = 500.0;
const DEFAULT_EMPLOYEE_DAILY = 10.0;
const DEFAULT_EMPLOYEE_MONTHLY = 50.0;

// ── Budget State ──

let _budget: BudgetState = {
  companyDailyUsed: 0,
  companyMonthlyUsed: 0,
  employeeDailyUsed: new Map(),
  employeeMonthlyUsed: new Map(),
  lastResetDay: new Date().toISOString().slice(0, 10),
  lastResetMonth: new Date().toISOString().slice(0, 7),
};

let _costLog: CostRecord[] = [];

// ── Internal Helpers ──

function estimateTokens(expectedOutputs: string[]): number {
  // Phase A: rough estimate. Later phases: query model context window.
  const perOutput = 20_000;
  return Math.max(10_000, expectedOutputs.length * perOutput);
}

function computeCost(tokens: number, model: string): number {
  const pricePerM = PRICING[model] ?? 5.0;
  return (tokens / 1_000_000) * pricePerM;
}

function ensureDailyReset(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (_budget.lastResetDay !== today) {
    _budget.companyDailyUsed = 0;
    _budget.employeeDailyUsed.clear();
    _budget.lastResetDay = today;
  }
}

function ensureMonthlyReset(): void {
  const thisMonth = new Date().toISOString().slice(0, 7);
  if (_budget.lastResetMonth !== thisMonth) {
    _budget.companyMonthlyUsed = 0;
    _budget.employeeMonthlyUsed.clear();
    _budget.lastResetMonth = thisMonth;
  }
}

// ── Public API ──

/**
 * Estimate the cost of a task before dispatch.
 */
export function estimateCost(employee: EmployeeRecord, expectedOutputs: string[]): {
  estimatedTokens: number;
  estimatedCostUSD: number;
  modelTier: string;
} {
  const tier = employee.costProfile.modelTier;
  const tierPolicy = TIERS[tier];
  const tokens = Math.min(estimateTokens(expectedOutputs), tierPolicy.maxTokensPerTurn);
  const cost = computeCost(tokens, tierPolicy.defaultModel);

  return {
    estimatedTokens: tokens,
    estimatedCostUSD: Math.round(cost * 1000) / 1000,
    modelTier: tier,
  };
}

/**
 * Check 3-layer budget before dispatch.
 * Returns { approved, reason } — if not approved, reason explains which cap was exceeded.
 */
export function checkBudget(
  employee: EmployeeRecord,
  estimatedTokens: number,
  estimatedCost: number,
): { approved: boolean; reason?: string } {
  ensureDailyReset();
  ensureMonthlyReset();

  // Layer 1: Company daily cap
  if (_budget.companyDailyUsed + estimatedCost > DEFAULT_COMPANY_DAILY) {
    return { approved: false, reason: `Company daily cap exceeded (${DEFAULT_COMPANY_DAILY} USD)` };
  }

  // Layer 2: Employee daily cap
  const empDaily = _budget.employeeDailyUsed.get(employee.employeeId) ?? 0;
  if (empDaily + estimatedCost > DEFAULT_EMPLOYEE_DAILY) {
    return {
      approved: false,
      reason: `Employee daily cap exceeded (${DEFAULT_EMPLOYEE_DAILY} USD) for ${employee.employeeId}`,
    };
  }

  // Layer 3: Per-task cap
  if (estimatedCost > employee.costProfile.maxCostPerTask) {
    return {
      approved: false,
      reason: `Per-task cap exceeded (max ${employee.costProfile.maxCostPerTask} USD, estimated ${estimatedCost})`,
    };
  }

  return { approved: true };
}

/**
 * Record actual cost after task execution.
 */
export function recordCost(
  employeeId: string,
  taskId: string,
  tokensConsumed: number,
  modelUsed: string,
): CostRecord {
  ensureDailyReset();
  ensureMonthlyReset();

  const cost = computeCost(tokensConsumed, modelUsed);

  _budget.companyDailyUsed += cost;
  _budget.companyMonthlyUsed += cost;
  _budget.employeeDailyUsed.set(
    employeeId,
    (_budget.employeeDailyUsed.get(employeeId) ?? 0) + cost,
  );
  _budget.employeeMonthlyUsed.set(
    employeeId,
    (_budget.employeeMonthlyUsed.get(employeeId) ?? 0) + cost,
  );

  const record: CostRecord = {
    employeeId,
    taskId,
    tokensConsumed,
    modelUsed,
    costUSD: Math.round(cost * 1000) / 1000,
    timestamp: new Date().toISOString(),
  };
  _costLog.push(record);
  return record;
}

/**
 * Get current budget state (for monitoring / status queries).
 */
export function getBudgetState(): BudgetState {
  ensureDailyReset();
  ensureMonthlyReset();
  return {
    companyDailyUsed: _budget.companyDailyUsed,
    companyMonthlyUsed: _budget.companyMonthlyUsed,
    employeeDailyUsed: new Map(_budget.employeeDailyUsed),
    employeeMonthlyUsed: new Map(_budget.employeeMonthlyUsed),
    lastResetDay: _budget.lastResetDay,
    lastResetMonth: _budget.lastResetMonth,
  };
}

/**
 * Get model tier policy for a given tier.
 */
export function getModelTierPolicy(tier: ModelTier): ModelTierPolicy {
  return { ...TIERS[tier] };
}

/**
 * Reset budget state (for testing).
 */
export function resetBudget(): void {
  _budget = {
    companyDailyUsed: 0,
    companyMonthlyUsed: 0,
    employeeDailyUsed: new Map(),
    employeeMonthlyUsed: new Map(),
    lastResetDay: new Date().toISOString().slice(0, 10),
    lastResetMonth: new Date().toISOString().slice(0, 7),
  };
  _costLog = [];
}
