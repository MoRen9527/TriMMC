// ── PermissionEngine ──
// CTO-003 P4T1: Public API for the TriMMC tool permission system.
// Wraps rule parsing, safety checks, and the 8-step decision pipeline
// into a single PermissionEngine class.
//
// Usage (agent loop):
//   const engine = new PermissionEngine({ mode: 'default', rules: [...] });
//   const result = engine.decide('write_file', { file_path: 'src/foo.ts', content: '...' }, cwd);
//   if (!result.allowed) { /* block */ }

import type { DecisionContext, DecisionResult, PermissionMode, PermissionRule, RuleSource } from './types.js';
import { parseRule, parseRules } from './rule-parser.js';
import { decide } from './decision-pipeline.js';

// ── Engine Options ──

export interface PermissionEngineOptions {
  /** Current permission mode */
  mode?: PermissionMode;
  /** Pre-parsed PermissionRule objects */
  rules?: PermissionRule[];
  /** Current working directory (for acceptEdits path validation) */
  cwd?: string;
}

// ── PermissionEngine Class ──

export class PermissionEngine {
  private mode: PermissionMode;
  private rules: PermissionRule[];
  private cwd?: string;

  constructor(options: PermissionEngineOptions = {}) {
    this.mode = options.mode ?? 'default';
    this.rules = options.rules ?? [];
    this.cwd = options.cwd;
  }

  // ── Mode Management ──

  /** Get the current permission mode. */
  getMode(): PermissionMode {
    return this.mode;
  }

  /** Set the permission mode (e.g., on Shift+Tab cycle). */
  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  /** Set the working directory for acceptEdits path boundary checks. */
  setCwd(cwd: string | undefined): void {
    this.cwd = cwd;
  }

  // ── Rule Management ──

  /** Get all registered rules (sorted by source priority). */
  getRules(): PermissionRule[] {
    return [...this.rules];
  }

  /**
   * Add a rule from a raw Claude Code-compatible string.
   *
   * @example
   *   engine.addRule('Bash(git push)', 'allow', 'userSettings');
   *   engine.addRule('write_file', 'deny', 'projectSettings');
   */
  addRule(raw: string, behavior: PermissionRule['behavior'], source: RuleSource): PermissionRule {
    const rule = parseRule(raw, behavior, source);
    this.rules.push(rule);
    this.sortRules();
    return rule;
  }

  /**
   * Add multiple rules from raw strings (same behavior + source).
   */
  addRules(rawRules: string[], behavior: PermissionRule['behavior'], source: RuleSource): PermissionRule[] {
    const rules = parseRules(rawRules, behavior, source);
    this.rules.push(...rules);
    this.sortRules();
    return rules;
  }

  /**
   * Add a pre-parsed PermissionRule object.
   */
  addParsedRule(rule: PermissionRule): void {
    this.rules.push(rule);
    this.sortRules();
  }

  /**
   * Remove all rules from a specific source.
   */
  removeRulesBySource(source: RuleSource): number {
    const before = this.rules.length;
    this.rules = this.rules.filter((r) => r.source !== source);
    return before - this.rules.length;
  }

  /**
   * Remove all rules.
   */
  clearRules(): void {
    this.rules = [];
  }

  // ── Decision ──

  /**
   * Decide whether a tool invocation should be allowed, denied, or requires confirmation.
   *
   * @param toolName - Name of the tool being invoked (e.g., 'write_file', 'shell_exec')
   * @param args - Parsed tool arguments (for content matching and safety checks)
   * @returns DecisionResult with allowed/denied/ask and audit trail
   */
  decide(toolName: string, args: Record<string, unknown>): DecisionResult {
    const context: DecisionContext = {
      mode: this.mode,
      rules: this.rules,
      toolName,
      toolArgs: args,
      cwd: this.cwd,
    };

    return decide(context);
  }

  // ── Bulk Decide ──

  /**
   * Decide on multiple tool calls at once.
   * Returns a map of tool call ID → DecisionResult.
   */
  decideAll(
    toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
  ): Map<string, DecisionResult> {
    const results = new Map<string, DecisionResult>();
    for (const tc of toolCalls) {
      results.set(tc.id, this.decide(tc.name, tc.arguments));
    }
    return results;
  }

  // ── Summary ──

  /** Human-readable summary of engine state for logging/debugging. */
  summarize(): {
    mode: PermissionMode;
    ruleCount: number;
    rulesBySource: Record<string, number>;
    rulesByBehavior: Record<string, number>;
  } {
    const rulesBySource: Record<string, number> = {};
    const rulesByBehavior: Record<string, number> = { allow: 0, deny: 0, ask: 0 };

    for (const rule of this.rules) {
      rulesBySource[rule.source] = (rulesBySource[rule.source] ?? 0) + 1;
      rulesByBehavior[rule.behavior] = (rulesByBehavior[rule.behavior] ?? 0) + 1;
    }

    return {
      mode: this.mode,
      ruleCount: this.rules.length,
      rulesBySource,
      rulesByBehavior,
    };
  }

  // ── Sorting ──

  private sortRules(): void {
    const PRIORITY: Record<string, number> = {
      userSettings: 100,
      projectSettings: 90,
      localSettings: 80,
      flagSettings: 70,
      policySettings: 60,
      cliArg: 50,
      command: 40,
      session: 30,
    };

    this.rules.sort((a, b) => (PRIORITY[b.source] ?? 0) - (PRIORITY[a.source] ?? 0));
  }
}
