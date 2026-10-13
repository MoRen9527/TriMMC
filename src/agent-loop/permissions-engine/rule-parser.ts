// ── Rule Parser ──
// CTO-003 P4T1: Absorbed from Claude Code 2.1.88 vendor (permissionRuleParser.ts).
// Parses "ToolName(content)" format into PermissionRule objects.
// Supports legacy name aliases and wildcard detection.

import type { PermissionRule, RuleSource } from './types.js';

// ── Legacy Name Aliases ──

/** Claude Code → TriMMC tool name aliases for backward compatibility. */
const LEGACY_ALIASES: Record<string, string> = {
  Task: 'task',
  KillShell: 'task', // no TaskStop equivalent — fold into task
  AgentOutputTool: 'task',
  BashOutputTool: 'task',
  FileRead: 'read_file',
  FileWrite: 'write_file',
  FileEdit: 'edit_file',
  Grep: 'glob_search',
  Glob: 'glob_search',
  TodoWrite: 'write_file', // todo management via write_file
  TaskCreate: 'task',
  TaskGet: 'task',
  TaskUpdate: 'task',
  TaskList: 'task',
  TaskStop: 'task',
  TaskOutput: 'task',
};

// ── Parser ──

/**
 * Parse a single rule string in Claude Code format.
 *
 * Supported formats:
 *   "ToolName"              → tool-level rule (no content filter)
 *   "ToolName(content)"     → content-filtered rule
 *   "Bash(*)" / "Bash()"    → all Bash commands (tool-level)
 *   "Bash(git push)"        → exact command match
 *   "Bash(curl *)"          → wildcard prefix match
 *   "Bash(python:*)"        → prefix match
 *
 * Escaping:
 *   \( → literal (
 *   \) → literal )
 *   \\ → literal \
 */
export function parseRule(raw: string, behavior: PermissionRule['behavior'], source: RuleSource): PermissionRule {
  // Find the first unescaped '(' that separates tool name from content
  const parenIdx = findUnescapedParen(raw);
  if (parenIdx === -1) {
    // Tool-level rule: "ToolName"
    const toolName = resolveAlias(raw.trim());
    return { toolName, behavior, source };
  }

  const toolNameRaw = raw.slice(0, parenIdx).trim();
  const contentRaw = raw.slice(parenIdx + 1, -1); // strip trailing ')'
  const toolName = resolveAlias(toolNameRaw);

  // Normalize content: unescape, detect wildcard
  const normalized = unescapeContent(contentRaw);

  // "Bash()" or "Bash(*)" → tool-level rule (no content filter)
  if (normalized === '' || normalized === '*') {
    return { toolName, behavior, source };
  }

  // Detect wildcard: trailing " *" or ending with ":*"
  const isWildcard = normalized.endsWith('*') || normalized.endsWith(':*');
  let content: string;
  if (normalized.endsWith(':*')) {
    // "python:*" → content="python:", isWildcard=true
    content = normalized.slice(0, -1);
  } else if (isWildcard) {
    // "curl *" → content="curl ", isWildcard=true
    content = normalized.slice(0, -1);
  } else {
    content = normalized;
  }

  return { toolName, content: content || undefined, behavior, source, isWildcard: isWildcard || undefined };
}

/**
 * Parse an array of rule strings into PermissionRule objects.
 * All rules share the same behavior and source.
 */
export function parseRules(
  rawRules: string[],
  behavior: PermissionRule['behavior'],
  source: RuleSource,
): PermissionRule[] {
  return rawRules.map((r) => parseRule(r, behavior, source));
}

// ── Helpers ──

/** Find first '(' not preceded by an odd number of backslashes. */
function findUnescapedParen(str: string): number {
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '(' && !isEscaped(str, i)) {
      return i;
    }
  }
  return -1;
}

/** Check if character at idx is escaped (preceded by odd number of backslashes). */
function isEscaped(str: string, idx: number): boolean {
  let count = 0;
  let i = idx - 1;
  while (i >= 0 && str[i] === '\\') {
    count++;
    i--;
  }
  return count % 2 === 1;
}

/** Unescape \( → (, \) → ), \\ → \ */
function unescapeContent(content: string): string {
  return content
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\');
}

/** Resolve legacy Claude Code tool name to TriMMC tool name. */
function resolveAlias(name: string): string {
  return LEGACY_ALIASES[name] ?? name;
}
