# Real-World Benchmarks

> Corpora mined from **real git histories** with the shipped `gitHistorySeeder` (v1.14) —
> real commit language, real file paths, real topic overlap. Reproduce with:
> `npm run bench:real -- --full --write-doc` (shallow-clones the public repos, ~few MB each).

_Generated 2026-09-11 · GHCP-MEM v1.17.1 · Node v25.2.1_

## Methodology

- **Corpus**: last 400 commits per repo → sessions via the shipped seeder (day×author grouping, redaction on).
- **Gold queries**: the 3 rarest informative tokens of each sampled session summary — a proxy for how a developer actually searches. Single relevant id per query (strict).
- **Redaction canaries**: 4 synthetic commits carrying real secret shapes (AWS key, GitHub PAT, Azure connection string, high-entropy blob) injected into the stream; the serialized store is scanned for raw values.
- **Stale rejection**: 5 sessions marked retracted; their own gold queries re-run; any retracted id in the top-20 is a failure.
- **Latency**: 200 `store.search()` calls (the extension's hot path) at natural corpus size, then padded with real-vocabulary clones to 1,000 and 10,000 rows.
- **Ambiguity exclusion**: sessions whose headline duplicates another session ("update dev dependencies" × N) or whose rarest token is corpus-common are excluded from gold — a self-query against duplicate content has no determinate answer, so scoring it would mislabel correct retrievals as misses. Exclusion counts are reported per repo.
- **Honest caveats**: gold queries derive from the target document (standard self-query methodology — same as our synthetic bench, but over real vocabulary with real collisions). No competitor numbers yet: running OpenMemory/Continue through an identical harness is planned; see repo issues.

## Results

| Repo | Sessions | Gold (excl. ambiguous) | Recall@5 (kw / hybrid) | MRR (kw / hybrid) | nDCG@5 (kw / hybrid) | Canary leaks | Stale surfaced | p95 @natural / @1k / @10k |
|---|---|---|---|---|---|---|---|---|
| ghcp-mem (self) | 29 | 29 (0) | 97% / 100% | 0.88 / 0.90 | 0.90 / 0.92 | 0 | 0/5 | 0.3ms / 6.6ms / 55.5ms |
| express | 150 | 40 (7) | 98% / 98% | 0.75 / 0.75 | 0.81 / 0.81 | 0 | 0/5 | 0.4ms / 4.0ms / 47.2ms |
| flask | 150 | 40 (9) | 95% / 95% | 0.81 / 0.82 | 0.85 / 0.85 | 0 | 0/5 | 0.9ms / 5.8ms / 52.2ms |
| terraform | 150 | 40 (2) | 73% / 73% | 0.66 / 0.66 | 0.68 / 0.68 | 0 | 0/5 | 1.4ms / 6.5ms / 74.7ms |
| react | 150 | 40 (0) | 95% / 95% | 0.86 / 0.91 | 0.89 / 0.92 | 0 | 0/5 | 0.6ms / 5.4ms / 45.9ms |

## Reading the numbers

- **Canary leaks must be 0** on every row — a non-zero value is a release blocker, not a benchmark result.
- **Stale surfaced must be 0/5** — retracted memory must never reach retrieval.
- Recall/MRR on real corpora runs lower than synthetic benches by construction: real commit vocabulary collides ("fix build", "update deps") in ways invented topic words never do. That is the point of this harness.
- The hybrid column shows the shipped default; the keyword column is the ablation baseline.

## Retrieval-stage ablation

Each signal turned on one at a time, always through the shipped code paths
(`searchCore` exports + the real `ContextStore` methods). `+ rerank` uses a
lexical-overlap proxy for the LM reranker so the row is reproducible offline —
it is a lower bound on, not a substitute for, a real cross-encoder.

### ghcp-mem (self)

| Stage | Recall@5 | MRR | nDCG@5 |
|---|---|---|---|
| recency-only | 17% | 0.12 | 0.10 |
| bm25-only | 100% | 1.00 | 1.00 |
| keyword+recency (RRF) | 100% | 0.90 | 0.92 |
| + embeddings (hybrid) | 100% | 0.90 | 0.92 |
| + rerank (lexical proxy) | 100% | 1.00 | 1.00 |

### express

| Stage | Recall@5 | MRR | nDCG@5 |
|---|---|---|---|
| recency-only | 13% | 0.08 | 0.07 |
| bm25-only | 100% | 0.99 | 0.99 |
| keyword+recency (RRF) | 98% | 0.76 | 0.82 |
| + embeddings (hybrid) | 98% | 0.80 | 0.85 |
| + rerank (lexical proxy) | 98% | 0.98 | 0.98 |

### flask

| Stage | Recall@5 | MRR | nDCG@5 |
|---|---|---|---|
| recency-only | 10% | 0.05 | 0.05 |
| bm25-only | 100% | 0.96 | 0.97 |
| keyword+recency (RRF) | 95% | 0.82 | 0.85 |
| + embeddings (hybrid) | 95% | 0.83 | 0.86 |
| + rerank (lexical proxy) | 95% | 0.86 | 0.89 |

### terraform

| Stage | Recall@5 | MRR | nDCG@5 |
|---|---|---|---|
| recency-only | 13% | 0.08 | 0.07 |
| bm25-only | 100% | 1.00 | 1.00 |
| keyword+recency (RRF) | 73% | 0.66 | 0.68 |
| + embeddings (hybrid) | 73% | 0.66 | 0.68 |
| + rerank (lexical proxy) | 73% | 0.73 | 0.73 |

### react

| Stage | Recall@5 | MRR | nDCG@5 |
|---|---|---|---|
| recency-only | 13% | 0.09 | 0.07 |
| bm25-only | 100% | 1.00 | 1.00 |
| keyword+recency (RRF) | 95% | 0.93 | 0.93 |
| + embeddings (hybrid) | 95% | 0.94 | 0.94 |
| + rerank (lexical proxy) | 95% | 0.95 | 0.95 |
