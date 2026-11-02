#!/usr/bin/env node
/**
 * GHCP-MEM MCP stdio server.
 *
 * Minimal JSON-RPC 2.0 implementation of the Model Context Protocol (MCP)
 * over stdio. Exposes the GHCP-MEM session memory to any MCP-compatible
 * client (Cursor, Cline, Windsurf, Claude Desktop, etc.) without requiring
 * the @modelcontextprotocol/sdk dependency.
 *
 * Storage: reads from `~/.ghcp-mem/sessions.json`, which the VS Code
 * extension mirrors on every persist (see contextStore.syncToDisk).
 *
 * Launch:   npx ghcp-mem-mcp
 * Or:       node out/mcpServer.js
 *
 * Protocol methods implemented:
 *   - initialize
 *   - tools/list
 *   - tools/call   (ghcpMem_search | ghcpMem_timeline | ghcpMem_recent | ghcpMem_get)
 *   - ping
 *   - shutdown
 */

import { createInterface } from 'readline';
import { homedir } from 'os';
import { join } from 'path';
import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
// Import shared types to avoid duplicating interface definitions.
import type { CompressedSession, ContextDatabase } from './types';
// Shared keyword scorer + rank fusion — single source of truth shared with
// ContextStore so the stdio path and the in-VS-Code @mem path rank identically.
import {
  extractTerms,
  computeAvgDocLen,
  computeTermStats,
  keywordScoreFromStats,
  SessionTermStats,
  fuseRanks,
  FusionInput,
  FusionWeights,
  FUSION_RANK_MISS,
} from './searchCore';
// Intent classification + decayed confidence — reused so MCP fusion carries the
// same intent reweighting and confidence signal as the chat participant.
import { classifyIntent, intentWeights } from './queryIntent';
import { effectiveConfidence } from './decay';
// Phase 7: reuse pure helpers from the chat-side modules so MCP retrieval
// stays at full parity with the chat participant.
import { buildEntityRecord } from './entity';
import {
  snippetsFromSession,
  snippetScore,
  tokenizeSnippet,
  avgSnippetLen,
  Snippet,
} from './snippets';
import { detectConflicts, ConflictWarning } from './conflicts';
import { getCausalNeighbors } from './causalGraph';
import { explainScore } from './explain';
import { buildMermaidGraph } from './graphExport';
import { recommend } from './router';
import { rankLessons } from './lessons';
import { compileContext } from './contextCompiler';
import {
  buildKnowledgeGraph,
  neighborhood,
  neighborhoodToMermaid,
  pathBetween,
} from './knowledgeGraph';
import { isLifecycleState, LIFECYCLE_STATES, transitionLifecycle } from './lifecycle';
import { filterByScope, normalizeScopeStamp, parseAuthor, SCOPE_LEVELS } from './memoryScope';
import { OUTCOME_STATUSES, recordOutcome } from './outcomes';
import { defaultPolicy, evaluateWrite, parsePolicy } from './orgPolicy';
import { budgetResults } from './contextBudget';
import { createCheckpoint, verifyCheckpoint } from './agentCheckpoint';
import { TASK_TOOLS, isTaskTool, handleTaskTool } from './taskTools';
import { redact } from './redactor';
import {
  deserializeDb,
  isEncryptedEnvelope,
  parseEnvelopeHeader,
  serializeDb,
} from './storageCrypto';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'ghcp-mem';
// MCP write tools (store/delete/correct/retract/supersede) are OFF by default
// (v1.10.2). External clients (Cursor, Cline, Claude Desktop) that spawn the
// stdio server usually don't set env vars, so a fail-closed default keeps the
// store read-only until an operator explicitly opts in. To enable:
//   GHCP_MEM_ALLOW_MCP_WRITE=true
// GHCP_MEM_READONLY=true continues to force read-only even if the opt-in is set.
const MCP_WRITE_ENABLED =
  process.env.GHCP_MEM_ALLOW_MCP_WRITE === 'true' && process.env.GHCP_MEM_READONLY !== 'true';

/**
 * Redact every user-supplied string in an MCP write before it touches disk.
 * Mirrors what MemoryStoreTool.invoke() does for the in-process VS Code surface;
 * before v1.10.2 the MCP path stored client-supplied text verbatim, so any
 * external client (Claude Desktop, Cursor, ...) handing this tool a secret
 * persisted it in cleartext.
 *
 * Returns redacted strings + total redaction count so the stored session row
 * carries an accurate counter for the health score and audit log.
 */
export function redactPersistedStrings<T extends Record<string, unknown>>(
  fields: T,
): { redacted: T; count: number } {
  let count = 0;
  const out = { ...fields } as Record<string, unknown>;
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'string') {
      const r = redact(v, { redactSecrets: true, honorPrivateTags: true });
      out[k] = r.text;
      count += r.redactionCount;
    } else if (Array.isArray(v)) {
      const arr: string[] = [];
      for (const item of v) {
        if (typeof item !== 'string') continue;
        const r = redact(item, { redactSecrets: true, honorPrivateTags: true });
        arr.push(r.text);
        count += r.redactionCount;
      }
      out[k] = arr;
    }
  }
  return { redacted: out as T, count };
}
// Read the package version at module load so we never drift from package.json.
// Falls back to 'unknown' if the bundled package.json can't be located
// (e.g. when this file is imported from out-test/ during the test compile).
let SERVER_VERSION = 'unknown';
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  SERVER_VERSION = require('../package.json').version ?? 'unknown';
} catch {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    SERVER_VERSION = require('../../package.json').version ?? 'unknown';
  } catch {
    /* keep 'unknown' */
  }
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

/** Alias to keep the rest of the file readable. */
type StoredSession = CompressedSession;
type StoredDatabase = ContextDatabase;

function storePath(): string {
  return process.env.GHCP_MEM_STORE_PATH ?? join(homedir(), '.ghcp-mem', 'sessions.json');
}

// Cache the parsed database keyed by file mtime so that high-frequency tool
// calls (search/recent/timeline/get) don't re-read and re-parse the whole
// JSON store from disk on every invocation. The extension host updates the
// file atomically via rename, so mtime changes monotonically per write.
let dbCache: { path: string; mtimeMs: number; db: StoredDatabase } | undefined;

let warnedEncryptedNoKey = false;

/**
 * Resolve the store decryption key for the headless server. With
 * `ghcpMem.storageEncryption` enabled, the VS Code extension injects
 * GHCP_MEM_KEY (hex) into the MCP server definition it registers; external
 * clients (Claude Desktop, Cursor configured by hand) must set it in their
 * server env block — `GHCP-MEM: Show External MCP Client Config` explains how.
 */
function storeKeyFromEnv(): Buffer | undefined {
  const hex = process.env.GHCP_MEM_KEY?.trim();
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex)) return undefined;
  return Buffer.from(hex, 'hex');
}

async function loadDatabase(): Promise<StoredDatabase> {
  const p = storePath();
  try {
    const stat = await fs.stat(p);
    if (dbCache && dbCache.path === p && dbCache.mtimeMs === stat.mtimeMs) return dbCache.db;
    const raw = await fs.readFile(p, 'utf8');
    if (isEncryptedEnvelope(raw)) {
      const parsedEnc = deserializeDb<StoredDatabase>(raw, storeKeyFromEnv());
      if (!parsedEnc) {
        if (!warnedEncryptedNoKey) {
          warnedEncryptedNoKey = true;
          console.error(
            '[ghcp-mem-mcp] sessions.json is encrypted (ghcpMem.storageEncryption) but GHCP_MEM_KEY is missing or wrong. ' +
              'Set GHCP_MEM_KEY (64 hex chars) in this MCP server\'s env block — run "GHCP-MEM: Show External MCP Client Config" in VS Code for the exact snippet.',
          );
        }
        return { version: 2, sessions: [], lastUpdated: 0 };
      }
      dbCache = { path: p, mtimeMs: stat.mtimeMs, db: parsedEnc };
      return parsedEnc;
    }
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.sessions)) {
      dbCache = { path: p, mtimeMs: stat.mtimeMs, db: parsed };
      return parsed;
    }
    const empty: StoredDatabase = { version: 2, sessions: [], lastUpdated: 0 };
    dbCache = { path: p, mtimeMs: stat.mtimeMs, db: empty };
    return empty;
  } catch {
    return { version: 2, sessions: [], lastUpdated: 0 };
  }
}

/**
 * RRF-fused search that shares ONE fusion formula with ContextStore.search
 * (see searchCore.fuseRanks). Before v1.17.x this path carried a stripped-down
 * fusion (RRF + recency only), so external MCP clients silently got worse
 * ranking than the in-VS-Code participant — no confidence, supersession,
 * reinforcement, match-ratio or intent reweighting. This now folds in all of
 * those signals. Query-embedding rerank is skipped (the headless server has no
 * LM to embed the query) and near-duplicate collapse / query expansion remain
 * chat-side only — tracked as MCP follow-ups.
 */
function searchSessions(
  db: StoredDatabase,
  query: string,
  filters: {
    type?: string;
    tag?: string;
    sinceDays?: number;
    workspaceId?: string;
    workspaceName?: string;
  } = {},
  limit = 5,
): StoredSession[] {
  let candidates = [...db.sessions];
  // Retracted sessions are kept on disk for audit but never surfaced — mirror
  // the in-process search which filters them out before ranking.
  candidates = candidates.filter((s) => !s.retracted);
  if (filters.type) candidates = candidates.filter((s) => s.observationType === filters.type);
  if (filters.tag) candidates = candidates.filter((s) => s.userTags.includes(filters.tag!));
  if (filters.sinceDays) {
    const cutoff = Date.now() - filters.sinceDays * 24 * 60 * 60 * 1000;
    candidates = candidates.filter((s) => s.endTime >= cutoff);
  }
  if (filters.workspaceId)
    candidates = candidates.filter((s) => s.workspaceId === filters.workspaceId);
  // workspaceName filter: case-insensitive substring match on workspaceName field.
  if (filters.workspaceName) {
    const needle = filters.workspaceName.toLowerCase();
    candidates = candidates.filter((s) => s.workspaceName?.toLowerCase().includes(needle));
  }

  const terms = extractTerms(query ?? '');
  const termCount = terms.size;
  const avgDocLen = computeAvgDocLen(candidates);
  // Tokenise each candidate once and reuse the stats for both the BM25 score
  // and the per-session match-ratio signal.
  const statsById = new Map<string, SessionTermStats>();
  for (const s of candidates) statsById.set(s.id, computeTermStats(s));
  const kScored = candidates.map((s) => ({
    s,
    k: keywordScoreFromStats(statsById.get(s.id)!, terms, false, avgDocLen),
  }));

  // When the user supplied a query AND at least one candidate has a positive
  // keyword score, drop the zero-score candidates so unrelated sessions can't
  // outrank a clear match through tiny differences in RRF rank position.
  let scoped = candidates;
  if (terms.size > 0 && kScored.some((e) => e.k > 0)) {
    const positive = new Set(kScored.filter((e) => e.k > 0).map((e) => e.s.id));
    scoped = candidates.filter((s) => positive.has(s.id));
  }
  const scopedKScored = kScored.filter((e) => scoped.includes(e.s));
  const keywordRanked = [...scopedKScored].sort((a, b) => b.k - a.k);
  const kRank = new Map<string, number>();
  keywordRanked.forEach((e, i) => kRank.set(e.s.id, i));
  const recencyRanked = [...scoped].sort((a, b) => b.endTime - a.endTime);
  const rRank = new Map<string, number>();
  recencyRanked.forEach((s, i) => rRank.set(s.id, i));

  // Fold intent reweighting into the shared fusion weights. Learned adaptive
  // weights live only in the extension host, so the headless server uses the
  // neutral 1.0 multipliers for confidence/reinforcement/feedback.
  const iw = intentWeights(classifyIntent(query ?? ''));
  const fusionWeights: FusionWeights = {
    keyword: iw.keywordWeight,
    recencyMultiplier: iw.recencyMultiplier,
    confidence: 1,
    reinforcement: 1,
    feedback: 1,
    decisionBoost: iw.decisionBoost,
    problemBoost: iw.problemBoost,
  };

  const byId = new Map(scoped.map((s) => [s.id, s]));
  const fusionInputs: FusionInput[] = scoped.map((s) => {
    const stats = statsById.get(s.id)!;
    let matched = 0;
    for (const t of terms) if (stats.wtf.has(t)) matched++;
    return {
      id: s.id,
      endTime: s.endTime,
      keywordRank: kRank.get(s.id) ?? FUSION_RANK_MISS,
      recencyRank: rRank.get(s.id) ?? FUSION_RANK_MISS,
      embeddingRank: undefined,
      workspaceMatch: !!filters.workspaceId && s.workspaceId === filters.workspaceId,
      matchRatio: termCount > 0 ? matched / termCount : 0,
      confidence: effectiveConfidence(s) ?? 0.5,
      retrieved: s.usage?.retrieved ?? 0,
      accepted: s.usage?.accepted ?? 0,
      rejected: s.usage?.rejected ?? 0,
      superseded: !!s.supersededBy,
      hasDecisions: s.decisions.length > 0,
      hasProblems: s.problemsSolved.length > 0,
    };
  });

  const scored = fuseRanks(fusionInputs, fusionWeights, { now: Date.now() });
  return scored.slice(0, limit).map((r) => byId.get(r.id)!);
}

function summarizeForMcp(s: StoredSession): any {
  return {
    id: s.id,
    shortId: s.id.substring(0, 8),
    date: new Date(s.endTime).toISOString(),
    type: s.observationType,
    summary: s.summary,
    keyFiles: s.keyFiles.slice(0, 10),
    keyTopics: s.keyTopics.slice(0, 8),
    decisions: s.decisions.slice(0, 5),
    problemsSolved: s.problemsSolved.slice(0, 5),
    tags: s.userTags,
    azure: s.azureContext
      ? {
          subscription: s.azureContext.subscriptionName ?? s.azureContext.subscriptionId,
          resourceGroup: s.azureContext.resourceGroup,
          subsystems: s.azureContext.subsystems,
        }
      : undefined,
  };
}

/** Timeline results ordered by most recent first for quick activity recall. */
export function timelineSessions(db: StoredDatabase, days = 7, limit = 10): StoredSession[] {
  const clampInt = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.floor(n)));
  const d = clampInt(days, 1, 365);
  const l = clampInt(limit, 1, 50);
  const cutoff = Date.now() - d * 24 * 60 * 60 * 1000;
  return db.sessions
    .filter((s) => !s.retracted && s.endTime >= cutoff)
    .sort((a, b) => b.endTime - a.endTime)
    .slice(0, l);
}

const TOOLS = [
  ...TASK_TOOLS,
  {
    name: 'ghcpMem_search',
    description:
      'Search GHCP-MEM session memory for past decisions, problems solved, files touched, and topics across all workspaces. PREFER THIS over opening files when the user is asking *about* the project history ("why / what / when / who") — typically returns the answer in ~250 tokens vs 1000–10000 for a file open.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords to search for.' },
        type: {
          type: 'string',
          description:
            'Optional observation type filter (feature, bugfix, infra, deployment, ...).',
        },
        sinceDays: { type: 'number', description: 'Only return sessions from the last N days.' },
        tag: { type: 'string', description: 'Filter by user-applied tag.' },
        workspaceId: {
          type: 'string',
          description: 'Scope results to a specific workspace URI. Omit for all workspaces.',
        },
        workspaceName: {
          type: 'string',
          description:
            'Scope results by workspace name (case-insensitive substring). Easier to use than workspaceId.',
        },
        limit: { type: 'number', description: 'Max results (default 5, max 25).' },
        maxTokens: {
          type: 'integer',
          minimum: 128,
          maximum: 32000,
          description: 'Estimated response token budget, including the receipt (default 1200).',
        },
        detail: {
          type: 'string',
          enum: ['index', 'full'],
          description:
            'Use index for compact discovery; full preserves complete summaries (default full).',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'ghcpMem_recent',
    description: 'Return the N most recent GHCP-MEM sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default 5, max 25).' },
        workspaceId: {
          type: 'string',
          description: 'Scope results to a specific workspace URI. Omit for all workspaces.',
        },
        workspaceName: {
          type: 'string',
          description:
            'Scope results by workspace name (case-insensitive substring). Easier to use than workspaceId.',
        },
      },
    },
  },
  {
    name: 'ghcpMem_timeline',
    description: 'Return sessions within a time window (days around now).',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: 'Look back N days (default 7).' },
        limit: { type: 'number', description: 'Max results (default 10, max 50).' },
      },
    },
  },
  {
    name: 'ghcpMem_get',
    description:
      'Get full detail by unique ID, or batch selected ids after compact search. Provide id OR ids. Checkpoint evidence is self-reported, not deployment authority.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session ID or unique prefix.' },
        ids: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Batch up to 25 selected session IDs instead of making separate model round trips.',
        },
        maxTokens: {
          type: 'integer',
          minimum: 128,
          maximum: 32000,
          description: 'Estimated token budget for batched detail results (default 2400).',
        },
        repoScope: {
          type: 'string',
          description: 'Repository scope against which to validate an attached checkpoint.',
        },
        commit: {
          type: 'string',
          description:
            'Current full commit hash for checkpoint validation; both scope and commit are required to validate.',
        },
      },
    },
  },
  {
    name: 'ghcpMem_store',
    description:
      'Persist a note or session summary into GHCP-MEM so it will be recalled in future sessions. Use for durable facts, decisions, or preferences.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: '2-4 sentence summary of what should be remembered.',
        },
        observationType: {
          type: 'string',
          description:
            'Category (feature, bugfix, refactor, docs, test, chore, research, config, security, deployment, infra, unknown). Default: research.',
        },
        keyTopics: {
          type: 'array',
          items: { type: 'string' },
          description: 'Up to 10 topic keywords.',
        },
        keyFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Up to 10 relevant file paths.',
        },
        decisions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Architectural or design decisions.',
        },
        problemsSolved: {
          type: 'array',
          items: { type: 'string' },
          description: 'Problems resolved.',
        },
        tags: { type: 'array', items: { type: 'string' }, description: 'User-facing tags.' },
        checkpoint: {
          type: 'object',
          description:
            'Optional expiring checkpoint: harness, taskId, repoScope, full commit, stage, summary, nextActions, evidence. Evidence is self-reported and never grants deployment authority.',
        },
        scopeLevel: {
          type: 'string',
          enum: [...SCOPE_LEVELS],
          description:
            'Governance scope of the memory (default repository). agent-scoped memories are private to the writing agent identity (GHCP_MEM_AGENT_ID in the launcher env).',
        },
        lifecycle: {
          type: 'string',
          enum: [...LIFECYCLE_STATES],
          description:
            'Engineering-lifecycle state. States below merged confine the memory to its capture branch.',
        },
      },
      required: ['summary'],
    },
  },
  {
    name: 'ghcpMem_delete',
    description: 'Delete a GHCP-MEM session by ID or ID prefix.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session ID or unique prefix to delete.' },
      },
      required: ['id'],
    },
  },
  // ── Phase 7: MCP parity with chat participant ────────────────────────────
  {
    name: 'ghcpMem_entity',
    description:
      'Aggregate every session that touched a file path or LSP symbol into a single focused summary. Key auto-detects: "src/auth.ts" → file entity, "src/auth.ts#hashPassword" → symbol entity (anything containing "#"). PREFER THIS over opening the file when the user asks "what do we know about <file/symbol>?" or "what decisions exist for <thing>?" — returns ~500 tokens vs typically 2000–10000 for the raw source.',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Workspace-relative file path or symbol ID (`path#symbol`).',
        },
      },
      required: ['key'],
    },
  },
  {
    name: 'ghcpMem_snippets',
    description:
      'Chunk-level retrieval — returns matching decisions, problems, summaries, or topics across all stored sessions (not just whole-session results). PREFER THIS over file open when the user wants the exact decision/error text matching some keywords — typically 200–500 tokens vs file size.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords to match.' },
        type: { type: 'string', description: 'Optional observation-type filter.' },
        tag: { type: 'string', description: 'Filter by user-applied tag.' },
        sinceDays: { type: 'number', description: 'Only consider sessions from the last N days.' },
        limit: { type: 'number', description: 'Max snippet results (default 10, max 50).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'ghcpMem_conflicts',
    description:
      'List pending conflict warnings — decisions whose text contained contradiction markers (e.g. "instead of", "deprecated") and that overlap with older sessions on file/topic. Useful for spotting unresolved supersessions in a team-shared store.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'ghcpMem_lineage',
    description:
      'Return the cross-session causal chain (predecessors + successors) for a session. Edges include semantic labels: "introduced_issue_fixed_by" (feature→bugfix), "extends" (feature→refactor), "tests" (feature→test), "continues_work_from" (fallback).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session ID or unique prefix.' },
        limit: {
          type: 'number',
          description: 'Max predecessors / successors per side (default 5, max 25).',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'ghcpMem_explain',
    description:
      'Score-decomposition explainer — break down why a session ranked where it did for a specific query. Returns per-signal contributions (keyword rank, recency decay, confidence, reinforcement, feedback, intent boosts, supersession penalty).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The query whose ranking should be explained.' },
        id: { type: 'string', description: 'Session ID (or prefix) being explained.' },
      },
      required: ['query', 'id'],
    },
  },
  {
    name: 'ghcpMem_graph',
    description:
      'Emit a Mermaid flowchart of the decision graph (supersession + correction + causal edges). Ready to paste into a PR description, ADR, or README. Optional file filter restricts to sessions touching a path.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description:
            'Optional workspace-relative path substring; restricts to sessions touching it.',
        },
      },
    },
  },
  {
    name: 'ghcpMem_route',
    description:
      'Context-acquisition recommender. Call BEFORE deciding whether to open a file: given the user question, returns the cheapest path to an answer (MCP tools vs file open), with per-action token estimates and a structured reasoning string. Use this to avoid uploading large files when a cheaper memory query would suffice. Off by default unless you want explicit cost guidance.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The user question / task description to route.' },
        fileSizes: {
          type: 'object',
          description:
            'Optional map of workspace-relative path → byte size. When supplied, the recommender uses real sizes for estimates instead of a default.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'ghcpMem_lessons',
    description:
      'Return the consolidated semantic + procedural lessons distilled from past sessions: durable project facts and how-to sequences that recurred across episodes, plus any hand-pinned lessons. Prefer this over re-reading source when the question is "what is true about this project" or "how do we usually do X" — it is the cheapest, highest-signal memory surface. Optional kind filter ("semantic" facts or "procedural" how-tos).',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          description: 'Optional filter: "semantic" for facts, "procedural" for how-to sequences.',
        },
        limit: {
          type: 'number',
          description: 'Maximum lessons to return (default 12).',
        },
      },
    },
  },
  {
    name: 'ghcpMem_compile',
    description:
      'Compile one bounded context block for a task instead of raw search results: project lessons plus retrieved sessions, reordered by lifecycle validity and recorded outcomes, with an explicit plan and omission receipts. Whole records are included or omitted, never split. Token counts are UTF-8-bytes/4 estimates.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The task or question to compile context for.' },
        maxTokens: {
          type: 'integer',
          minimum: 128,
          maximum: 32000,
          description: 'Estimated token budget for the whole block (default 2400).',
        },
        branch: {
          type: 'string',
          description:
            'Current git branch. Memories below the merged lifecycle state that were captured on a different branch are omitted (with a receipt).',
        },
        maxSessions: {
          type: 'integer',
          minimum: 1,
          maximum: 25,
          description: 'Candidate sessions to retrieve before budgeting (default 8).',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'ghcpMem_knowledge_graph',
    description:
      'Engineering knowledge graph over stored memory: sessions, files, decisions, referenced PRs and recorded outcomes with typed edges (touched, decided, supersedes, corrects, referenced_pr, evaluated_by). Give focus (e.g. "file:src/auth.ts") for a bounded neighborhood, plus to for the shortest path between two nodes. Derived from memory only — it never asserts code-level dependencies it has not observed.',
    inputSchema: {
      type: 'object',
      properties: {
        focus: {
          type: 'string',
          description: 'Node id to center on: "file:<path>", "session:<id>", "pr:<number>".',
        },
        to: {
          type: 'string',
          description: 'Second node id — returns the shortest path from focus to this node.',
        },
        depth: {
          type: 'integer',
          minimum: 1,
          maximum: 4,
          description: 'Neighborhood depth (default 2).',
        },
        format: {
          type: 'string',
          enum: ['json', 'mermaid'],
          description: 'Neighborhood output format (default json).',
        },
      },
    },
  },
  {
    name: 'ghcpMem_set_lifecycle',
    description:
      'Advance a memory through the engineering lifecycle (proposed → experimental → implemented → verified → merged → deployed, with deprecated/reverted exits). States below merged confine the memory to the branch it was captured on. Illegal transitions are rejected with the allowed set. Requires MCP write access.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session id or unique prefix.' },
        lifecycle: {
          type: 'string',
          enum: [...LIFECYCLE_STATES],
          description: 'Target lifecycle state.',
        },
      },
      required: ['id', 'lifecycle'],
    },
  },
  {
    name: 'ghcpMem_record_outcome',
    description:
      'Record whether a remembered decision actually worked. Appends an attributed, redacted outcome to the session (never rewrites the decision); the latest outcome per decision adjusts ranking and context compilation. Requires MCP write access.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Session id or unique prefix.' },
        status: {
          type: 'string',
          enum: [...OUTCOME_STATUSES],
          description: 'Observed result of the decision.',
        },
        decisionIndex: {
          type: 'integer',
          minimum: 0,
          maximum: 50,
          description:
            'Which decision (0-based index) this outcome evaluates; omit = whole session.',
        },
        observations: {
          type: 'array',
          items: { type: 'string' },
          description: 'Up to 10 short observed facts ("duplicate processing -91%").',
        },
      },
      required: ['id', 'status'],
    },
  },
];

/**
 * Load the committed organization memory policy when the launcher points at
 * one (GHCP_MEM_POLICY_FILE). No env → permissive default (pre-1.20 behavior).
 * An unreadable or invalid policy fails CLOSED — a misconfigured policy must
 * never silently widen access.
 */
async function loadOrgPolicy(): Promise<ReturnType<typeof defaultPolicy>> {
  const policyPath = process.env.GHCP_MEM_POLICY_FILE;
  if (!policyPath) return defaultPolicy();
  let raw: string;
  try {
    raw = await fs.readFile(policyPath, 'utf8');
  } catch {
    throw new Error(`Organization memory policy is configured but unreadable: ${policyPath}`);
  }
  return parsePolicy(raw);
}

/** Atomically write `db` back to disk (same rename pattern as the extension). */
async function saveDatabase(db: StoredDatabase): Promise<void> {
  const p = storePath();
  const dir = join(p, '..');
  await fs.mkdir(dir, { recursive: true });
  db.lastUpdated = Date.now();
  let payload = serializeDb(db, undefined, undefined);
  try {
    const original = await fs.readFile(p, 'utf8');
    const header = parseEnvelopeHeader(original);
    if (isEncryptedEnvelope(original)) {
      const key = storeKeyFromEnv();
      if (!header || !key || !deserializeDb<StoredDatabase>(original, key)) {
        throw new Error('Memory store is locked or corrupt; writes are suspended');
      }
      payload = serializeDb(
        db,
        key,
        header.mode,
        header.salt ? Buffer.from(header.salt, 'hex') : undefined,
      );
    } else {
      const existing = JSON.parse(original) as StoredDatabase;
      if (!Array.isArray(existing.sessions))
        throw new Error('Invalid memory store; writes are suspended');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const tmp = `${p}.${process.pid}.tmp`;
  await fs.writeFile(tmp, payload, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(tmp, p);
  // Bust the mtime cache so the next loadDatabase re-reads the file.
  dbCache = undefined;
}

function textContent(obj: unknown): any {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

function sessionDetail(session: StoredSession, scope?: string, commit?: string): unknown {
  return {
    ...summarizeForMcp(session),
    checkpoint: session.checkpoint,
    checkpointValidation: session.checkpoint
      ? scope && commit
        ? verifyCheckpoint(session.checkpoint, { repoScope: scope, commit })
        : { valid: false, reason: 'Supply current repoScope and commit; evidence is self-reported' }
      : undefined,
    rawEventCount: session.rawEventCount,
    redactionCount: session.redactionCount,
    workspaceName: session.workspaceName,
    startTime: new Date(session.startTime).toISOString(),
    endTime: new Date(session.endTime).toISOString(),
  };
}

function validateToolArguments(name: string, args: unknown): void {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  if (!args || typeof args !== 'object' || Array.isArray(args))
    throw new Error('Tool arguments must be an object');
  const values = args as Record<string, unknown>;
  const schema = tool.inputSchema as {
    required?: string[];
    properties: Record<string, { type: string; enum?: readonly string[] } | undefined>;
  };
  for (const required of schema.required ?? []) {
    if (values[required] === undefined || values[required] === null)
      throw new Error(`Missing required argument: ${required}`);
  }
  for (const [key, value] of Object.entries(values)) {
    const field = schema.properties[key];
    if (!field) throw new Error(`Unknown argument: ${key}`);
    if (field.type === 'array') {
      if (
        !Array.isArray(value) ||
        value.length > 50 ||
        value.some((entry) => typeof entry !== 'string')
      )
        throw new Error(`Invalid array argument: ${key}`);
    } else if (field.type === 'integer' || field.type === 'number') {
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        (field.type === 'integer' && !Number.isSafeInteger(value))
      )
        throw new Error(`Invalid numeric argument: ${key}`);
    } else if (
      typeof value !== field.type ||
      (field.type === 'object' && (value === null || Array.isArray(value)))
    ) {
      throw new Error(`Invalid argument type: ${key}`);
    }
    if (field.enum && !field.enum.includes(value as string))
      throw new Error(`Invalid argument value: ${key}`);
  }
}

async function handleCall(name: string, args: any): Promise<any> {
  if (isTaskTool(name)) {
    return textContent(
      await handleTaskTool(name, args, {
        memories: async (task, principal, scope) => {
          const source = await loadDatabase();
          const sessions = source.sessions.filter(
            (session) =>
              session.repoScope === principal.repoScope &&
              session.branchName === scope.branch &&
              !session.retracted &&
              !session.supersededBy &&
              !session.lowQuality,
          );
          return searchSessions({ ...source, sessions }, task.goal, {}, 10);
        },
      }),
    );
  }
  validateToolArguments(name, args);
  const db = structuredClone(await loadDatabase());
  // Write tools persist `db` back — they must see the UNFILTERED store, or a
  // scoped read filter would silently delete everything outside the scope.
  const writeTools = new Set([
    'ghcpMem_store',
    'ghcpMem_delete',
    'ghcpMem_set_lifecycle',
    'ghcpMem_record_outcome',
  ]);
  if (!writeTools.has(name)) {
    db.sessions = db.sessions.filter((session) => !session.retracted);
    // Agent-scoped memories are private to their author. The caller's identity
    // comes from the trusted launcher env, never from tool arguments.
    db.sessions = filterByScope(db.sessions, { author: process.env.GHCP_MEM_AGENT_ID });
    const scope = process.env.GHCP_MEM_REPO_SCOPE;
    if (scope) {
      db.sessions = db.sessions.filter(
        (session) => session.repoScope === scope || session.workspaceId === scope,
      );
      db.lessons = (db.lessons ?? []).filter((lesson) => lesson.scope === scope);
    }
  }
  const clamp = (n: any, def: number, max: number) => {
    const v = typeof n === 'number' ? Math.floor(n) : def;
    return Math.max(1, Math.min(max, v));
  };

  switch (name) {
    case 'ghcpMem_search': {
      const limit = clamp(args?.limit, 5, 25);
      const hits = searchSessions(
        db,
        String(args?.query ?? ''),
        {
          type: args?.type,
          tag: args?.tag,
          sinceDays: args?.sinceDays,
          workspaceId: args?.workspaceId,
          workspaceName: args?.workspaceName,
        },
        limit,
      );
      const results = hits.map((session) =>
        args?.detail === 'index'
          ? {
              id: session.id,
              date: new Date(session.endTime).toISOString(),
              type: session.observationType,
              summary: session.summary.slice(0, 220),
              keyFiles: session.keyFiles.slice(0, 3),
            }
          : summarizeForMcp(session),
      );
      return textContent(budgetResults(results, args?.maxTokens ?? 1200));
    }
    case 'ghcpMem_recent': {
      const limit = clamp(args?.limit, 5, 25);
      let recent = db.sessions.filter((s) => !s.retracted).sort((a, b) => b.endTime - a.endTime);
      if (args?.workspaceId) recent = recent.filter((s) => s.workspaceId === args.workspaceId);
      if (args?.workspaceName) {
        const needle = String(args.workspaceName).toLowerCase();
        recent = recent.filter((s) => s.workspaceName?.toLowerCase().includes(needle));
      }
      return textContent({
        count: recent.slice(0, limit).length,
        results: recent.slice(0, limit).map(summarizeForMcp),
      });
    }
    case 'ghcpMem_timeline': {
      const days = clamp(args?.days, 7, 365);
      const limit = clamp(args?.limit, 10, 50);
      const hits = timelineSessions(db, days, limit);
      return textContent({ count: hits.length, days, results: hits.map(summarizeForMcp) });
    }
    case 'ghcpMem_get': {
      const batch = Array.isArray(args?.ids);
      if (batch && args.id !== undefined) throw new Error('Provide id OR ids, not both');
      const ids: string[] = batch ? args.ids : [args.id];
      if (!ids.length || ids.length > 25 || ids.some((id) => typeof id !== 'string' || !id.trim()))
        throw new Error('Provide one id or up to 25 nonempty ids');
      const results: unknown[] = [];
      for (const id of new Set(ids)) {
        const exact = db.sessions.find((session) => session.id === id);
        const matches = exact
          ? [exact]
          : db.sessions.filter((session) => session.id.startsWith(id));
        if (matches.length > 1) throw new Error('Ambiguous session id; use a full id');
        if (!matches[0]) return textContent({ error: `No session matching id "${id}"` });
        results.push(sessionDetail(matches[0], args.repoScope, args.commit));
      }
      return textContent(
        batch || args.maxTokens !== undefined
          ? budgetResults(results, args.maxTokens ?? 2400)
          : results[0],
      );
    }
    case 'ghcpMem_store': {
      if (!MCP_WRITE_ENABLED) throw new Error('MCP write tools are disabled by policy');
      const now = Date.now();
      if (typeof args.summary !== 'string' || !args.summary.trim())
        throw new Error('A nonempty summary is required');
      // Author identity comes from the trusted launcher env — never tool args.
      const agentAuthor = process.env.GHCP_MEM_AGENT_ID
        ? `${parseAuthor(process.env.GHCP_MEM_AGENT_ID).kind}:${parseAuthor(process.env.GHCP_MEM_AGENT_ID).name}`
        : undefined;
      const stamp = normalizeScopeStamp({ scopeLevel: args.scopeLevel, author: agentAuthor });
      if (args.lifecycle !== undefined && !isLifecycleState(args.lifecycle))
        throw new Error(`lifecycle must be one of ${LIFECYCLE_STATES.join(', ')}`);
      const orgPolicy = await loadOrgPolicy();
      const policyDecision = evaluateWrite(orgPolicy, stamp);
      if (!policyDecision.allowed)
        throw new Error(`Organization memory policy denied the write: ${policyDecision.reason}`);
      const checkpoint =
        args.checkpoint === undefined ? undefined : createCheckpoint(args.checkpoint, now);
      if (
        checkpoint &&
        process.env.GHCP_MEM_REPO_SCOPE &&
        checkpoint.repoScope !== process.env.GHCP_MEM_REPO_SCOPE
      )
        throw new Error('Checkpoint repository does not match the configured scope');
      // Redact every user-supplied string BEFORE construction (v1.10.2). Previously
      // the MCP path bypassed redact() entirely, so any external client handing
      // the tool a secret persisted it in cleartext. The redactionCount is fed
      // into the session row so the health score and audit log stay accurate.
      const { redacted, count: redactionCount } = redactPersistedStrings({
        summary: String(args?.summary ?? '').substring(0, 2000),
        keyFiles: (Array.isArray(args?.keyFiles) ? args.keyFiles : []).slice(0, 10).map(String),
        keyTopics: (Array.isArray(args?.keyTopics) ? args.keyTopics : []).slice(0, 10).map(String),
        decisions: (Array.isArray(args?.decisions) ? args.decisions : []).slice(0, 20).map(String),
        problemsSolved: (Array.isArray(args?.problemsSolved) ? args.problemsSolved : [])
          .slice(0, 20)
          .map(String),
        userTags: (Array.isArray(args?.tags) ? args.tags : []).slice(0, 10).map(String),
      });
      const session: StoredSession = {
        checkpoint,
        repoScope: checkpoint?.repoScope ?? process.env.GHCP_MEM_REPO_SCOPE,
        id: randomUUID(),
        workspaceId: checkpoint?.repoScope ?? 'mcp',
        workspaceName: checkpoint?.repoScope ?? 'mcp-client',
        startTime: now,
        endTime: now,
        summary: redacted.summary,
        observationType: (args?.observationType ?? 'research') as StoredSession['observationType'],
        keyFiles: redacted.keyFiles,
        keyTopics: redacted.keyTopics,
        decisions: redacted.decisions,
        problemsSolved: redacted.problemsSolved,
        userTags: redacted.userTags,
        rawEventCount: 0,
        redactionCount,
        ...(stamp.scopeLevel ? { scopeLevel: stamp.scopeLevel } : {}),
        ...(stamp.author ? { author: stamp.author } : {}),
        ...(args.lifecycle !== undefined
          ? { lifecycle: args.lifecycle as StoredSession['lifecycle'] }
          : {}),
      };
      // Use the outer `db` reference loaded at the top of handleCall — the prior
      // double `loadDatabase()` opened a clobber window for any concurrent
      // tools/call mutation that completed between the two reads.
      db.sessions.push(session);
      await saveDatabase(db);
      return textContent({ stored: true, id: session.id, shortId: session.id.substring(0, 8) });
    }
    case 'ghcpMem_delete': {
      if (!MCP_WRITE_ENABLED) throw new Error('MCP write tools are disabled by policy');
      const delId = typeof args?.id === 'string' ? args.id.trim() : '';
      if (!delId) throw new Error('A nonempty session id is required');
      const exact = db.sessions.find((session) => session.id === delId);
      const matches = exact
        ? [exact]
        : db.sessions.filter((session) => session.id.startsWith(delId));
      if (matches.length > 1) throw new Error('Ambiguous session id; use a full id');
      if (
        matches[0] &&
        process.env.GHCP_MEM_REPO_SCOPE &&
        matches[0].repoScope !== process.env.GHCP_MEM_REPO_SCOPE &&
        matches[0].workspaceId !== process.env.GHCP_MEM_REPO_SCOPE
      )
        throw new Error('Session is outside configured repository scope');
      const deleted = matches.length;
      if (matches[0]) {
        db.sessions = db.sessions.filter((session) => session.id !== matches[0].id);
        await saveDatabase(db);
      }
      return textContent({ deleted, id: delId });
    }

    // ── Phase 7: parity tools ─────────────────────────────────────────────
    case 'ghcpMem_entity': {
      const key = String(args?.key ?? '').trim();
      if (!key) return textContent({ error: 'key is required' });
      const rec = buildEntityRecord(key, db.sessions);
      if (!rec) return textContent({ entity: null, message: `No memory of "${key}"` });
      return textContent({
        key: rec.key,
        kind: rec.kind,
        sessionCount: rec.sessionCount,
        firstSeenAt: new Date(rec.firstSeenAt).toISOString(),
        lastTouchedAt: new Date(rec.lastTouchedAt).toISOString(),
        observationTypes: rec.observationTypes,
        topTopics: rec.topTopics,
        decisionLineage: rec.decisionLineage,
        allSupersededOrRetracted: rec.allSupersededOrRetracted,
        decisions: rec.decisions.map((d) => ({
          text: d.text,
          sessionId: d.sessionId,
          emittedAt: new Date(d.emittedAt).toISOString(),
          evidenceFiles: (d.evidence ?? []).map((e) => e.filePath).filter(Boolean),
        })),
        problems: rec.problems.map((p) => ({
          text: p.text,
          sessionId: p.sessionId,
          emittedAt: new Date(p.emittedAt).toISOString(),
        })),
        sessions: rec.sessions,
      });
    }
    case 'ghcpMem_snippets': {
      const query = String(args?.query ?? '');
      const limit = clamp(args?.limit, 10, 50);
      const sinceMs = args?.sinceDays ? Date.now() - clamp(args.sinceDays, 7, 365) * 86_400_000 : 0;
      let pool = db.sessions.filter((s) => !s.retracted);
      if (args?.type) pool = pool.filter((s) => s.observationType === args.type);
      if (args?.tag) pool = pool.filter((s) => (s.userTags ?? []).includes(String(args.tag)));
      if (sinceMs) pool = pool.filter((s) => s.endTime >= sinceMs);
      const snippets: Snippet[] = [];
      for (const s of pool) snippets.push(...snippetsFromSession(s));
      const terms = tokenizeSnippet(query);
      if (terms.size === 0) {
        return textContent({
          count: Math.min(snippets.length, limit),
          results: snippets
            .sort((a, b) => b.emittedAt - a.emittedAt)
            .slice(0, limit)
            .map(snippetForMcp),
        });
      }
      const avgDocLen = avgSnippetLen(snippets);
      const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;
      const now = Date.now();
      const scored = snippets
        .map((sn) => {
          const k = snippetScore(sn, terms, avgDocLen);
          if (k === 0) return undefined;
          const age = Math.max(0, now - sn.emittedAt);
          const decay = Math.pow(2, -age / HALF_LIFE_MS) * 0.3;
          const conf = sn.confidence ?? 0.5;
          const confBoost = (conf - 0.5) * 0.1;
          const supersededPenalty = sn.supersededBy ? -0.3 : 0;
          return { sn, score: k + decay + confBoost + supersededPenalty };
        })
        .filter((e): e is { sn: Snippet; score: number } => !!e)
        .sort((a, b) => b.score - a.score || b.sn.emittedAt - a.sn.emittedAt);
      return textContent({
        count: Math.min(scored.length, limit),
        results: scored.slice(0, limit).map((e) => snippetForMcp(e.sn)),
      });
    }
    case 'ghcpMem_conflicts': {
      // MCP server is stateless across processes — recompute conflicts
      // fresh on every call against the persisted store. This gives the
      // same listing the in-extension /conflicts surface would show,
      // minus the in-memory acknowledgement state (which lives in the
      // extension host).
      const warnings: ConflictWarning[] = [];
      const sorted = [...db.sessions].sort((a, b) => a.endTime - b.endTime);
      for (let i = 1; i < sorted.length; i++) {
        const previous = sorted.slice(0, i);
        const found = detectConflicts(sorted[i], previous);
        for (const w of found) warnings.push(w);
      }
      return textContent({
        count: warnings.length,
        warnings: warnings.map((w) => ({
          newSessionId: w.newSessionId,
          decisionText: w.decisionText,
          marker: w.marker,
          detectedAt: new Date(w.detectedAt).toISOString(),
          candidates: w.candidates.map((c) => ({
            sessionId: c.sessionId,
            summary: c.summary,
            sharedFiles: c.sharedFiles,
            sharedTopics: c.sharedTopics,
            endTime: new Date(c.endTime).toISOString(),
          })),
        })),
      });
    }
    case 'ghcpMem_lineage': {
      const id = String(args?.id ?? '');
      const limit = clamp(args?.limit, 5, 25);
      const target = db.sessions.find((s) => s.id === id || s.id.startsWith(id));
      if (!target) return textContent({ error: `No session matching id "${id}"` });
      const n = getCausalNeighbors(target.id, db.sessions, limit);
      if (!n) return textContent({ error: `Could not compute lineage for "${id}"` });
      return textContent({
        centerId: n.centerId,
        predecessors: n.predecessors.map((p) => ({
          sessionId: p.sessionId,
          summary: p.summary,
          observationType: p.observationType,
          endTime: new Date(p.endTime).toISOString(),
          sharedFiles: p.sharedFiles,
          label: p.label,
          gapDays: Math.round(p.gapMs / 86_400_000),
        })),
        successors: n.successors.map((s) => ({
          sessionId: s.sessionId,
          summary: s.summary,
          observationType: s.observationType,
          endTime: new Date(s.endTime).toISOString(),
          sharedFiles: s.sharedFiles,
          label: s.label,
          gapDays: Math.round(s.gapMs / 86_400_000),
        })),
      });
    }
    case 'ghcpMem_explain': {
      const query = String(args?.query ?? '');
      const id = String(args?.id ?? '');
      const target = db.sessions.find((s) => s.id === id || s.id.startsWith(id));
      if (!target) return textContent({ error: `No session matching id "${id}"` });
      const e = explainScore(target, query, { allSessions: db.sessions });
      return textContent(e);
    }
    case 'ghcpMem_graph': {
      const fileFilter = typeof args?.file === 'string' ? args.file.toLowerCase() : undefined;
      const pool = fileFilter
        ? db.sessions.filter((s) => s.keyFiles.some((f) => f.toLowerCase().includes(fileFilter)))
        : db.sessions;
      const mermaid = buildMermaidGraph(pool);
      return textContent({
        sessionCount: pool.length,
        fileFilter: fileFilter ?? null,
        mermaid,
      });
    }
    case 'ghcpMem_route': {
      const query = String(args?.query ?? '');
      const fileSizes =
        args?.fileSizes && typeof args.fileSizes === 'object'
          ? (args.fileSizes as Record<string, number>)
          : undefined;
      const rec = recommend(query, { fileSizes, mcpAvailable: true });
      return textContent(rec);
    }

    case 'ghcpMem_lessons': {
      const limit = clamp(args?.limit, 12, 100);
      const kind = args?.kind === 'semantic' || args?.kind === 'procedural' ? args.kind : undefined;
      let all = rankLessons(db.lessons ?? []);
      if (kind) all = all.filter((l) => l.kind === kind);
      return textContent(
        all.slice(0, limit).map((l) => ({
          id: l.id.substring(0, 8),
          kind: l.kind,
          text: l.text,
          pinned: l.pinned ?? false,
          supportCount: l.supportCount,
          confidence: Number(l.confidence.toFixed(2)),
          scope: l.scopeLabel,
          tags: l.tags,
        })),
      );
    }

    case 'ghcpMem_compile': {
      const query = String(args.query ?? '').trim();
      const limit = clamp(args?.maxSessions, 8, 25);
      const hits = searchSessions(db, query, {}, limit);
      const compiled = compileContext({
        query,
        budgetTokens: args?.maxTokens ?? 2400,
        branch: typeof args?.branch === 'string' ? args.branch : undefined,
        lessons: rankLessons(db.lessons ?? []),
        sessions: hits,
      });
      return textContent(compiled);
    }
    case 'ghcpMem_knowledge_graph': {
      const graph = buildKnowledgeGraph(db.sessions);
      const focus = typeof args?.focus === 'string' ? args.focus.trim() : '';
      if (!focus) {
        const counts: Record<string, number> = {};
        for (const node of graph.nodes.values()) counts[node.kind] = (counts[node.kind] ?? 0) + 1;
        return textContent({
          nodes: graph.nodes.size,
          edges: graph.edges.length,
          byKind: counts,
          hint: 'Pass focus (e.g. "file:src/auth.ts") for a neighborhood, plus to for a path.',
        });
      }
      if (typeof args?.to === 'string' && args.to.trim()) {
        const path = pathBetween(graph, focus, args.to.trim());
        return textContent(
          path.length
            ? { path: path.map((node) => ({ id: node.id, kind: node.kind, label: node.label })) }
            : { path: [], message: 'No stored connection between those nodes.' },
        );
      }
      const hood = neighborhood(graph, focus, args?.depth ?? 2);
      if (args?.format === 'mermaid') return textContent({ mermaid: neighborhoodToMermaid(hood) });
      return textContent({
        center: hood.center,
        nodes: hood.nodes,
        edges: hood.edges,
      });
    }
    case 'ghcpMem_set_lifecycle': {
      if (!MCP_WRITE_ENABLED) throw new Error('MCP write tools are disabled by policy');
      const target = findUniqueSession(db, String(args.id ?? ''));
      transitionLifecycle(target, args.lifecycle as StoredSession['lifecycle'] & string);
      await saveDatabase(db);
      return textContent({ id: target.id, lifecycle: target.lifecycle });
    }
    case 'ghcpMem_record_outcome': {
      if (!MCP_WRITE_ENABLED) throw new Error('MCP write tools are disabled by policy');
      const target = findUniqueSession(db, String(args.id ?? ''));
      const outcome = recordOutcome(target, {
        status: args.status,
        decisionIndex: args.decisionIndex,
        observations: args.observations,
        reportedBy: process.env.GHCP_MEM_AGENT_ID,
      });
      await saveDatabase(db);
      return textContent({ id: target.id, outcome });
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/** Resolve a session by exact id or unique prefix; throws on ambiguity/miss. */
function findUniqueSession(db: StoredDatabase, id: string): StoredSession {
  const trimmed = id.trim();
  if (!trimmed) throw new Error('A nonempty session id is required');
  const exact = db.sessions.find((session) => session.id === trimmed);
  const matches = exact ? [exact] : db.sessions.filter((session) => session.id.startsWith(trimmed));
  if (matches.length > 1) throw new Error('Ambiguous session id; use a full id');
  if (!matches[0]) throw new Error(`No session matching id "${trimmed}"`);
  return matches[0];
}

/** Compact snippet shape for MCP responses. */
function snippetForMcp(sn: Snippet): any {
  return {
    id: sn.id,
    sessionId: sn.sessionId,
    kind: sn.kind,
    text: sn.text,
    emittedAt: new Date(sn.emittedAt).toISOString(),
    confidence: sn.confidence,
    evidenceFiles: (sn.evidence ?? []).map((e) => e.filePath).filter(Boolean),
  };
}

// ── MCP resources + prompts (v1.20.0) ───────────────────────────────────────
// Agents subscribe to the right context (`memory://…`) instead of hand-rolling
// search calls. All resources are read-only views over the same filtered store
// the read tools see; nothing here widens access.

export const RESOURCES = [
  {
    uri: 'memory://repo/decisions',
    name: 'Remembered decisions',
    description:
      'Every stored decision with its lifecycle state and recorded outcomes, newest first.',
    mimeType: 'text/markdown',
  },
  {
    uri: 'memory://repo/lessons',
    name: 'Consolidated lessons',
    description: 'Durable semantic + procedural lessons distilled from past sessions.',
    mimeType: 'text/markdown',
  },
  {
    uri: 'memory://repo/recent',
    name: 'Recent sessions',
    description: 'The ten most recent compressed sessions.',
    mimeType: 'text/markdown',
  },
  {
    uri: 'memory://repo/outcomes',
    name: 'Decision outcomes',
    description: 'Outcome coverage: which remembered decisions demonstrably worked.',
    mimeType: 'text/markdown',
  },
  {
    uri: 'memory://repo/graph',
    name: 'Knowledge graph summary',
    description: 'Node/edge counts of the engineering knowledge graph derived from memory.',
    mimeType: 'text/markdown',
  },
] as const;

async function readableSessions(): Promise<StoredSession[]> {
  const db = await loadDatabase();
  let sessions = db.sessions.filter((session) => !session.retracted);
  sessions = filterByScope(sessions, { author: process.env.GHCP_MEM_AGENT_ID });
  const scope = process.env.GHCP_MEM_REPO_SCOPE;
  if (scope)
    sessions = sessions.filter(
      (session) => session.repoScope === scope || session.workspaceId === scope,
    );
  return sessions;
}

async function readResource(uri: string): Promise<string> {
  const sessions = await readableSessions();
  switch (uri) {
    case 'memory://repo/decisions': {
      const lines = ['# Remembered decisions', ''];
      for (const session of [...sessions].sort((a, b) => b.endTime - a.endTime)) {
        for (const [index, decision] of session.decisions.entries()) {
          const outcome = (session.outcomes ?? [])
            .filter((o) => o.decisionIndex === index)
            .sort((a, b) => b.observedAt - a.observedAt)[0];
          lines.push(
            `- ${decision} _(session ${session.id.slice(0, 8)}${session.lifecycle ? `, ${session.lifecycle}` : ''}${outcome ? `, outcome: ${outcome.status}` : ''})_`,
          );
        }
      }
      return lines.length > 2 ? lines.join('\n') : '# Remembered decisions\n\n_None stored yet._';
    }
    case 'memory://repo/lessons': {
      const db = await loadDatabase();
      const lessons = rankLessons(db.lessons ?? []);
      return lessons.length
        ? ['# Consolidated lessons', '', ...lessons.map((l) => `- [${l.kind}] ${l.text}`)].join(
            '\n',
          )
        : '# Consolidated lessons\n\n_None derived yet._';
    }
    case 'memory://repo/recent': {
      const recent = [...sessions].sort((a, b) => b.endTime - a.endTime).slice(0, 10);
      return [
        '# Recent sessions',
        '',
        ...recent.map(
          (s) =>
            `- ${new Date(s.endTime).toISOString().slice(0, 10)} [${s.observationType}] ${s.summary.slice(0, 160)} (\`${s.id.slice(0, 8)}\`)`,
        ),
      ].join('\n');
    }
    case 'memory://repo/outcomes': {
      const withOutcomes = sessions.filter((s) => (s.outcomes ?? []).length > 0);
      const lines = ['# Decision outcomes', ''];
      for (const session of withOutcomes) {
        for (const outcome of session.outcomes ?? []) {
          lines.push(
            `- ${outcome.status}: ${outcome.observations.join('; ') || '(no observations)'} _(session ${session.id.slice(0, 8)})_`,
          );
        }
      }
      return lines.length > 2 ? lines.join('\n') : '# Decision outcomes\n\n_None recorded yet._';
    }
    case 'memory://repo/graph': {
      const graph = buildKnowledgeGraph(sessions);
      const counts: Record<string, number> = {};
      for (const node of graph.nodes.values()) counts[node.kind] = (counts[node.kind] ?? 0) + 1;
      return [
        '# Knowledge graph',
        '',
        `${graph.nodes.size} nodes, ${graph.edges.length} edges.`,
        ...Object.entries(counts).map(([kind, count]) => `- ${kind}: ${count}`),
        '',
        'Use the ghcpMem_knowledge_graph tool with a focus node for neighborhoods and paths.',
      ].join('\n');
    }
    default:
      throw new Error(`Unknown resource: ${uri}`);
  }
}

export const PROMPTS = [
  {
    name: 'resume-task',
    description: 'Resume a durable task exactly where the previous agent left off.',
    arguments: [
      {
        name: 'taskId',
        description: 'Task id to resume (omit to list open tasks).',
        required: false,
      },
    ],
  },
  {
    name: 'memory-review',
    description: 'Review the store for stale, conflicting or low-confidence memories.',
    arguments: [],
  },
  {
    name: 'architecture-recall',
    description: 'Recall the architectural decisions and outcomes for a topic before changing it.',
    arguments: [{ name: 'topic', description: 'Component, file or concept.', required: true }],
  },
  {
    name: 'incident-context',
    description: 'Assemble the memory context relevant to a production incident.',
    arguments: [{ name: 'query', description: 'Symptom or subsystem.', required: true }],
  },
] as const;

function promptText(name: string, args: Record<string, string>): string {
  switch (name) {
    case 'resume-task':
      return args.taskId
        ? `Resume task ${args.taskId}: call ghcpMem_resume with that id, then ghcpMem_compile for its goal before writing any code. Honor recorded blockers and acceptance criteria; completion claims require launcher-authorized verification.`
        : 'List open work with ghcpMem_task_status, pick the task to continue, then call ghcpMem_resume followed by ghcpMem_compile for its goal before writing any code.';
    case 'memory-review':
      return 'Review this store for trust: call ghcpMem_recent and ghcpMem_search for active topics; for each decision check lifecycle state, recorded outcomes (memory://repo/outcomes) and conflicts; propose ghcpMem_set_lifecycle or ghcpMem_record_outcome updates — never delete without an explicit human instruction.';
    case 'architecture-recall':
      return `Before changing anything related to "${args.topic}": call ghcpMem_compile with that topic, inspect ghcpMem_knowledge_graph focus nodes for it, and surface prior decisions with their outcomes. Flag any decision marked regressed or reverted before proposing a design.`;
    case 'incident-context':
      return `Assemble incident context for "${args.query}": ghcpMem_search for the symptom, ghcpMem_timeline for the recent window, ghcpMem_knowledge_graph to trace affected files to past decisions, and report which remembered decisions carry regressed outcomes.`;
    default:
      throw new Error(`Unknown prompt: ${name}`);
  }
}

function send(resp: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(resp) + '\n');
}

async function dispatch(req: JsonRpcRequest): Promise<JsonRpcResponse | undefined> {
  const id = req.id ?? null;
  try {
    switch (req.method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            capabilities: { tools: {}, resources: {}, prompts: {} },
          },
        };
      case 'initialized':
      case 'notifications/initialized':
        return undefined; // notification — no response
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
      case 'resources/list':
        return { jsonrpc: '2.0', id, result: { resources: RESOURCES } };
      case 'resources/read': {
        const uri = String(req.params?.uri ?? '');
        const text = await readResource(uri);
        return {
          jsonrpc: '2.0',
          id,
          result: { contents: [{ uri, mimeType: 'text/markdown', text }] },
        };
      }
      case 'prompts/list':
        return { jsonrpc: '2.0', id, result: { prompts: PROMPTS } };
      case 'prompts/get': {
        const name = String(req.params?.name ?? '');
        const prompt = PROMPTS.find((entry) => entry.name === name);
        if (!prompt) throw new Error(`Unknown prompt: ${name}`);
        const args = (req.params?.arguments ?? {}) as Record<string, string>;
        for (const arg of prompt.arguments) {
          if (arg.required && !String(args[arg.name] ?? '').trim())
            throw new Error(`Prompt "${name}" requires argument: ${arg.name}`);
        }
        return {
          jsonrpc: '2.0',
          id,
          result: {
            description: prompt.description,
            messages: [{ role: 'user', content: { type: 'text', text: promptText(name, args) } }],
          },
        };
      }
      case 'tools/call': {
        const { name, arguments: args } = req.params ?? {};
        const result = await handleCall(String(name), args ?? {});
        return { jsonrpc: '2.0', id, result };
      }
      case 'shutdown':
        setImmediate(() => process.exit(0));
        return { jsonrpc: '2.0', id, result: null };
      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${req.method}` },
        };
    }
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
    };
  }
}

function main(): void {
  const rl = createInterface({ input: process.stdin });
  let pending = 0;
  let requests: Promise<void> = Promise.resolve();
  let closed = false;
  const tryExit = () => {
    if (closed && pending === 0) process.exit(0);
  };
  rl.on('line', (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(trimmed);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    pending++;
    requests = requests
      .then(() => dispatch(req))
      .then((resp) => {
        if (resp) send(resp);
      })
      .catch((err) =>
        send({
          jsonrpc: '2.0',
          id: req.id ?? null,
          error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
        }),
      )
      .finally(() => {
        pending--;
        tryExit();
      });
  });
  rl.on('close', () => {
    closed = true;
    tryExit();
  });
  // Never write logs to stdout — reserved for JSON-RPC frames.
  process.stderr.write(`[ghcp-mem-mcp] listening on stdio, store=${storePath()}\n`);
}

// Only run the server when invoked as a script (not when required by tests)
if (require.main === module) {
  main();
}

export { TOOLS, searchSessions, loadDatabase, storePath };
