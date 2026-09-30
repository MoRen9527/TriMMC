// ── Employee Orchestration Layer Types ──
// TriMMC: Employee Registry, Capability Router, Scheduler, Cost Controller, Dispatch Proxy
// Source: TriMMC/docs/engineering/employee-orchestration-design.md §3

import type { AgentContract } from '../contracts/agent-contract.js';

// ── Employee Status ──

export type EmployeeState = 'active' | 'standby' | 'offline' | 'onboarding' | 'suspended';

export interface EmployeeStatus {
  state: EmployeeState;
  since: string;   // ISO datetime
  reason?: string;
}

// ── Cost Profile ──

export interface EmployeeCostProfile {
  dailyTokenBudget: number;
  modelTier: ModelTier;
  maxCostPerTask: number;   // USD
  monthlyCostCap: number;   // USD
}

// ── Employee Record ──

export interface EmployeeRecord {
  employeeId: string;
  contract: AgentContract;
  status: EmployeeStatus;
  currentLoad: number;
  maxConcurrentTasks: number;
  activeSkills: string[];
  costProfile: EmployeeCostProfile;
  reportingChain: string[];   // [self, manager, ..., ceo]
}

// ── Task ──

export type TaskPriority = 'P0' | 'P1' | 'P2';

export type TaskState =
  | 'queued'
  | 'assigned'
  | 'running'
  | 'escalated'
  | 'accepted'
  | 'rejected'
  | 'done';

export interface TaskRecord {
  taskId: string;
  type: string;
  priority: TaskPriority;
  description: string;
  expectedOutputs: string[];
  decisionType?: string;
  state: TaskState;
  assignedTo?: string;
  requester: string;
  parentTaskId?: string;
  createdAt: string;
  updatedAt: string;
  retryCount: number;
}

// ── Routing ──

export interface RoutingDecision {
  matched: boolean;
  primary: EmployeeRecord | null;
  alternatives: EmployeeRecord[];
  escalationPath: EmployeeRecord[];
  score: number;                // 0-100
  matchDetails: {
    ioCoverage: number;         // percent
    authorityMatch: boolean;
    loadAvailable: boolean;
  };
}

// ── Dispatch ──

export interface DispatchRequest {
  task: {
    type: string;
    priority: TaskPriority;
    description: string;
    expectedOutputs: string[];
    decisionType?: string;
  };
  requester: string;
  context?: {
    parentTaskId?: string;
    ipdPhase?: string;
    deadline?: string;
  };
}

export interface DispatchTraceEntry {
  step: string;
  success: boolean;
  message: string;
  timestamp: string;
}

export interface DispatchResult {
  success: boolean;
  assignedTo?: string;
  escalationTo?: string;
  rejectionReason?: string;
  costEstimate?: {
    estimatedTokens: number;
    estimatedCostUSD: number;
    modelTier: string;
  };
  trace: DispatchTraceEntry[];
}

// ── Model Tiers ──

export type ModelTier = 'thinking' | 'balanced' | 'fast';

export interface ModelTierPolicy {
  tier: ModelTier;
  maxTokensPerTurn: number;
  allowedModels: string[];
  defaultModel: string;
  fallbackChain: string[];
}

// ── Task Classifier ──

export interface TaskClassification {
  type: string;
  expectedOutputs: string[];
  decisionType?: string;
  priority: TaskPriority;
}

// ── Cost Tracking ──

export interface CostRecord {
  employeeId: string;
  taskId: string;
  tokensConsumed: number;
  modelUsed: string;
  costUSD: number;
  timestamp: string;
}

// ── Budget State ──

export interface BudgetState {
  companyDailyUsed: number;
  companyMonthlyUsed: number;
  employeeDailyUsed: Map<string, number>;
  employeeMonthlyUsed: Map<string, number>;
  lastResetDay: string;
  lastResetMonth: string;
}

// ── Scheduler Config ──

export interface SchedulerConfig {
  maxConcurrentTotal: number;
  defaultTaskTimeoutMs: number;
  maxRetries: number;
}
