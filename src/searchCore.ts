/**
 * Shared search primitives used by both ContextStore (in-process) and the
 * standalone MCP server (out-of-process). Keeping these in one module
 * prevents the two ranking paths from drifting — the v1.1.5 ranking bug
 * existed precisely because mcpServer.ts and contextStore.ts each carried
 * their own copy of the keyword scorer.
 *
 * The structural shape of a session here is intentionally a narrow subset
 * of `CompressedSession` so this module stays import-free of vscode types
 * (the MCP server runs as a plain Node process under stdio).
 */

/** Minimum surface of a session needed by the shared scorer. */
export interface ScorableSession {
  workspaceId: string;
  summary: string;
  keyFiles: string[];
  keyTopics: string[];
  decisions: string[];
  problemsSolved: string[];
  userTags: string[];
  observationType: string;
}

/** Field weights — kept identical to the original duplicated logic. */
const WEIGHT_SUMMARY = 3;
const WEIGHT_KEY_TOPIC = 5;
const WEIGHT_KEY_FILE = 2;
const WEIGHT_DECISION = 4;
const WEIGHT_PROBLEM = 4;
const WEIGHT_USER_TAG = 6;
const WORKSPACE_BOOST = 2;

/** BM25 tuning parameters. */
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/**
 * Compute a weighted document length for BM25 normalisation.
 * Counts unique terms across all weighted fields (weighted by field weight).
 */
export function sessionDocLen(s: ScorableSession): number {
  let total = 0;
  const addField = (text: string, weight: number) => {
    total += extractTerms(text).size * weight;
  };
  addField(s.summary, WEIGHT_SUMMARY);
  for (const t of s.keyTopics) addField(t, WEIGHT_KEY_TOPIC);
  for (const f of s.keyFiles) addField(f, WEIGHT_KEY_FILE);
  for (const d of s.decisions) addField(d, WEIGHT_DECISION);
  for (const p of s.problemsSolved) addField(p, WEIGHT_PROBLEM);
  for (const t of s.userTags) addField(t, WEIGHT_USER_TAG);
  return total || 1;
}

/**
 * Compute the average document length across a set of sessions for BM25.
 * Falls back to a sensible default (50 weighted terms) when the set is empty.
 */
export function computeAvgDocLen(sessions: ScorableSession[]): number {
  if (sessions.length === 0) return 50;
  return sessions.reduce((sum, s) => sum + sessionDocLen(s), 0) / sessions.length;
}

/**
 * Tokenise a piece of free text into a set of search terms.
 * Identical splitting rules used everywhere we score: lowercase, strip
 * non-[a-z0-9_-] punctuation to spaces, split on whitespace, drop ≤2-char
 * tokens (so 'js', 'is', 'to' don't bloat the index).
 */
export function extractTerms(text: string): Set<string> {
  return new Set(
    (text ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2),
  );
}

/**
 * BM25-weighted keyword score for one session against a set of query terms.
 *
 * Field weights are applied as multipliers to the per-term weighted TF,
 * preserving the original field-importance hierarchy while adding BM25's
 * TF-saturation and document-length normalisation.
 *
 * When `workspaceId` is supplied AND matches the session's workspaceId the
 * score gets a small additive boost. The MCP server passes no workspaceId
 * since it serves cross-workspace queries from disk.
 *
 * @param avgDocLen  Average document length (weighted) across the candidate
 *                   set. Callers should compute this with `computeAvgDocLen()`
 *                   before scoring. Defaults to 50 for backward compatibility.
 */
export function keywordScore(
  s: ScorableSession,
  terms: Set<string>,
  workspaceId?: string,
  avgDocLen = 50,
): number {
  let score = 0;
  if (workspaceId && s.workspaceId === workspaceId) score += WORKSPACE_BOOST;

  // Build a weighted term-frequency map across all fields.
  const wtf = new Map<string, number>();
  const addField = (text: string, weight: number) => {
    for (const tok of extractTerms(text)) {
      wtf.set(tok, (wtf.get(tok) ?? 0) + weight);
    }
  };
  addField(s.summary, WEIGHT_SUMMARY);
  for (const t of s.keyTopics) addField(t, WEIGHT_KEY_TOPIC);
  for (const f of s.keyFiles) addField(f, WEIGHT_KEY_FILE);
  for (const d of s.decisions) addField(d, WEIGHT_DECISION);
  for (const p of s.problemsSolved) addField(p, WEIGHT_PROBLEM);
  for (const t of s.userTags) addField(t, WEIGHT_USER_TAG);

  const docLen = wtf.size || 1;

  for (const term of terms) {
    const tf = wtf.get(term) ?? 0;
    if (tf === 0) continue;
    // BM25 TF-saturation with document-length normalisation.
    score += (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / avgDocLen)));
  }

  return score;
}

/**
 * Memoisable per-session term statistics: the weighted term-frequency map and
 * the BM25 weighted document length. Computing these once at index time (and
 * reusing them across every query) removes the per-query O(candidates × fields)
 * re-tokenisation that dominated `search()` on large stores.
 */
export interface SessionTermStats {
  /** term → summed field weight (identical to the map `keywordScore` builds). */
  wtf: Map<string, number>;
  /** Weighted document length, identical to `sessionDocLen(s)`. */
  docLenWeighted: number;
}

/**
 * Precompute the term statistics for a session. The field order, weights, and
 * tokenisation are byte-for-byte identical to `sessionDocLen` + `keywordScore`,
 * so scores derived from the cache match the un-memoised path exactly.
 */
export function computeTermStats(s: ScorableSession): SessionTermStats {
  const wtf = new Map<string, number>();
  let docLenWeighted = 0;
  const addField = (text: string, weight: number) => {
    const terms = extractTerms(text);
    docLenWeighted += terms.size * weight;
    for (const tok of terms) wtf.set(tok, (wtf.get(tok) ?? 0) + weight);
  };
  addField(s.summary, WEIGHT_SUMMARY);
  for (const t of s.keyTopics) addField(t, WEIGHT_KEY_TOPIC);
  for (const f of s.keyFiles) addField(f, WEIGHT_KEY_FILE);
  for (const d of s.decisions) addField(d, WEIGHT_DECISION);
  for (const p of s.problemsSolved) addField(p, WEIGHT_PROBLEM);
  for (const t of s.userTags) addField(t, WEIGHT_USER_TAG);
  return { wtf, docLenWeighted: docLenWeighted || 1 };
}

/**
 * BM25 keyword score computed from precomputed `SessionTermStats`. Numerically
 * identical to `keywordScore()` — same TF-saturation, same document-length
 * normalisation, same workspace boost — but skips re-tokenising the session.
 */
export function keywordScoreFromStats(
  stats: SessionTermStats,
  terms: Set<string>,
  workspaceMatch: boolean,
  avgDocLen = 50,
): number {
  let score = workspaceMatch ? WORKSPACE_BOOST : 0;
  const docLen = stats.wtf.size || 1;
  for (const term of terms) {
    const tf = stats.wtf.get(term) ?? 0;
    if (tf === 0) continue;
    score += (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / avgDocLen)));
  }
  return score;
}

// ---------------------------------------------------------------------------
// Rank fusion — the single source of truth for how keyword / recency /
// embedding ranks and the per-session boosts (confidence, reinforcement,
// supersession, match-ratio, decision/problem intent) combine into one score.
//
// Extracted here so ContextStore.search (in-process) and mcpServer.searchSessions
// (out-of-process stdio) share ONE fusion formula. Before this, the two paths
// each carried their own fusion: the MCP path had a stripped RRF with no
// confidence, supersession, reinforcement or match-ratio signals, so external
// clients (Cursor / Cline / Claude Desktop) silently got worse ranking than the
// in-VS-Code @mem participant. Same class of bug as the v1.1.5 dual-scorer.
//
// Kept vscode-free and dependency-free: callers precompute the ranks and the
// plain-number signal inputs, so this module stays importable from a bare Node
// process under stdio.
// ---------------------------------------------------------------------------

/** RRF fusion constant — rank offset `1/(K+rank)`. */
export const FUSION_K = 60;
/** Recency half-life for the exponential decay boost (ms). */
export const FUSION_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;
/** Rank assigned to a session absent from a given rank map. */
export const FUSION_RANK_MISS = FUSION_K * 10;

/**
 * Multipliers applied to the fusion components. Intent weights (from
 * `queryIntent`) and adaptive learned weights are folded into these by the
 * caller so this module needs no knowledge of either.
 */
export interface FusionWeights {
  /** Multiplies the keyword RRF component (intent.keywordWeight × learned.keyword). */
  keyword: number;
  /** Multiplies the recency decay boost (intent.recencyMultiplier × learned.recency). */
  recencyMultiplier: number;
  /** Multiplies the confidence boost (learned.confidence). */
  confidence: number;
  /** Multiplies the reinforcement boost (learned.reinforcement). */
  reinforcement: number;
  /** Multiplies the accept/reject feedback boost (learned.feedback). */
  feedback: number;
  /** Additive boost when the session has decisions (intent.decisionBoost). */
  decisionBoost: number;
  /** Additive boost when the session has problemsSolved (intent.problemBoost). */
  problemBoost: number;
}

/** Neutral weights: no intent reweighting, no learned adaptation, no intent boosts. */
export const NEUTRAL_FUSION_WEIGHTS: FusionWeights = {
  keyword: 1,
  recencyMultiplier: 1,
  confidence: 1,
  reinforcement: 1,
  feedback: 1,
  decisionBoost: 0,
  problemBoost: 0,
};

/** Precomputed per-session inputs to the fusion. All plain numbers/booleans. */
export interface FusionInput {
  id: string;
  /** Session end time (ms) — recency decay + final tie-break. */
  endTime: number;
  /** 0-based rank in the keyword-score ordering. Use FUSION_RANK_MISS if absent. */
  keywordRank: number;
  /** 0-based rank in the recency ordering. Use FUSION_RANK_MISS if absent. */
  recencyRank: number;
  /** 0-based rank in the embedding-similarity ordering, or undefined when embeddings are off. */
  embeddingRank?: number;
  /** True when the session belongs to the active workspace. */
  workspaceMatch: boolean;
  /** Fraction of the (un-expanded) query terms this session matched, 0..1. */
  matchRatio: number;
  /** Effective (decayed) confidence, 0..1. Legacy sessions pass 0.5. */
  confidence: number;
  /** usage.retrieved count. */
  retrieved: number;
  /** usage.accepted count. */
  accepted: number;
  /** usage.rejected count. */
  rejected: number;
  /** Session is superseded by a newer one — down-rank but keep visible. */
  superseded: boolean;
  /** Session has at least one decision. */
  hasDecisions: boolean;
  /** Session has at least one solved problem. */
  hasProblems: boolean;
}

/** Fused score plus the raw per-signal values (for the adaptive learner snapshot). */
export interface FusionScored {
  id: string;
  score: number;
  endTime: number;
  /** Raw (pre-weight) signal values, identical to what search() snapshots. */
  signals: {
    keyword: number;
    recency: number;
    confidence: number;
    reinforcement: number;
    feedback: number;
  };
}

/**
 * Fuse ranks + boosts into a sorted score list (descending, tie-broken by
 * endTime). Numerically identical to the formula ContextStore.search shipped
 * before extraction — same RRF constants, same 0.3 decay weight, same 0.15
 * workspace boost, 0.25 match boost, 0.1 confidence/reinforcement, 0.05
 * feedback, and -0.3 supersession penalty.
 */
export function fuseRanks(
  inputs: FusionInput[],
  weights: FusionWeights,
  opts: { now?: number; maxRetrieved?: number } = {},
): FusionScored[] {
  const now = opts.now ?? Date.now();
  let maxRetrieved = opts.maxRetrieved ?? 1;
  if (opts.maxRetrieved === undefined) {
    for (const i of inputs) if (i.retrieved > maxRetrieved) maxRetrieved = i.retrieved;
  }
  const reinforcementNorm = Math.log(1 + maxRetrieved) || 1;

  const scored = inputs.map((i) => {
    const kRaw = 1 / (FUSION_K + i.keywordRank);
    const rComponent = 1 / (FUSION_K + i.recencyRank);
    let rrf = kRaw * weights.keyword + rComponent;
    if (i.embeddingRank !== undefined) rrf += 1 / (FUSION_K + i.embeddingRank);

    const ageMs = Math.max(0, now - i.endTime);
    const recencyValue = Math.pow(2, -ageMs / FUSION_HALF_LIFE_MS);
    const decay = recencyValue * 0.3 * weights.recencyMultiplier;

    const wsBoost = i.workspaceMatch ? 0.15 : 0;
    const matchBoost = i.matchRatio * 0.25;
    const confBoost = (i.confidence - 0.5) * 0.1 * weights.confidence;
    const decisionBoost = weights.decisionBoost > 0 && i.hasDecisions ? weights.decisionBoost : 0;
    const problemBoost = weights.problemBoost > 0 && i.hasProblems ? weights.problemBoost : 0;
    const supersededPenalty = i.superseded ? -0.3 : 0;

    const reinforcementValue = Math.log(1 + i.retrieved) / reinforcementNorm;
    const reinforcement = reinforcementValue * 0.1 * weights.reinforcement;
    const feedbackValue = i.accepted - i.rejected;
    const feedback = feedbackValue * 0.05 * weights.feedback;

    return {
      id: i.id,
      endTime: i.endTime,
      score:
        rrf +
        decay +
        wsBoost +
        matchBoost +
        confBoost +
        decisionBoost +
        problemBoost +
        supersededPenalty +
        reinforcement +
        feedback,
      signals: {
        keyword: kRaw,
        recency: recencyValue,
        confidence: i.confidence,
        reinforcement: reinforcementValue,
        feedback: feedbackValue,
      },
    };
  });

  scored.sort((a, b) => b.score - a.score || b.endTime - a.endTime);
  return scored;
}
