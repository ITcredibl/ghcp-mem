# Real-World Benchmarks

> Corpora mined from **real git histories** with the shipped `gitHistorySeeder` (v1.14) —
> real commit language, real file paths, real topic overlap. Reproduce with:
> `npm run bench:real -- --full --write-doc` (shallow-clones the public repos, ~few MB each).

_Generated 2026-07-08 · GHCP-MEM v1.14.0 · Node v25.9.0_

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
| ghcp-mem (self) | 26 | 26 (0) | 85% / 85% | 0.79 / 0.83 | 0.80 / 0.83 | 0 | 0/5 | 0.1ms / 2.8ms / 33.7ms |
| express | 150 | 40 (8) | 98% / 98% | 0.75 / 0.77 | 0.81 / 0.82 | 0 | 0/5 | 0.4ms / 3.4ms / 38.2ms |
| flask | 150 | 40 (8) | 98% / 98% | 0.90 / 0.90 | 0.92 / 0.92 | 0 | 0/5 | 0.4ms / 3.3ms / 38.4ms |
| terraform | 150 | 40 (3) | 75% / 75% | 0.69 / 0.70 | 0.70 / 0.71 | 0 | 0/5 | 0.3ms / 2.6ms / 30.3ms |
| react | 150 | 40 (0) | 93% / 93% | 0.91 / 0.91 | 0.91 / 0.91 | 0 | 0/5 | 0.2ms / 1.8ms / 18.1ms |

## Reading the numbers

- **Canary leaks must be 0** on every row — a non-zero value is a release blocker, not a benchmark result.
- **Stale surfaced must be 0/5** — retracted memory must never reach retrieval.
- Recall/MRR on real corpora runs lower than synthetic benches by construction: real commit vocabulary collides ("fix build", "update deps") in ways invented topic words never do. That is the point of this harness.
- The hybrid column shows the shipped default; the keyword column is the ablation baseline.
