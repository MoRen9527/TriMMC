// ── TriMMC Pipeline Assembler ──
// CTO-013: Production-grade orchestrator that wires the four v0.2.0
// orchestration components into AgentLoopOptions.
//
// Pipeline: Contract → Soul Loader → ContextSources + systemPrompt
//                    → Memory Injector → extraContext (memdir/)
//                    → Context Builder → merged prompt
//                    → Tool Gater → toolSpecs
//                    → AgentLoopOptions (ready for agentLoop)

import { contractToPrompt, contractToContextSources } from '../soul-loader/soul-loader.js';
import { contractToSoulMemory, injectAll, buildMemoryContext } from '../memory-injector/memory-injector.js';
import type { MemoryPayload } from '../memory-injector/memory-injector.js';
import { buildContext, mergeContextWithPrompt, type ContextSources } from '../context-builder/context-builder.js';
import type { AgentContract, ToolSpec } from '../contracts/agent-contract.js';
import type { AgentLoopOptions } from '../agent-loop/loop.js';
import type { AgentTier } from '../agent-loop/permissions.js';
import { resolveDefaultModel } from '../config-sync/default-model.js';

// ── Assembly Options ──

export interface PipelineAssemblyOptions {
  /** Agent contract (drives the full pipeline) */
  contract: AgentContract;
  /** Agent tier (default: 'main') */
  tier?: AgentTier;
  /** Working directory for tool execution */
  cwd?: string;
  /** Maximum conversation turns (default: 25) */
  maxTurns?: number;
  /** Model name（缺省走三级解析 resolveDefaultModel：env TRIMC_DEFAULT_MODEL > applied > 兜底常量，i4-2 §四） */
  model?: string;
  /** Memdir root path for memory injection (optional). When unset, memory layer is skipped. */
  memdirPath?: string;
  /** Explicit system prompt override. When set, replaces the contract-generated soul prompt.
   *  The pipeline context block is still prepended via Context Builder. */
  systemPromptOverride?: string;
}

/** Result from pipeline assembly */
export interface PipelineAssembly {
  /** AgentLoopOptions ready for agentLoop() */
  options: AgentLoopOptions;
  /** Contract-generated system prompt (before context merge) */
  soulPrompt: string;
  /** Context sources from soul loader */
  soulContextSources: ContextSources;
  /** Whether memory was injected */
  memoryInjected: boolean;
  /** Memory context lines injected (if any) */
  memoryContextLines: string[];
}

// ── Pipeline Assembler ──

/**
 * Assemble AgentLoopOptions from an AgentContract through the full v0.2.0 pipeline.
 *
 * Steps:
 *   1. Soul Loader: contract → system prompt + ContextSources
 *   2. Memory Injector: contract → SoulMemory → memdir/ (optional)
 *   3. Context Builder: soul context + memory context → merged prompt
 *   4. Tool Gater: toolSpecs are passed through to AgentLoopOptions
 */
export async function assemblePipelineOptions(
  input: PipelineAssemblyOptions,
): Promise<PipelineAssembly> {
  const tier: AgentTier = input.tier ?? 'main';
  const contract = input.contract;

  // ── Step 1: Soul Loader ──
  const soulPrompt = input.systemPromptOverride ?? contractToPrompt(contract);
  const soulContextSources = contractToContextSources(contract, tier);

  // ── Step 2: Memory Injector (optional) ──
  let memoryInjected = false;
  let memoryContextLines: string[] = [];

  if (input.memdirPath) {
    try {
      const soulMemory = contractToSoulMemory(contract);
      const payload: MemoryPayload = {
        agentId: contract.agent_id,
        soul: soulMemory,
      };
      const result = await injectAll(payload, input.memdirPath);
      if (result.count > 0) {
        memoryInjected = true;
        memoryContextLines = await buildMemoryContext(input.memdirPath);
      }
    } catch {
      // Memory injection is best-effort — don't fail the pipeline
    }
  }

  // ── Step 3: Context Builder ──
  const fusedContextSources: ContextSources = {
    ...soulContextSources,
    extraContext: [
      ...(soulContextSources.extraContext ?? []),
      ...memoryContextLines,
    ],
  };

  const contextBlock = buildContext(fusedContextSources);
  const mergedSystemPrompt = mergeContextWithPrompt(contextBlock, soulPrompt);

  // ── Step 4: Tool Gater → AgentLoopOptions ──
  const toolSpecs: ToolSpec[] = contract.tools;

  const options: AgentLoopOptions = {
    // 模型名三级解析（i4-2 §四）：env TRIMC_DEFAULT_MODEL > applied > 兜底常量
    model: input.model ?? (await resolveDefaultModel()),
    maxTurns: input.maxTurns ?? 25,
    systemPrompt: mergedSystemPrompt,
    cwd: input.cwd,
    tier,
    toolSpecs,
    context: fusedContextSources,
  };

  return {
    options,
    soulPrompt,
    soulContextSources,
    memoryInjected,
    memoryContextLines,
  };
}
