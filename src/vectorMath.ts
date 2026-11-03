/**
 * Pure vector/embedding math — NO vscode import, ever.
 *
 * This module exists because `embeddings.ts` (which imports `vscode` at module
 * top for the proposed `vscode.lm` API) was transitively pulled into the
 * standalone MCP server bundle, so `node out/mcpServer.js` crashed with
 * "Cannot find module 'vscode'" for every real MCP client. The test suite
 * masked it: e2e tests spawned the tsc-compiled server with a NODE_PATH that
 * resolved the mock vscode. Everything the server (or any pure module) needs
 * lives here; `embeddings.ts` re-exports these for extension-side callers.
 */

export type EmbeddingFn = (text: string) => Promise<number[] | undefined>;

export function cosineSim(a: number[] | undefined, b: number[] | undefined): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Dimensionality of the dependency-free local embedding. Kept small (128) so
 * the persisted vector is far cheaper than a neural embedding (typically
 * 768–1536 dims) while still giving the hybrid ranker a dense signal.
 */
export const LOCAL_EMBED_DIM = 128;

/** FNV-1a 32-bit hash → unsigned int. Stable across processes (no Math.random). */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // 32-bit FNV prime multiply via shifts to stay in safe-integer range.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * Deterministic, dependency-free local embedding using the feature-hashing
 * ("hashing trick") approach: each unigram and adjacent-bigram feature is
 * hashed into a fixed-dimension vector with a signed bucket, then the vector
 * is L2-normalised. This is a *lexical* dense embedding — it captures term
 * overlap and limited word-order signal, not learned semantics — but it lets
 * the hybrid cosine-RRF rank in `ContextStore.search()` run by default,
 * offline, with zero native deps and no network. When a true semantic
 * provider is configured (vscode.lm or the local ONNX provider), it
 * supersedes this.
 */
// LRU memo for localEmbed (review item #13, v1.11.0).
// Hot paths: every addSession persists then re-runs localEmbed during indexing;
// every searchWithEmbedding embeds the query string. A small bounded LRU is
// enough — session-level inputs are stable and queries usually repeat within
// a session. Each entry ≈ 1 KB for the default 128-dim vector + key, so 512
// entries ≈ 0.5 MB peak — bounded enough for VS Code extension host budgets.
const LOCAL_EMBED_CACHE_MAX = 512;
const localEmbedCache = new Map<string, number[]>();

function cacheKey(text: string, dim: number): string {
  // Embedding is content-addressed by exact text + dim. We hash with FNV so a
  // pathological 10 MB text input doesn't blow up the Map key.
  return `${dim} ${fnv1a(text ?? '')}`;
}

export function localEmbed(text: string, dim = LOCAL_EMBED_DIM): number[] {
  const key = cacheKey(text, dim);
  const cached = localEmbedCache.get(key);
  if (cached) {
    // LRU touch: re-insert to bump to most-recent.
    localEmbedCache.delete(key);
    localEmbedCache.set(key, cached);
    return cached;
  }

  const vec = new Array<number>(dim).fill(0);
  const terms = (text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2);

  const addFeature = (feat: string, weight: number) => {
    const h = fnv1a(feat);
    const idx = h % dim;
    const sign = fnv1a(feat + '\u0000sign') & 1 ? 1 : -1;
    vec[idx] += weight * sign;
  };

  for (let i = 0; i < terms.length; i++) {
    addFeature(terms[i], 1);
    if (i + 1 < terms.length) addFeature(terms[i] + '_' + terms[i + 1], 0.5);
  }

  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) {
      // Round to 4 decimals to keep the persisted JSON compact.
      vec[i] = Math.round((vec[i] / norm) * 1e4) / 1e4;
    }
  }

  if (localEmbedCache.size >= LOCAL_EMBED_CACHE_MAX) {
    // Evict the oldest entry (Map preserves insertion order).
    const oldest = localEmbedCache.keys().next().value;
    if (oldest !== undefined) localEmbedCache.delete(oldest);
  }
  localEmbedCache.set(key, vec);
  return vec;
}

/** Test-only: clear the localEmbed cache (used to keep test isolation tight). */
export function _resetLocalEmbedCache(): void {
  localEmbedCache.clear();
}

/**
 * An `EmbeddingFn` backed by `localEmbed`. Always available — used as the
 * default when no neural embedding provider is present, so hybrid dense
 * retrieval works out of the box.
 */
export function makeLocalEmbedder(dim = LOCAL_EMBED_DIM): EmbeddingFn {
  return async (text: string) => localEmbed(text, dim);
}
