// ── Agent Contract Resolver (thin adapter) ──
// r13-2 Step 4: 解析与校验统一走 @tricompany/agent-core loadContractV3（v3.0 权威 schema），
// 本域保留 v1 兼容形状投影（消费方零改动）与目录遍历。
// thin adapter 边界见 TriCompany/docs/engineering/agent-contract-v3-spec.md §四。

import { readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  loadContractV3,
  ContractV3Error,
  type AgentContractV3,
  type ContractToolSpec,
} from '@tricompany/agent-core';
import type { AgentContract, ToolRiskLevel } from './agent-contract.js';

// ── Domain Projection (v3 → v1 兼容形状) ──

function projectTools(raw: ContractToolSpec[]): AgentContract['tools'] {
  return raw.map((t) => ({
    name: t.name,
    scope: t.scope,
    risk_level: t.risk_level as ToolRiskLevel,
    requires_approval: t.requires_approval,
    runtime_equivalent: t.runtime_equivalent,
  }));
}

function toDomain(c: AgentContractV3): AgentContract {
  return {
    agent_id: c.contract.agent_id,
    version: c.contract.version,
    identity: {
      display_name: c.identity.display_name,
      family: c.contract.family,
      role: c.identity.role,
      description: c.identity.description,
      user_invocable: c.identity.user_invocable,
    },
    responsibilities: c.responsibilities.map((r) =>
      typeof r === 'string' ? { description: r } : r,
    ),
    decision_rights: {
      approve: c.decision_rights.approve,
      freeze: c.decision_rights.freeze,
      escalate: c.decision_rights.escalate,
      forbidden: c.decision_rights.forbidden,
    },
    collaborators: c.collaborators,
    tools: projectTools(c.tools),
    // batch-15 件③追裁（CTO 2026-10-02）：v3 侧 io_contract 已 Registry nullish
    //（board 治理席无 IO 契约设计形）——本域投影兜底空 IO 形，domain 类型 Required
    // 不动（消费方零改动，空 inputs/outputs 语义=治理席无 IO 契约）。
    io_contract: c.io_contract ?? { inputs: [], outputs: [] },
    instructions: c.instructions,
    // v3 对象形状（spec §2.4 裁决）；本域投影为对象，消费方暂无读取方
    runtime_baseline: c.runtime_baseline,
  };
}

// ── Public API ──

export { ContractV3Error as ContractValidationError };

/**
 * Load and validate a single v3.0 .contract.yaml into the domain shape.
 * Throws ContractV3Error on any parse/validation failure.
 */
export function loadContract(contractPath: string): AgentContract {
  return toDomain(loadContractV3(contractPath));
}

/**
 * Resolve all contracts from a registry dir.
 * Accepts both layouts:
 *   - flat:     <dir>/*.contract.yaml（历史 v1 布局）
 *   - per-agent: <dir>/<agent-dir>/<agent-dir>.contract.yaml（source-agents 布局）
 * Failed parses are collected into errors — does not throw on individual failures.
 */
export function resolveContracts(
  registryDir: string
): { contracts: AgentContract[]; errors: { path: string; message: string }[] } {
  const contracts: AgentContract[] = [];
  const errors: { path: string; message: string }[] = [];

  let entries: string[];
  try {
    entries = readdirSync(resolve(registryDir));
  } catch {
    return { contracts, errors: [{ path: registryDir, message: 'directory not readable' }] };
  }

  for (const entry of entries) {
    if (entry.endsWith('.contract.yaml')) {
      tryLoad(join(registryDir, entry), entry);
      continue;
    }
    // per-agent layout: <entry>/<entry>.contract.yaml
    const nestedPath = join(registryDir, entry, `${entry}.contract.yaml`);
    if (!existsSync(nestedPath)) continue;
    tryLoad(nestedPath, `${entry}/${entry}.contract.yaml`);
  }

  function tryLoad(fullPath: string, label: string): void {
    try {
      contracts.push(loadContract(fullPath));
    } catch (err: unknown) {
      errors.push({
        path: label,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { contracts, errors };
}
