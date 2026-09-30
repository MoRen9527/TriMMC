// ── Capability Router ──
// 3-tier matching: IO hard → authority soft → load tuning
// Source: TriMMC/docs/engineering/employee-orchestration-design.md §3.2

import type { EmployeeRecord, RoutingDecision } from './types.js';

// ── Tier 1: IO Contract Hard-Match ──

function matchIO(
  employee: EmployeeRecord,
  requiredOutputs: string[],
  decisionType?: string,
): { matches: boolean; coverage: number } {
  const io = employee.contract.io_contract;
  const targetOutputs = io?.outputs ?? [];

  if (requiredOutputs.length === 0) {
    return { matches: true, coverage: 100 };
  }

  const matched = requiredOutputs.filter((out) =>
    targetOutputs.some((t) => (t.type ?? '').toLowerCase() === out.toLowerCase()),
  );
  const coverage = Math.round((matched.length / requiredOutputs.length) * 100);

  // Phase A: >= 80% coverage is a pass. Later phases may require 100%.
  return { matches: coverage >= 80, coverage };
}

// ── Tier 2: Authority Soft-Match ──

function matchAuthority(
  employee: EmployeeRecord,
  decisionType?: string,
): boolean {
  if (!decisionType) return true; // no authority needed

  const rights = employee.contract.decision_rights;

  // Check explicit rights
  if (rights?.approve) {
    for (const a of rights.approve) {
      if (a.toLowerCase() === decisionType.toLowerCase()) return true;
    }
  }
  if (rights?.freeze) {
    for (const f of rights.freeze) {
      if (f.toLowerCase() === decisionType.toLowerCase()) return true;
    }
  }
  if (rights?.escalate) {
    for (const e of rights.escalate) {
      if (e.toLowerCase() === decisionType.toLowerCase()) return true;
    }
  }

  // Check forbidden
  if (rights?.forbidden) {
    for (const fb of rights.forbidden) {
      if (fb.toLowerCase() === decisionType.toLowerCase()) return false;
    }
  }

  // No explicit match → default to true (soft match)
  return true;
}

// ── Tier 3: Load Tuning ──

function isLoadAvailable(employee: EmployeeRecord): boolean {
  return employee.currentLoad < employee.maxConcurrentTasks;
}

// ── Score Calculation ──

function calculateScore(ioCoverage: number, authorityMatch: boolean, loadAvailable: boolean): number {
  let score = ioCoverage * 0.6;        // IO covers 60%
  if (authorityMatch) score += 25;     // authority 25%
  if (loadAvailable) score += 15;      // load 15%
  return score;
}

// ── Reporting Chain ──

function reportingEscalationPath(
  employees: EmployeeRecord[],
  primary: EmployeeRecord | null,
): EmployeeRecord[] {
  if (!primary) return [];
  const chain = primary.reportingChain ?? [];
  return chain
    .slice(1) // skip self
    .map((name) => employees.find((e) => {
      const dn = e.contract.identity?.display_name ?? '';
      const aid = e.contract.agent_id ?? '';
      return dn.toLowerCase() === name.toLowerCase() || aid.toLowerCase() === name.toLowerCase();
    }))
    .filter((e): e is EmployeeRecord => e !== undefined);
}

// ── Public API ──

/**
 * Route a task to the best-matched employee using 3-tier matching:
 * 1. IO contract hard-match (output coverage >= 80%)
 * 2. Authority soft-match (decision rights)
 * 3. Load tuning (capacity check)
 *
 * Phase A: no feedback loop, no ML tuning.
 */
export function route(
  employees: EmployeeRecord[],
  task: { type: string; expectedOutputs: string[]; decisionType?: string },
): RoutingDecision {
  const active = employees.filter((e) => e.status.state === 'active');

  // Evaluate all active employees — IO hard gate: fail employees who don't meet >=80%
  const scored = active
    .map((e) => {
      const ioResult = matchIO(e, task.expectedOutputs, task.decisionType);
      // Hard gate: IO coverage < 80% → disqualify entirely
      if (!ioResult.matches) return null;
      const authorityMatch = matchAuthority(e, task.decisionType);
      const loadAvailable = isLoadAvailable(e);
      const score = calculateScore(ioResult.coverage, authorityMatch, loadAvailable);

      return { employee: e, ioResult, authorityMatch, loadAvailable, score };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  const best = scored[0] ?? null;

  if (!best || best.score < 60) {
    // No acceptable match — try escalation from any active employee's chain
    const anyActive = active[0];
    const escalationPath = anyActive ? reportingEscalationPath(employees, anyActive) : [];
    return {
      matched: false,
      primary: null,
      alternatives: scored.filter((s) => s.score > 30).map((s) => s.employee),
      escalationPath,
      score: best?.score ?? 0,
      matchDetails: {
        ioCoverage: best?.ioResult.coverage ?? 0,
        authorityMatch: best?.authorityMatch ?? false,
        loadAvailable: best?.loadAvailable ?? false,
      },
    };
  }

  const primary = best.employee;
  const alternatives = scored
    .slice(1)
    .filter((s) => s.score >= 60)
    .map((s) => s.employee);
  const escalationPath = reportingEscalationPath(employees, primary);

  return {
    matched: true,
    primary,
    alternatives,
    escalationPath,
    score: best.score,
    matchDetails: {
      ioCoverage: best.ioResult.coverage,
      authorityMatch: best.authorityMatch,
      loadAvailable: best.loadAvailable,
    },
  };
}
