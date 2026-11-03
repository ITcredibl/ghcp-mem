/**
 * Co-occurrence-based query expansion.
 *
 * Given the user's original query terms and the corpus of stored sessions,
 * walk the inverted index to find terms that frequently co-occur with the
 * query terms but are NOT already in the query. Return the top-N as
 * suggested expansions.
 *
 * Example: query `"postgres"` over a corpus where every `postgres` session
 * also mentions `pool` and `connection` will yield expansions
 * `["pool", "connection"]`. Adding those at retrieval time recovers
 * matches that pure BM25 would miss when the user phrases their query
 * differently from how they originally captured the work.
 *
 * Cheap: works from the inverted index already maintained by ContextStore.
 * No LM calls, no network, deterministic given the corpus.
 */

/**
 * Map of term → set of session IDs that contain that term. Caller is
 * expected to pass the same `index` shape ContextStore uses internally.
 */
export type InvertedIndex = Map<string, Set<string>>;

export interface ExpandQueryOptions {
  /** How many additional terms to return. Default: 3. */
  maxExpansions?: number;
  /**
   * Minimum number of original-query sessions a candidate expansion must
   * appear in. Prevents one-off coincidental co-occurrences from leaking
   * into the expanded query. Default: 2 (or 1 when only one session matches).
   */
  minCoOccurrence?: number;
  /**
   * Cap on the total number of sessions an expansion candidate may appear
   * in across the entire corpus. Filters out generic stopword-ish terms
   * that show up everywhere (e.g. "session", "file", "code"). Expressed
   * as a fraction of total session count. Default: 0.5.
   */
  maxGlobalFrequency?: number;
  /**
   * Terms of one session by id (ContextStore passes its term-stats map).
   * With this, co-occurrence is tallied by iterating the SEED SESSIONS' OWN
   * terms — O(seeds × termsPerSession) — instead of walking the whole
   * vocabulary and probing every seed per term, which is
   * O(uniqueTerms × seeds): ~10⁹ Set lookups per query at a 50k-session
   * corpus (≈16 s/query, found by the PERF-001 scale benchmark). The two
   * tallies are equivalent — a term can only co-occur if it appears in a
   * seed session.
   */
  sessionTerms?: (id: string) => Iterable<string> | undefined;
}

/** Seeds beyond this are sampled (deterministically) for the tally. */
const SEED_CAP = 512;
/** Without `sessionTerms`, skip expansion when the legacy walk would blow up. */
const LEGACY_WALK_BUDGET = 2_000_000;

export function expandQuery(
  terms: Set<string>,
  index: InvertedIndex,
  totalSessions: number,
  opts: ExpandQueryOptions = {},
): string[] {
  const maxExpansions = opts.maxExpansions ?? 3;
  const requestedMin = opts.minCoOccurrence ?? 2;
  const maxGlobalFrequency = opts.maxGlobalFrequency ?? 0.5;
  if (terms.size === 0 || index.size === 0 || totalSessions === 0) return [];

  // Find the universe of session IDs that hit at least one query term.
  const seedSessionIds = new Set<string>();
  for (const t of terms) {
    const hits = index.get(t);
    if (hits) for (const id of hits) seedSessionIds.add(id);
  }
  if (seedSessionIds.size === 0) return [];

  // If only one seed session matched, we can't compute a co-occurrence
  // threshold meaningfully — soften the minimum to 1.
  const minCoOccurrence = seedSessionIds.size === 1 ? 1 : requestedMin;

  // Deterministic seed sampling: very broad queries can hit tens of
  // thousands of sessions; 512 seeds are plenty to find stable co-occurring
  // vocabulary and keep the tally O(seeds × termsPerSession).
  let seeds: string[] = [...seedSessionIds];
  if (seeds.length > SEED_CAP) seeds = seeds.sort().slice(0, SEED_CAP);

  const scored: Array<{ term: string; coOccur: number; globalFreq: number }> = [];
  if (opts.sessionTerms) {
    // Fast path: tally terms FROM the seed sessions themselves.
    const tally = new Map<string, number>();
    for (const id of seeds) {
      const ts = opts.sessionTerms(id);
      if (!ts) continue;
      for (const term of ts) {
        if (terms.has(term)) continue;
        tally.set(term, (tally.get(term) ?? 0) + 1);
      }
    }
    for (const [term, coOccur] of tally) {
      if (coOccur < minCoOccurrence) continue;
      const globalFreq = index.get(term)?.size ?? 0;
      if (globalFreq / totalSessions > maxGlobalFrequency) continue; // too generic
      scored.push({ term, coOccur, globalFreq });
    }
  } else {
    // Legacy full-vocabulary walk — only affordable on small corpora; on a
    // large one with no sessionTerms accessor, expansion is skipped rather
    // than allowed to dominate query latency.
    if (index.size * seeds.length > LEGACY_WALK_BUDGET) return [];
    for (const [term, hits] of index) {
      if (terms.has(term)) continue; // skip terms already in the query
      if (hits.size / totalSessions > maxGlobalFrequency) continue; // too generic
      let coOccur = 0;
      for (const id of seeds) if (hits.has(id)) coOccur++;
      if (coOccur < minCoOccurrence) continue;
      scored.push({ term, coOccur, globalFreq: hits.size });
    }
  }

  // Sort by co-occurrence desc, then by lower globalFreq (rarer = more
  // discriminative). Stable tie-break by term name for determinism.
  scored.sort(
    (a, b) => b.coOccur - a.coOccur || a.globalFreq - b.globalFreq || a.term.localeCompare(b.term),
  );
  return scored.slice(0, maxExpansions).map((s) => s.term);
}
