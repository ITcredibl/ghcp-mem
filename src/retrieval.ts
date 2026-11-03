/**
 * Unified retrieval pipeline (v1.22.0, RET-003) — ONE implementation of
 * scoring, calibration, fusion, duplicate collapse and relevance labeling,
 * shared by the extension ContextStore and the standalone stdio MCP server.
 *
 * The callers keep what is genuinely theirs — candidate pre-filtering
 * (inverted index + query expansion, workspace/repo/lifecycle/policy/agent
 * scoping, retraction) and their embedding providers — and inject the rest
 * through adapters. With identical candidates, configuration and embedding
 * provider, both paths produce identical eligible ids, ordering and
 * relevance states (parity-tested). Capability differences (the store's
 * query expansion and neural embeddings, the server's local lexical
 * embedder) are explicit adapter inputs, not divergent code.
 *
 * Pure module — no vscode imports.
 */
import {
  computeTermStats,
  extractTerms,
  FUSION_RANK_MISS,
  fuseRanks,
  FusionInput,
  FusionWeights,
  keywordScoreFromStats,
  requiredSignificantMatches,
  SessionTermStats,
  significantQueryTerms,
} from './searchCore';
import { classifyIntent, intentWeights } from './queryIntent';
import { effectiveConfidence } from './decay';
import { originTrust } from './teamSync';
import { CompressedSession } from './types';
import { cosineSim } from './embeddings';
import { defaultWeights, SignalName } from './adaptiveWeights';

export type RelevanceState = 'match' | 'weak_match' | 'no_match';

export interface RetrievalAdapters {
  /** Memoised BM25 stats; defaults to computing per call. */
  statsFor?: (s: CompressedSession) => SessionTermStats;
  /** Workspace id for the workspace-match boost (extension host only). */
  workspaceId?: string;
  /**
   * Embedding provider — BOTH sides of one provider, or neither. The version
   * string makes cached vectors from a different provider non-comparable.
   */
  embedQuery?: (query: string) => number[] | undefined;
  embeddingFor?: (s: CompressedSession) => number[] | undefined;
  embeddingProviderVersion?: string;
  /** Learned adaptive multipliers (extension host); defaults to neutral. */
  learnedWeights?: Record<SignalName, number>;
  /** Session ids admitted only via query expansion (no match-ratio credit). */
  expansionOnly?: ReadonlySet<string>;
  now?: number;
}

export interface RetrievedItem {
  session: CompressedSession;
  /** Fraction of SIGNIFICANT query terms this session matches (lexical overlap, not correctness). */
  termCoverage: number;
  relevance: 'match' | 'weak_match';
}

export interface RetrievalOutcome {
  items: RetrievedItem[];
  /** Whole-response state: no_match = abstained (or nothing eligible). */
  state: RelevanceState;
  significantTermCount: number;
  /** Per-id fusion signal snapshot, for the extension's adaptive learner. */
  signals: Map<string, Record<SignalName, number>>;
}

const WEAK_COVERAGE_FLOOR = 0.5;
const COLLAPSE_THRESHOLD = 0.9;

/** Jaccard similarity on two string arrays (case-insensitive, deduped). */
function jaccard(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 0;
  const sa = new Set(a.map((s) => s.toLowerCase()));
  const sb = new Set(b.map((s) => s.toLowerCase()));
  let inter = 0;
  for (const v of sa) if (sb.has(v)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Rank pre-filtered candidates for a query. Empty queries are browse mode:
 * recency order, full coverage, state 'match' — an explicitly separate
 * operation from relevance search (RET-002).
 */
export function retrieve(
  candidates: readonly CompressedSession[],
  query: string,
  limit: number,
  adapters: RetrievalAdapters = {},
): RetrievalOutcome {
  const statsFor = adapters.statsFor ?? ((s: CompressedSession) => computeTermStats(s));
  const now = adapters.now ?? Date.now();
  const signals = new Map<string, Record<SignalName, number>>();
  const terms = extractTerms(query ?? '');

  if (terms.size === 0) {
    const items = [...candidates]
      .sort((a, b) => b.endTime - a.endTime)
      .slice(0, limit)
      .map((session) => ({ session, termCoverage: 1, relevance: 'match' as const }));
    return { items, state: items.length ? 'match' : 'no_match', significantTermCount: 0, signals };
  }

  // Keyword scores + zero-positive abstention.
  const avgDocLen = candidates.length
    ? candidates.reduce((sum, s) => sum + statsFor(s).docLenWeighted, 0) / candidates.length
    : 50;
  const kScore = new Map<string, number>();
  for (const s of candidates) {
    kScore.set(
      s.id,
      keywordScoreFromStats(
        statsFor(s),
        terms,
        !!adapters.workspaceId && s.workspaceId === adapters.workspaceId,
        avgDocLen,
      ),
    );
  }
  let scoped = candidates.filter((s) => (kScore.get(s.id) ?? 0) > 0);
  if (scoped.length === 0)
    return { items: [], state: 'no_match', significantTermCount: 0, signals };

  // Calibrated relevance: coverage of SIGNIFICANT terms (shared thresholds).
  const significant = significantQueryTerms(terms);
  const sigMatched = (s: CompressedSession): number => {
    const stats = statsFor(s);
    let matched = 0;
    for (const t of significant) if (stats.wtf.has(t)) matched++;
    return matched;
  };
  if (significant.size > 0) {
    scoped = scoped.filter((s) => sigMatched(s) > 0);
    if (!scoped.some((s) => sigMatched(s) >= requiredSignificantMatches(significant.size)))
      return { items: [], state: 'no_match', significantTermCount: significant.size, signals };
  }

  // Rank maps: keyword, recency, optional embeddings.
  const keywordRanked = [...scoped].sort((a, b) => kScore.get(b.id)! - kScore.get(a.id)!);
  const kRank = new Map(keywordRanked.map((s, i) => [s.id, i]));
  const recencyRanked = [...scoped].sort((a, b) => b.endTime - a.endTime);
  const rRank = new Map(recencyRanked.map((s, i) => [s.id, i]));
  let eRank: Map<string, number> | undefined;
  if (adapters.embedQuery && adapters.embeddingFor && scoped.length > 1) {
    const queryVec = adapters.embedQuery(query);
    if (queryVec) {
      const sims = scoped
        .map((s) => ({ id: s.id, sim: cosineSim(queryVec, adapters.embeddingFor!(s)) }))
        .sort((a, b) => b.sim - a.sim);
      eRank = new Map(sims.map((entry, index) => [entry.id, index]));
    }
  }

  // One fusion formula: intent reweighting × learned adaptive multipliers.
  const iw = intentWeights(classifyIntent(query));
  const learned = adapters.learnedWeights ?? defaultWeights();
  const fusionWeights: FusionWeights = {
    keyword: iw.keywordWeight * learned.keyword,
    recencyMultiplier: iw.recencyMultiplier * learned.recency,
    confidence: learned.confidence,
    reinforcement: learned.reinforcement,
    feedback: learned.feedback,
    decisionBoost: iw.decisionBoost,
    problemBoost: iw.problemBoost,
  };

  const coverageOf = (s: CompressedSession): number => {
    if (significant.size === 0) return 1;
    if (adapters.expansionOnly?.has(s.id) && sigMatched(s) === 0) return 0;
    return sigMatched(s) / significant.size;
  };

  const byId = new Map(scoped.map((s) => [s.id, s]));
  const fusionInputs: FusionInput[] = scoped.map((s) => ({
    id: s.id,
    endTime: s.endTime,
    keywordRank: kRank.get(s.id) ?? FUSION_RANK_MISS,
    recencyRank: rRank.get(s.id) ?? FUSION_RANK_MISS,
    embeddingRank: eRank ? (eRank.get(s.id) ?? FUSION_RANK_MISS) : undefined,
    workspaceMatch: !!adapters.workspaceId && s.workspaceId === adapters.workspaceId,
    matchRatio: coverageOf(s),
    // Team-origin rows rank discounted until locally corroborated.
    confidence: (effectiveConfidence(s) ?? 0.5) * originTrust(s),
    retrieved: s.usage?.retrieved ?? 0,
    accepted: s.usage?.accepted ?? 0,
    rejected: s.usage?.rejected ?? 0,
    superseded: !!s.supersededBy,
    hasDecisions: s.decisions.length > 0,
    hasProblems: s.problemsSolved.length > 0,
  }));

  const scored = fuseRanks(fusionInputs, fusionWeights, { now });
  for (const r of scored) signals.set(r.id, r.signals);

  // Near-duplicate collapse — keep the top-ranked representative.
  const kept: CompressedSession[] = [];
  for (const r of scored) {
    const session = byId.get(r.id)!;
    const isDup = kept.some((k) => jaccard(session.keyTopics, k.keyTopics) >= COLLAPSE_THRESHOLD);
    if (!isDup) kept.push(session);
    if (kept.length >= limit) break;
  }

  const items: RetrievedItem[] = kept.map((session) => {
    const termCoverage = coverageOf(session);
    return {
      session,
      termCoverage,
      relevance: termCoverage >= WEAK_COVERAGE_FLOOR ? 'match' : 'weak_match',
    };
  });
  const best = Math.max(0, ...items.map((item) => item.termCoverage));
  return {
    items,
    state: items.length === 0 ? 'no_match' : best >= WEAK_COVERAGE_FLOOR ? 'match' : 'weak_match',
    significantTermCount: significant.size,
    signals,
  };
}
