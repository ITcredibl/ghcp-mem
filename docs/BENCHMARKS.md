# GHCP-MEM Benchmarks

## Measured areas

- Retrieval accuracy
- Recall@5
- MRR
- Stale-memory rejection rate
- Redaction accuracy
- Token reduction (measured)
- Search latency
- Activation time
- Extension host memory usage

## Benchmark posture

Results should come from a fixed sample repository set and repeatable tasks. Claims should be reported as measured values or clearly labeled estimates.

See the current sample results in [BENCHMARK_REPORT.md](./BENCHMARK_REPORT.md).

## Token-savings counter

- Per-session savings = raw tokens captured for the session minus compact tokens stored in the summary.
- Overall savings = sum of all per-session savings across the selected session set.
- The shared counter measures with the active Copilot model's tokenizer when a chat model is available, and falls back to a 4-chars-per-token heuristic (plus a fixed capture overhead) offline. The same counter backs chat output, stats, and benchmarks, so all three stay aligned.

---

## Embedding-model comparison (v1.24.0, SEM-001)

Three locally deployable 384-dim models were measured on the 200-query
DEVELOPMENT set over eval-corpus-v2 (tune-semantic.mjs distributions and, for
candidates that justified it, the full-pipeline sweep). Predefined selection
criteria: (1) relevant/negative similarity separation — specifically recall
available at the lowest floor that serves ZERO labeled dev negatives, (2) pack
size and latency on the shared WASM runtime, (3) permissive license. Selection
used the dev set only; the winner was then validated once on the frozen set.

| Model (quantized ONNX) | Pooling / prefix | Per-embed (M2 Pro, WASM) | Pack size | Relevant p50 | Hardest negative | Dev recall@5 at zero-FP floor | License |
|---|---|---:|---:|---:|---:|---:|---|
| all-MiniLM-L6-v2 (v1.23.0 default) | mean / none | ~21 ms | ~35 MB | 0.429 | 0.48 | 0.688 (floor 0.5) | Apache-2.0 |
| **bge-small-en-v1.5 (selected)** | CLS / query prefix | ~22 ms | ~46 MB | 0.706 | 0.661 | **0.839** (floor 0.665) | MIT |
| gte-small | mean / none | ~31 ms | ~46 MB | 0.862 | 0.843 | rejected at distribution stage | MIT |

gte-small was rejected before pipeline sweeping: its cosine range compresses at
the top so severely that the hardest dev negative (0.843) sits ABOVE the
25th-percentile relevant pair (0.836) — no zero-false-positive floor retains
even half the relevant pairs. bge-small-en-v1.5's frozen-set validation
(measured once, thresholds untouched): recall@5 0.853 [95% CI 0.790–0.913],
paraphrase 64%, false positives 4.2% (1/24). All three models are
English-primary; multilingual retrieval is not claimed. MiniLM remains a
supported provider pack for existing installs.

Reproduce: `node scripts/setup-semantic.mjs --provider <key>` then
`node scripts/tune-semantic.mjs scripts/eval-corpus-v2.json scripts/eval-dev.json`.
