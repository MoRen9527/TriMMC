// ── TriMMC Memory Injector ──
// CTO-006: Converts four-layer memory (soul/memory/colleagues/social)
// into memdir/ markdown files for Context Builder pipeline integration.
// Pattern absorbed from Claude Code memdir/ (memoryTypes.ts, memoryScan.ts).
//
// Four layers:
//   soul/       — Agent identity snapshot (from AgentContract)
//   memory/     — Episodic key-value entries
//   colleagues/ — Peer agent capability summaries
//   social/     — Relationship graph (reporting, peers, supervises)

import { writeFile, mkdir } from 'fs/promises';
import { readdir } from 'fs/promises';
import { join, basename } from 'path';
import { readFile } from 'fs/promises';
import type { AgentContract } from '../contracts/agent-contract.js';

// ── Memory Layer Types ──

export type MemoryLayer = 'soul' | 'memory' | 'colleagues' | 'social';

/** Frontmatter fields written to every memory .md file */
export interface MemoryFrontmatter {
  type: MemoryLayer;
  agent_id: string;
  description: string;
  timestamp?: string;
}

/** Soul layer: agent identity snapshot */
export interface SoulMemory {
  agentId: string;
  displayName: string;
  family: string;
  role: string;
  description: string;
  instructions?: string;
}

/** Episodic memory: a single key-value fact */
export interface EpisodicMemory {
  key: string;
  value: string;
  timestamp?: number;
}

/** Colleague summary: what we know about another agent */
export interface ColleagueMemory {
  agentId: string;
  displayName: string;
  family: string;
  role: string;
  description: string;
  responsibilities: string[];
  reportsTo: string;
}

/** Social layer: relationship graph for this agent */
export interface SocialMemory {
  agentId: string;
  reportsTo: string;
  peers: string[];
  supervises: string[];
  collaborationNotes?: string;
}

/** Full four-layer memory payload for injection */
export interface MemoryPayload {
  agentId: string;
  soul?: SoulMemory;
  memories?: EpisodicMemory[];
  colleagues?: ColleagueMemory[];
  social?: SocialMemory;
}

/** Result from injectAll / individual injectors */
export interface InjectResult {
  files: string[];
  count: number;
}

// ── Frontmatter Helpers ──

function buildFrontmatter(fm: MemoryFrontmatter): string {
  const lines = [
    '---',
    `type: ${fm.type}`,
    `agent_id: ${fm.agent_id}`,
    `description: ${fm.description}`,
  ];
  if (fm.timestamp) {
    lines.push(`timestamp: ${fm.timestamp}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

function isoNow(): string {
  return new Date().toISOString();
}

// ── Four-Layer Injectors ──

/**
 * Write the soul layer: soul/SOUL.md
 * Contains the agent's identity snapshot — display name, family, role,
 * description, and any behavioral instructions.
 */
export async function injectSoul(
  soul: SoulMemory,
  memdirPath: string,
): Promise<InjectResult> {
  const dir = join(memdirPath, 'soul');
  await mkdir(dir, { recursive: true });

  const fm = buildFrontmatter({
    type: 'soul',
    agent_id: soul.agentId,
    description: `${soul.displayName} — ${soul.role}`,
    timestamp: isoNow(),
  });

  const body = [
    `# ${soul.displayName}`,
    '',
    `- **Agent ID**: \`${soul.agentId}\``,
    `- **Family**: ${soul.family}`,
    `- **Role**: ${soul.role}`,
    '',
    `## Description`,
    '',
    soul.description,
  ];

  if (soul.instructions) {
    body.push('', '## Instructions', '', soul.instructions);
  }

  const filePath = join(dir, 'SOUL.md');
  await writeFile(filePath, fm + body.join('\n') + '\n', 'utf-8');
  return { files: [filePath], count: 1 };
}

/**
 * Write episodic memories: memory/<key>.md
 * Each key becomes a separate .md file with the value as body.
 * Timestamps default to now if not provided.
 */
export async function injectMemories(
  memories: EpisodicMemory[],
  agentId: string,
  memdirPath: string,
): Promise<InjectResult> {
  if (memories.length === 0) return { files: [], count: 0 };

  const dir = join(memdirPath, 'memory');
  await mkdir(dir, { recursive: true });

  const files: string[] = [];
  for (const mem of memories) {
    const safeName = mem.key.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
    const ts = mem.timestamp ? new Date(mem.timestamp).toISOString() : isoNow();

    const fm = buildFrontmatter({
      type: 'memory',
      agent_id: agentId,
      description: mem.key,
      timestamp: ts,
    });

    const filePath = join(dir, `${safeName}.md`);
    await writeFile(filePath, fm + mem.value + '\n', 'utf-8');
    files.push(filePath);
  }

  return { files, count: files.length };
}

/**
 * Write colleague summaries: colleagues/<agentId>.md
 * One file per colleague with role, responsibilities, and reporting info.
 */
export async function injectColleagues(
  colleagues: ColleagueMemory[],
  memdirPath: string,
): Promise<InjectResult> {
  if (colleagues.length === 0) return { files: [], count: 0 };

  const dir = join(memdirPath, 'colleagues');
  await mkdir(dir, { recursive: true });

  const files: string[] = [];
  for (const c of colleagues) {
    const fm = buildFrontmatter({
      type: 'colleagues',
      agent_id: c.agentId,
      description: `${c.displayName} — ${c.role}`,
      timestamp: isoNow(),
    });

    const body = [
      `# ${c.displayName}`,
      '',
      `- **Agent ID**: \`${c.agentId}\``,
      `- **Family**: ${c.family}`,
      `- **Role**: ${c.role}`,
      `- **Reports to**: ${c.reportsTo}`,
      '',
      `## Description`,
      '',
      c.description,
      '',
      '## Responsibilities',
      '',
      ...c.responsibilities.map(r => `- ${r}`),
    ];

    const filePath = join(dir, `${c.agentId}.md`);
    await writeFile(filePath, fm + body.join('\n') + '\n', 'utf-8');
    files.push(filePath);
  }

  return { files, count: files.length };
}

/**
 * Write the social layer: social/graph.md
 * Contains reporting chain, peers, supervises relationships.
 */
export async function injectSocial(
  social: SocialMemory,
  memdirPath: string,
): Promise<InjectResult> {
  const dir = join(memdirPath, 'social');
  await mkdir(dir, { recursive: true });

  const fm = buildFrontmatter({
    type: 'social',
    agent_id: social.agentId,
    description: `Social graph for ${social.agentId}`,
    timestamp: isoNow(),
  });

  const body = [
    `# Social Graph: ${social.agentId}`,
    '',
    `- **Reports to**: ${social.reportsTo}`,
    '',
    '## Peers',
    ...(social.peers.length > 0
      ? social.peers.map(p => `- ${p}`)
      : ['- (none)']),
    '',
    '## Supervises',
    ...(social.supervises.length > 0
      ? social.supervises.map(s => `- ${s}`)
      : ['- (none)']),
  ];

  if (social.collaborationNotes) {
    body.push('', '## Collaboration Notes', '', social.collaborationNotes);
  }

  const filePath = join(dir, 'graph.md');
  await writeFile(filePath, fm + body.join('\n') + '\n', 'utf-8');
  return { files: [filePath], count: 1 };
}

/**
 * Inject all four memory layers into memdir/.
 * Only layers that are present in the payload are written.
 */
export async function injectAll(
  payload: MemoryPayload,
  memdirPath: string,
): Promise<InjectResult> {
  const results: InjectResult[] = [];

  if (payload.soul) {
    results.push(await injectSoul(payload.soul, memdirPath));
  }
  if (payload.memories && payload.memories.length > 0) {
    results.push(
      await injectMemories(payload.memories, payload.agentId, memdirPath),
    );
  }
  if (payload.colleagues && payload.colleagues.length > 0) {
    results.push(await injectColleagues(payload.colleagues, memdirPath));
  }
  if (payload.social) {
    results.push(await injectSocial(payload.social, memdirPath));
  }

  const files = results.flatMap(r => r.files);
  return { files, count: files.length };
}

// ── Context Builder Integration ──

/**
 * Build extraContext lines from a populated memdir/ path.
 * Scans all .md files (excluding SOUL.md), reads their frontmatter
 * and first 200 characters of body, and produces a manifest suitable
 * for ContextSources.extraContext.
 *
 * Format: [layer] filename: description (TS)  first-line-of-body
 */
export async function buildMemoryContext(
  memdirPath: string,
): Promise<string[]> {
  try {
    const files = await collectMdFiles(memdirPath);
    const lines: string[] = [];

    for (const f of files) {
      const content = await readFile(f, 'utf-8');
      const fm = parseFrontmatterSimple(content);
      const body = content.slice(fm.bodyStart).trim();
      const firstLine = body.split('\n')[0]?.replace(/^#+\s*/, '').trim() || '';

      const layerTag = fm.type ? `[${fm.type}]` : '';
      const ts = fm.timestamp
        ? ` (${new Date(fm.timestamp).toISOString()})`
        : '';

      const relative = f.slice(memdirPath.length + 1);
      lines.push(
        `- ${layerTag} ${relative}${ts}: ${fm.description || firstLine}`
      );
    }

    return lines;
  } catch {
    return [];
  }
}

// ── Convenience ──

/**
 * Extract SoulMemory from an AgentContract.
 * Convenience bridge between contract resolver and memory injector.
 */
export function contractToSoulMemory(contract: AgentContract): SoulMemory {
  return {
    agentId: contract.agent_id,
    displayName: contract.identity.display_name,
    family: contract.identity.family,
    role: contract.identity.role,
    description: contract.identity.description,
    instructions: contract.instructions,
  };
}

// ── Internal Helpers ──

interface SimpleFrontmatter {
  type?: string;
  description?: string;
  timestamp?: string;
  bodyStart: number;
}

function parseFrontmatterSimple(content: string): SimpleFrontmatter {
  const result: SimpleFrontmatter = { bodyStart: 0 };
  if (!content.startsWith('---')) return result;

  const endIdx = content.indexOf('---', 3);
  if (endIdx === -1) return result;

  const fmText = content.slice(3, endIdx);
  result.bodyStart = endIdx + 3;

  for (const line of fmText.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key === 'type') result.type = value;
    if (key === 'description') result.description = value;
    if (key === 'timestamp') result.timestamp = value;
  }

  return result;
}

async function collectMdFiles(dirPath: string): Promise<string[]> {
  const result: string[] = [];
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dirPath, e.name);
      if (e.isDirectory()) {
        const sub = await collectMdFiles(full);
        result.push(...sub);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        result.push(full);
      }
    }
  } catch {
    // dir doesn't exist or unreadable — return empty
  }
  return result;
}
