# GHCP-MEM Benchmark Report

**Run date:** 2026-09-11  
**Build:** `ghcp-mem@1.17.1`

## Repro steps

```bash
npm run eval:check
npm run bench
```

## Results

| Check | Result |
|---|---:|
| Retrieval eval (`keyword-only`) | Recall@5 `1.000` · MRR `1.000` · nDCG@5 `1.000` |
| Search benchmark p50 | `13887 µs` |
| Search benchmark p95 | `19019 µs` |
| Search benchmark p99 | `26966 µs` |
| Search benchmark max | `64197 µs` |

## What is proven here

- Retrieval rankers hit the expected floor on the synthetic corpus.
- Search stays within the sub-50ms CI ceiling on a 1000-session in-memory store.
- Token savings are countable per session and in aggregate via the shared counter used by chat, stats, and tests — measured with the model tokenizer when available, heuristic otherwise.

## Token-savings model

- **Per session:** raw tokens minus compact tokens.
- **Overall:** sum of all per-session savings.
- **Counting:** measured with the active Copilot model's tokenizer when a chat model is available; falls back to a 4-characters-per-token heuristic offline, with a fixed capture overhead per session.

