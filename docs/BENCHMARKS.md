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
