// ── TriMMC Permission Engine Types ──
// CTO-003 P4T1: Absorbed from Claude Code 2.1.88 vendor (types/permissions.ts).
// Tier 1 MVP: PermissionMode (3 modes), PermissionRule (8-source priority),
// DecisionResult (allow/deny/ask), and decision pipeline context.

// ── PermissionMode (Tier 1: 3 of 7 Claude Code modes) ──

/**
 * Permission mode determines the default behavior for tool execution.
 *
 * - `default`: Standard mode — every tool call requires explicit confirmation.
 * - `acceptEdits`: Auto-accept edit operations within the current working directory.
 * - `bypassPermissions`: Skip all permission checks (Safety Check still applies — bypass-immune).
 *
 * Tier 2+: plan, dontAsk, auto, bubble
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions';

// ── PermissionBehavior ──

/** The three possible behaviors a rule can specify. */
export type PermissionBehavior = 'allow' | 'deny' | 'ask';

// ── Decision Outcome ──

/** The decision from the permission pipeline for a single tool invocation. */
export interface DecisionResult {
  /** Whether the tool is allowed to execute */
  allowed: boolean;
  /**
   * The resolved behavior:
   * - 'allow': execute immediately
   * - 'deny': block execution
   * - 'ask': requires user confirmation (Tier 2+ interactive prompt, currently treated as deny)
   */
  behavior: PermissionBehavior;
  /** Human-readable reason for the decision */
  reason?: string;
  /** Which step in the pipeline made the final decision */
  decidedBy?: DecisionStep;
}

/** Named steps in the decision pipeline for audit trail. */
export type DecisionStep =
  | 'always_deny'
  | 'always_ask'
  | 'safety_check'
  | 'mode_bypass'
  | 'mode_accept_edits'
  | 'always_allow'
  | 'default_deny';

// ── Rule Source Priority (8 sources, highest first) ──

/**
 * Rule sources ordered by priority (Tier 1: 5 sources).
 *
 * Priority chain: userSettings > projectSettings > localSettings > cliArg > session
 * Tier 2+: flagSettings, policySettings, command
 */
export const RULE_SOURCE_PRIORITY: Record<RuleSource, number> = {
  userSettings: 100,
  projectSettings: 90,
  localSettings: 80,
  flagSettings: 70,
  policySettings: 60,
  cliArg: 50,
  command: 40,
  session: 30,
};

export type RuleSource =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'flagSettings'
  | 'policySettings'
  | 'cliArg'
  | 'command'
  | 'session';

// ── PermissionRule ──

/**
 * A single permission rule.
 *
 * Format (Claude Code compatible):
 *   "ToolName"           → applies to all invocations of that tool
 *   "ToolName(content)"  → applies only when arguments contain the content substring
 *   "Bash(git push)"     → exact match for Bash commands
 *   "Bash(curl *)"       → wildcard match for Bash commands
 */
export interface PermissionRule {
  /** Which tool this rule applies to (e.g., 'Bash', 'write_file') */
  toolName: string;
  /** Optional content filter — if set, rule only applies when args contain this substring */
  content?: string;
  /** The behavior: allow, deny, or ask */
  behavior: PermissionBehavior;
  /** Where this rule came from (determines priority in conflict resolution) */
  source: RuleSource;
  /** Whether this is a wildcard content match (for Bash prefix rules like "curl *") */
  isWildcard?: boolean;
}

// ── Decision Pipeline Context ──

/** Full context passed into the decision pipeline. */
export interface DecisionContext {
  /** Current permission mode */
  mode: PermissionMode;
  /** Active rules, sorted by source priority (highest first) — engine sorts on construction */
  rules: PermissionRule[];
  /** Name of the tool being invoked */
  toolName: string;
  /** Serialized tool arguments string (for content substring matching) */
  toolArgs: Record<string, unknown>;
  /** Current working directory (for acceptEdits mode path checking) */
  cwd?: string;
}

// ── Safety Check Types ──

/** Result of a safety check — whether the operation triggered a bypass-immune flag. */
export interface SafetyCheckResult {
  /** True if the operation requires explicit confirmation regardless of mode */
  triggered: boolean;
  /** Human-readable reason describing the safety concern */
  reason?: string;
}
