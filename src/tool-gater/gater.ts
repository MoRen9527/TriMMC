// ── TriMMC Unified Tool Gater ──
// CTO-011: Combines tier-based access (permissions.ts) with
// contract-driven risk evaluation (policy-gate) into a single
// canUseTool hook for the agent loop.
//
// Pipeline: PolicyGate (risk-level) + Tier (permissions) → unified check
// Injected into agentLoop via AgentLoopOptions.toolSpecs.

import { canUseTool, type AgentTier, type PermissionResult } from '../agent-loop/permissions.js';
import { PolicyGateService } from '../policy-gate/service.js';
import type { ToolSpec } from '../contracts/agent-contract.js';

// Re-export for convenience
export type { AgentTier, PermissionResult };
export type { ToolSpec };

const policyGate = new PolicyGateService();

// ── Unified Tool Permission Check ──

/**
 * Check tool permission combining two layers:
 * 1. Tier-based access (which tiers can use which tools)
 * 2. Contract-driven risk evaluation (low→auto, medium→audit, high→block, critical→deny)
 *
 * When toolSpecs is not provided, only tier check applies (backward compatible).
 */
export function checkToolPermission(
  toolName: string,
  tier: AgentTier,
  toolSpecs?: ToolSpec[],
): PermissionResult {
  // Layer 1: Tier check
  const tierResult = canUseTool(toolName, tier);
  if (!tierResult.allowed) return tierResult;

  // Layer 2: Risk-level check (only when contract toolSpecs provided)
  if (toolSpecs && toolSpecs.length > 0) {
    const spec = toolSpecs.find((t) => t.name === toolName);
    if (spec) {
      const riskResult = policyGate.evaluateTool(spec);
      if (!riskResult.allowed) {
        return {
          allowed: false,
          reason: `[risk:${spec.risk_level}] ${riskResult.reason}`,
        };
      }
      // medium → allowed but with audit tag in reason
      if (spec.risk_level === 'medium') {
        return { allowed: true, reason: 'allowed_with_audit' };
      }
    }
  }

  return { allowed: true };
}

// ── Gater Factory ──

/** Function signature for a bound tool gater hook */
export type ToolGaterFn = (toolName: string, tier: AgentTier) => PermissionResult;

/**
 * Create a bound tool gater from contract tool specs.
 * Returns a function usable as a hook in the agent loop's tool dispatch.
 */
export function createToolGater(toolSpecs?: ToolSpec[]): ToolGaterFn {
  return (toolName: string, tier: AgentTier) =>
    checkToolPermission(toolName, tier, toolSpecs);
}

// ── Summary ──

/** Risk-level summary for logging/debugging */
export interface GaterSummary {
  totalTools: number;
  byRiskLevel: Record<string, string[]>;
  highRiskTools: string[];
  criticalRiskTools: string[];
}

/**
 * Build a human-readable summary of the gater configuration.
 * Useful for loop_start logging and debugging.
 */
export function summarizeGater(toolSpecs?: ToolSpec[]): GaterSummary {
  const tools = toolSpecs ?? [];
  const byRisk: Record<string, string[]> = {
    low: [],
    medium: [],
    high: [],
    critical: [],
  };

  for (const t of tools) {
    const bucket = byRisk[t.risk_level];
    if (bucket) bucket.push(t.name);
  }

  return {
    totalTools: tools.length,
    byRiskLevel: byRisk,
    highRiskTools: byRisk.high,
    criticalRiskTools: byRisk.critical,
  };
}
