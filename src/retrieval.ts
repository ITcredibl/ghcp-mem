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
import { cosineSim } from './vectorMath';
import { defaultWeights, SignalName } from './adaptiveWeights';

export type RelevanceState = 'match' | 'weak_match' | 'no_match';

/**
 * How the response was produced (RET-001: results identify the active
 * retrieval mode and provider). 'browse' = empty-query recency listing,
 * explicitly not a relevance search. 'lexical-fallback' = a semantic provider
 * is configured but unavailable this call — the explicit fallback state.
 */
export type RetrievalMode = 'browse' | 'lexical' | 'hybrid-semantic' | 'lexical-fallback';

export interface RetrievalAdapters {
  /** Memoised BM25 stats; defaults to computing per call. */
  statsFor?: (s: CompressedSession) => SessionTermStats;
  /** Workspace id for the workspace-match boost (extension host only). */
  workspaceId?: string;
  /**
   * Lexical dense-rerank provider — BOTH sides of one provider, or neither.
   * The version string makes cached vectors from a different provider
   * non-comparable. Ignored when `semanticSim` is present.
   */
  embedQuery?: (query: string) => number[] | undefined;
  embeddingFor?: (s: CompressedSession) => number[] | undefined;
  embeddingProviderVersion?: string;
  /**
   * Semantic evidence (RET-001): cosine similarity per candidate id, computed
   * by the CALLER from one neural provider for both the query and the cached
   * session vectors, compatibility-validated per RET-002 (sessions without a
   * compatible vector are simply absent). Its presence switches the pipeline
   * to hybrid-semantic mode: a candidate with sufficient similarity is
   * retrievable with zero keyword overlap.
   */
  semanticSim?: ReadonlyMap<string, number>;
  /** Canonical provider id (reported in the outcome); set with semanticSim. */
  semanticProvider?: string;
  /**
   * Set when a configured semantic provider could not be used for this call
   * (load failure, incompatible cache …). Reported as mode
   * 'lexical-fallback' with this reason — never silently.
   */
  semanticFallback?: string;
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
  /** Cosine similarity under the active semantic provider (hybrid mode only). */
  semanticSim?: number;
  /** Which evidence admitted this result. */
  evidence: 'lexical' | 'semantic' | 'both';
  relevance: 'match' | 'weak_match';
}

export interface RetrievalOutcome {
  items: RetrievedItem[];
  /** Whole-response state: no_match = abstained (or nothing eligible). */
  state: RelevanceState;
  /** Active retrieval mode + provider (RET-001 reporting contract). */
  mode: RetrievalMode;
  provider?: string;
  /** Human-readable reason when mode === 'lexical-fallback'. */
  fallbackReason?: string;
  significantTermCount: number;
  /** Per-id fusion signal snapshot, for the extension's adaptive learner. */
  signals: Map<string, Record<SignalName, number>>;
}

const WEAK_COVERAGE_FLOOR = 0.5;
const COLLAPSE_THRESHOLD = 0.9;

/**
 * Semantic decision thresholds (RET-003: selected on the DEVELOPMENT set —
 * scripts/eval-dev.json — and validated once on the frozen set; see
 * eval-baseline.json for the measurements backing them).
 *  - candidate: minimum similarity for a zero-keyword-overlap candidate to
 *    enter the pipeline at all.
 *  - weak: similarity that keeps a result as an explicit weak_match.
 *  - match: similarity that labels a result 'match' and, like full lexical
 *    coverage, lifts the response out of abstention.
 *
 * Committed values were selected on the 200-query dev set (2026-11-03,
 * scripts/tune-semantic.mjs over eval-corpus-v2): match=0.5 is the lowest
 * floor at which NO labeled negative is served semantically (the hardest
 * negative peaks at 0.48 cosine); candidate=0.3 admits ~86% of labeled
 * relevant pairs into ranking. Lowering match to 0.4 buys paraphrase recall
 * (58% vs 32%) at 11.5% false positives — rejected: abstention integrity
 * outranks recall, per the project contract.
 */
export const SEMANTIC_THRESHOLDS = { candidate: 0.3, weak: 0.3, match: 0.5 };

/**
 * Dev-tuning hook: scripts/tune-semantic.mjs sweeps these against the
 * DEVELOPMENT set. Production and the frozen-set validation always run the
 * committed values above — never ship a call to this outside tuning/tests.
 */
export function _setSemanticThresholdsForTuning(t: {
  candidate: number;
  weak: number;
  match: number;
}): void {
  (SEMANTIC_THRESHOLDS as { candidate: number; weak: number; match: number }).candidate =
    t.candidate;
  (SEMANTIC_THRESHOLDS as { candidate: number; weak: number; match: number }).weak = t.weak;
  (SEMANTIC_THRESHOLDS as { candidate: number; weak: number; match: number }).match = t.match;
}

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
 * Near-duplicate test for result collapse (RET-004). Topic overlap ALONE never
 * establishes duplication — two memories qualify only when they are the same
 * content (hash), or near-identical on topics AND summary AND decisions, in
 * the same governance scope, with no supersession link between them. This
 * keeps a JWT decision and a cookie-authentication decision that share
 * identical topics as two visible results, keeps superseding/superseded pairs
 * co-retrievable (fusion already downranks the superseded one), and keeps
 * contradicting records side by side instead of silently burying one.
 */
function isNearDuplicate(a: CompressedSession, b: CompressedSession): boolean {
  // Lineage is meaning, not duplication: never collapse across a supersession
  // link — the replacement and its history must both stay reachable.
  if (
    a.supersedes === b.id ||
    a.supersededBy === b.id ||
    b.supersedes === a.id ||
    b.supersededBy === a.id
  ) {
    return false;
  }
  // Different governance scopes are different records by definition — even
  // with byte-identical content (access rules differ, so collapsing one away
  // could hide the record a narrower audience is allowed to see).
  if ((a.scopeLevel ?? 'repository') !== (b.scopeLevel ?? 'repository')) return false;
  // Identical persisted content is a true duplicate regardless of wording.
  if (a.contentHash && a.contentHash === b.contentHash) return true;
  if (jaccard(a.keyTopics, b.keyTopics) < COLLAPSE_THRESHOLD) return false;
  const summaryTerms = (s: CompressedSession) => [...extractTerms(s.summary ?? '')];
  if (jaccard(summaryTerms(a), summaryTerms(b)) < COLLAPSE_THRESHOLD) return false;
  // Decisions are the discriminator the topic/summary surface can miss: a
  // "use JWT" record and a "use cookie sessions" record must both survive.
  const decTerms = (s: CompressedSession) => [...extractTerms((s.decisions ?? []).join(' '))];
  const da = decTerms(a);
  const db = decTerms(b);
  if (da.length === 0 && db.length === 0) return true;
  return jaccard(da, db) >= COLLAPSE_THRESHOLD;
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
  const semantic = adapters.semanticSim;
  const simOf = (s: CompressedSession): number => semantic?.get(s.id) ?? 0;
  const mode: RetrievalMode = semantic
    ? 'hybrid-semantic'
    : adapters.semanticFallback
      ? 'lexical-fallback'
      : 'lexical';
  const modeFields = {
    mode,
    provider: semantic ? adapters.semanticProvider : undefined,
    fallbackReason: adapters.semanticFallback,
  };

  if (terms.size === 0) {
    const items = [...candidates]
      .sort((a, b) => b.endTime - a.endTime)
      .slice(0, limit)
      .map((session) => ({
        session,
        termCoverage: 1,
        evidence: 'lexical' as const,
        relevance: 'match' as const,
      }));
    return {
      items,
      state: items.length ? 'match' : 'no_match',
      ...modeFields,
      mode: 'browse',
      significantTermCount: 0,
      signals,
    };
  }

  // Keyword scores + zero-positive abstention. In hybrid mode a candidate
  // with sufficient semantic similarity survives with ZERO keyword overlap
  // (RET-001) — lexical and semantic candidacy are independent.
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
  const semanticCandidate = (s: CompressedSession): boolean =>
    simOf(s) >= SEMANTIC_THRESHOLDS.candidate;
  let scoped = candidates.filter((s) => (kScore.get(s.id) ?? 0) > 0 || semanticCandidate(s));
  if (scoped.length === 0)
    return { items: [], state: 'no_match', ...modeFields, significantTermCount: 0, signals };

  // Calibrated relevance: coverage of SIGNIFICANT terms (shared thresholds).
  // Semantic candidates are exempt from the lexical-coverage filter, and a
  // STRONG semantic hit lifts the response out of abstention on its own.
  const significant = significantQueryTerms(terms);
  const sigMatched = (s: CompressedSession): number => {
    const stats = statsFor(s);
    let matched = 0;
    for (const t of significant) if (stats.wtf.has(t)) matched++;
    return matched;
  };
  if (significant.size > 0) {
    scoped = scoped.filter((s) => sigMatched(s) > 0 || semanticCandidate(s));
    const lexicallyServable = scoped.some(
      (s) => sigMatched(s) >= requiredSignificantMatches(significant.size),
    );
    const semanticallyServable = scoped.some((s) => simOf(s) >= SEMANTIC_THRESHOLDS.match);
    if (!lexicallyServable && !semanticallyServable)
      return {
        items: [],
        state: 'no_match',
        ...modeFields,
        significantTermCount: significant.size,
        signals,
      };
  }

  // Rank maps: keyword, recency, dense evidence. In hybrid mode the dense
  // rank comes from the semantic provider; otherwise from the legacy
  // lexical-dense rerank adapters when supplied.
  const keywordRanked = [...scoped].sort(
    (a, b) => (kScore.get(b.id) ?? 0) - (kScore.get(a.id) ?? 0) || a.id.localeCompare(b.id),
  );
  const kRank = new Map(keywordRanked.map((s, i) => [s.id, i]));
  const recencyRanked = [...scoped].sort(
    (a, b) => b.endTime - a.endTime || a.id.localeCompare(b.id),
  );
  const rRank = new Map(recencyRanked.map((s, i) => [s.id, i]));
  let eRank: Map<string, number> | undefined;
  if (semantic && scoped.length > 1) {
    const sims = scoped
      .map((s) => ({ id: s.id, sim: simOf(s) }))
      .sort((a, b) => b.sim - a.sim || a.id.localeCompare(b.id));
    eRank = new Map(sims.map((entry, index) => [entry.id, index]));
  } else if (adapters.embedQuery && adapters.embeddingFor && scoped.length > 1) {
    const queryVec = adapters.embedQuery(query);
    if (queryVec) {
      const sims = scoped
        .map((s) => ({ id: s.id, sim: cosineSim(queryVec, adapters.embeddingFor!(s)) }))
        .sort((a, b) => b.sim - a.sim || a.id.localeCompare(b.id));
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
    const isDup = kept.some((k) => isNearDuplicate(session, k));
    if (!isDup) kept.push(session);
    if (kept.length >= limit) break;
  }

  const items: RetrievedItem[] = kept.map((session) => {
    const termCoverage = coverageOf(session);
    const sim = simOf(session);
    const lexicalMatch = termCoverage >= WEAK_COVERAGE_FLOOR;
    const semanticMatch = !!semantic && sim >= SEMANTIC_THRESHOLDS.match;
    const lexicalEvidence = termCoverage > 0;
    const semanticEvidence = !!semantic && sim >= SEMANTIC_THRESHOLDS.weak;
    return {
      session,
      termCoverage,
      ...(semantic ? { semanticSim: Math.round(sim * 1e4) / 1e4 } : {}),
      evidence:
        lexicalEvidence && semanticEvidence
          ? ('both' as const)
          : semanticEvidence
            ? ('semantic' as const)
            : ('lexical' as const),
      relevance: lexicalMatch || semanticMatch ? ('match' as const) : ('weak_match' as const),
    };
  });
  const anyMatch = items.some((item) => item.relevance === 'match');
  return {
    items,
    state: items.length === 0 ? 'no_match' : anyMatch ? 'match' : 'weak_match',
    ...modeFields,
    significantTermCount: significant.size,
    signals,
  };
}
