// ── Employee Registry ──
// Phase A: static contract loading via loadContract/resolveContracts
// Source: TriMMC/docs/engineering/employee-orchestration-design.md §3.1

import { resolveContracts } from '../contracts/resolver.js';
import type { AgentContract } from '../contracts/agent-contract.js';
import type { EmployeeRecord, EmployeeStatus, EmployeeCostProfile } from './types.js';

// ── Default overrides for Phase A (contracts may lack runtime fields) ──

const DEFAULT_MAX_CONCURRENT = 2;

const DEFAULT_COST_PROFILE: EmployeeCostProfile = {
  dailyTokenBudget: 500_000,
  modelTier: 'balanced',
  maxCostPerTask: 2.0,
  monthlyCostCap: 50.0,
};

function deriveStatus(contract: AgentContract): EmployeeStatus {
  // Phase A: all employees start as active. Later phases add on/off-boarding state.
  return {
    state: 'active',
    since: new Date().toISOString(),
    reason: 'Phase A default: contract loaded',
  };
}

function deriveSkills(contract: AgentContract): string[] {
  const skills: string[] = [];
  if (contract.responsibilities?.length) {
    for (const r of contract.responsibilities) {
      skills.push(r.description);
    }
  }
  if (contract.tools?.length) {
    for (const t of contract.tools) {
      if (t.name) skills.push(`tool:${t.name}`);
    }
  }
  return skills;
}

function deriveReportingChain(contract: AgentContract): string[] {
  const chain: string[] = [contract.identity?.display_name || contract.agent_id || 'unknown'];
  if (contract.collaborators?.reports_to) {
    chain.push(contract.collaborators.reports_to);
  }
  // Phase A: 2-level chain. Later phases walk full org tree.
  return chain;
}

function contractToEmployee(contract: AgentContract): EmployeeRecord {
  const id = (contract.agent_id || contract.identity?.display_name || 'unknown')
    .toLowerCase().replace(/\s+/g, '-');

  return {
    employeeId: id,
    contract,
    status: deriveStatus(contract),
    currentLoad: 0,
    maxConcurrentTasks: DEFAULT_MAX_CONCURRENT,
    activeSkills: deriveSkills(contract),
    costProfile: DEFAULT_COST_PROFILE,
    reportingChain: deriveReportingChain(contract),
  };
}

// ── Public API ──

export interface LoadResult {
  employees: EmployeeRecord[];
  errors: { employeeId: string; path: string; message: string }[];
}

/**
 * Load employee records from contract YAML files in the given directory.
 * Uses resolveContracts() for loading; wraps each valid contract into an EmployeeRecord.
 * Phase A: stateless, in-memory only.
 */
export function loadEmployeeRegistry(registryDir: string): LoadResult {
  const { contracts, errors } = resolveContracts(registryDir);

  const employees: EmployeeRecord[] = [];
  const loadErrors: LoadResult['errors'] = [];

  for (const contract of contracts) {
    // batch-15 件③追裁连带（CTO 2026-10-02）：agent-core Registry family 分支后
    // board/business-strategy 两 Registry 席合法加载——员工 roster 面=Role 席 only，
    // 显式 family 过滤（此前系 schema 拒绝「恰好排除」，Registry 合法化后该机制消解，
    // 须显式维持 13 席 roster 纯度；Registry 席=合法排除，不进 errors 不进 employees）。
    if (contract.identity.family !== 'Role') continue;
    try {
      const employee = contractToEmployee(contract);
      employees.push(employee);
    } catch (e) {
      const name = contract.agent_id || contract.identity?.display_name || 'unknown';
      loadErrors.push({
        employeeId: name.toLowerCase().replace(/\s+/g, '-'),
        path: `contract:${name}`,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Map resolver errors to load errors
  for (const re of errors) {
    loadErrors.push({
      employeeId: 'unknown',
      path: re.path,
      message: re.message,
    });
  }

  return { employees, errors: loadErrors };
}
