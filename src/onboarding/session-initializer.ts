// ── Employee Session Initializer (v3 contracts) ──
// 6.4 会话初始化器（服务器 TriMMC 端）：以 v3 合同（TriCompany/source-agents/*.contract.yaml）
// 为基础装配员工会话运行时配置，与本地 TriRLC 侧（src/company/session-initializer.ts）同构，
// 互为 fallback 拉员工上岗。
//
// r13-2 收敛：合同解析统一走 @tricompany/agent-core loadContractV3（O2-A 落地），
// 本域保留五件套路径组装、frontmatter 工具配置解析与 system prompt 组装。

import { readFileSync, readdirSync, existsSync, mkdirSync, accessSync, constants } from 'node:fs';
import { resolve, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { loadContractV3, type AgentContractV3 } from '@tricompany/agent-core';

// ── Types (mirror TriRLC src/company/session-initializer.ts SessionConfig) ──

export interface V2DecisionRights {
  approve: string[];
  freeze: string[];
  escalate: string[];
  forbidden: string[];
}

/** Employee session runtime config assembled from a v3 contract. */
export interface V2SessionConfig {
  agentId: string;
  family: 'Role' | 'Registry';
  systemPrompt: string;
  decisionRights: V2DecisionRights;
  toolControl: Record<string, unknown>;
  workspaceRoot: string;
  readyAt: string;
}

export class SessionInitError extends Error {
  constructor(
    message: string,
    public agentId: string,
  ) {
    super(`[session-initializer] ${agentId}: ${message}`);
    this.name = 'SessionInitError';
  }
}

// ── v3 Contract Loading (r13-2: 解析走 agent-core loadContractV3) ──

function readFileSafe(filePath: string): string {
  try {
    if (existsSync(filePath)) {
      return readFileSync(filePath, 'utf-8');
    }
  } catch { /* ignore */ }
  return '';
}

/** Parse tool config from YAML frontmatter (domain logic, mirrors TriRLC parseFrontmatter). */
function parseFrontmatter(text: string): Record<string, unknown> {
  if (!text) return {};
  const trimmed = text.trim();
  if (!trimmed) return {};
  let yamlText = trimmed;
  if (trimmed.startsWith('---')) {
    const lines = trimmed.split(/\r?\n/);
    const closingIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (closingIndex < 0) return {};
    yamlText = lines.slice(1, closingIndex).join('\n').trim();
    if (!yamlText) return {};
  }
  try {
    const parsed = parseYaml(yamlText) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/** Load one v3 contract file into a session config fragment. */
function loadV3Contract(contractPath: string, sourceRoot: string): V2SessionConfig | null {
  let parsed: AgentContractV3;
  try {
    parsed = loadContractV3(contractPath);
  } catch {
    return null;
  }

  const agentId = parsed.contract.agent_id;
  const family = parsed.contract.family;
  const paths = parsed.paths;

  const soul = readFileSafe(resolve(sourceRoot, paths.soul));
  const agentBody = readFileSafe(resolve(sourceRoot, paths.agent_body));
  const agentFrontmatter = readFileSafe(resolve(sourceRoot, paths.agent_frontmatter));

  // Assemble system prompt: soul + agent body (mirrors TriRLC)
  const systemPrompt = [soul, agentBody].filter(Boolean).join('\n\n');

  const explicitToolControl = parseFrontmatter(agentFrontmatter);
  const bodyToolControl = parseFrontmatter(agentBody);
  const toolControl = Object.keys(explicitToolControl).length > 0
    ? explicitToolControl
    : bodyToolControl;

  const decisionRights: V2DecisionRights = {
    approve: parsed.decision_rights.approve,
    freeze: parsed.decision_rights.freeze,
    escalate: parsed.decision_rights.escalate,
    forbidden: parsed.decision_rights.forbidden,
  };

  return {
    agentId,
    family,
    systemPrompt,
    decisionRights,
    toolControl,
    workspaceRoot: '',  // filled by initializeSession
    readyAt: '',
  };
}

/**
 * Scan a source-agents directory for v3 contracts:
 * `<sourceAgentsDir>/<agent-dir>/<agent-dir>.contract.yaml` (mirrors TriRLC loadAll).
 */
export function loadV2Contracts(sourceAgentsDir: string): V2SessionConfig[] {
  const contracts: V2SessionConfig[] = [];
  const root = resolve(sourceAgentsDir);

  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return contracts;
  }

  for (const name of entries) {
    const contractPath = join(root, name, `${name}.contract.yaml`);
    if (!existsSync(contractPath)) continue;

    try {
      const contract = loadV3Contract(contractPath, root);
      if (contract) contracts.push(contract);
    } catch (err) {
      console.warn(`[session-initializer] failed to load ${contractPath}:`, (err as Error).message);
    }
  }

  return contracts;
}

// ── Session Initialization ──

/**
 * Employee session initialization on the TriMMC (server) side:
 * 1. Contract load — v3 contract from the same-source TriCompany/source-agents
 * 2. Five-piece assembly — systemPrompt (soul + agent_body), decisionRights, toolControl
 * 3. Workspace ready — workspaceRoot/<agentId> created (idempotent) + W_OK check
 *    （O3：基准 TriRLC src/company/session-initializer.ts ensureWorkspaceDir）
 *
 * Throws SessionInitError when the agent contract is absent/unloadable
 * or the workspace is not writable.
 */
export function initializeSession(
  agentId: string,
  opts: { sourceAgentsDir: string; workspaceRoot: string },
): V2SessionConfig {
  const contracts = loadV2Contracts(opts.sourceAgentsDir);
  const contract = contracts.find((c) => c.agentId === agentId);
  if (!contract || !contract.systemPrompt) {
    throw new SessionInitError('v3 contract not loaded', agentId);
  }

  const workspaceRoot = resolve(opts.workspaceRoot, agentId);
  mkdirSync(workspaceRoot, { recursive: true });
  // O3: 工作目录可写校验（读只目录负路径 → SessionInitError）
  try {
    accessSync(workspaceRoot, constants.W_OK);
  } catch {
    throw new SessionInitError(`workspace not writable: ${workspaceRoot}`, agentId);
  }

  return {
    ...contract,
    workspaceRoot,
    readyAt: new Date().toISOString(),
  };
}
