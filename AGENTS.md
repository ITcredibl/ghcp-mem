# AGENTS.md — GHCP-MEM

VS Code extension that gives Copilot a **local-first, auditable session-memory layer**. Also ships a stand-alone MCP stdio server (`ghcp-mem-mcp`) and a CI seeder (`ghcp-mem-ci-seed`).

For full dev setup, CI gates, and PR process, read [CONTRIBUTING.md](CONTRIBUTING.md) first. This file only captures what an AI agent needs beyond that.

## Build / test / run

```bash
npm install            # no native deps — must succeed on any OS without build tools
npm run watch          # incremental TS build to out/
npm test               # Node built-in test runner via scripts/run-tests.mjs (600+ tests)
npm run lint           # ESLint
npm run typecheck      # type-check only
npm run bundle:prod    # esbuild production bundle (CI gate)
npm run verify         # full local gate chain (format, lint, types, tests, release consistency, eval, bench, bundle)
```

Press `F5` in VS Code to launch the Extension Development Host.

Run a subset of tests: `npm test -- --test-name-pattern="<pattern>"` (flags after `--` are forwarded to `node --test`).

## Architecture map

Entry points and module ownership are listed in [CONTRIBUTING.md §2](CONTRIBUTING.md#2-project-structure). Key boundaries:

- [src/extension.ts](src/extension.ts) — activation, command registration, walkthroughs. Keep activation cheap (`onStartupFinished`).
- [src/contextProvider.ts](src/contextProvider.ts) — `@mem` chat participant + all slash commands (`/search`, `/entity`, `/why`, `/lineage`, `/route`, `/compliance`, …).
- [src/contextStore.ts](src/contextStore.ts) — persistent storage, indexing, eviction, backups. All writes go through here.
- [src/contextCompressor.ts](src/contextCompressor.ts) — LM compression with a fully local extractive fallback. **Evidence-citation gate**: a decision cannot be emitted without pointing at the captured event that produced it. Do not weaken this.
- [src/searchCore.ts](src/searchCore.ts) — BM25 + RRF + recency. Guarded by a recall/MRR/nDCG regression gate in CI (`scripts/eval-check.js`) — every production retrieval configuration must have a floor committed in `scripts/eval-baseline.json`.
- [src/lessons.ts](src/lessons.ts) — pure consolidation of episodic sessions into durable semantic/procedural lessons. Deterministic IDs, support/confidence reinforcement, pinned lessons immune to pruning. Consumed by the janitor (consolidation pass) and `contextProvider` (startup injection).
- [src/redactor.ts](src/redactor.ts) — 30-rule secret/PII redaction. **Every new capture path must pipe through this before persistence.**
- [src/storageCrypto.ts](src/storageCrypto.ts) — AES-256-GCM envelope encryption for the store (`ghcpMem.storageEncryption`). Fail-closed: a wrong key runs read-less and write-suspended.
- [src/mcpServer.ts](src/mcpServer.ts) — stdio MCP server (14 tools). Schema is asserted in tests (`mcpServerSchema.test.ts`); update both when changing the tool surface.
- `out/` and `out-test/` are gitignored build output — never edit compiled JS there.

## Project-specific rules (these differ from common practice)

- **No native dependencies.** `npm install` must not compile anything. Reject deps with `node-gyp`, prebuilt binaries, or postinstall scripts.
- **No open ports, no daemon.** Communication is VS Code IPC or stdio only. Do not add HTTP servers, sockets, or background processes.
- **Redact first.** Anything captured from terminal, chat, editor, or git must pass through `redactor.ts` before it reaches `contextStore`.
- **Never capture the extension's own output.** Generated memory files (`GENERATED_MEMORY_FILES` in [src/types.ts](src/types.ts)) are unconditionally excluded from capture — keep that list in sync with `SENSITIVE_SCAN_TARGETS` in [src/integrityChecker.ts](src/integrityChecker.ts).
- **TypeScript strict.** No `any`, no `!` non-null assertions without justification.
- **Tests are required for new modules.** Mocks for the VS Code API live in `src/test/__mocks__/vscode.ts` — tests must not require a running VS Code instance.
- **Conventional commits** (`feat:`, `fix:`, `docs:`, `chore:`, `test:`).
- **Comments only when WHY is non-obvious.** Do not add docstrings/comments to code you didn't change.

## CI gates that block merge

Listed in [CONTRIBUTING.md §4](CONTRIBUTING.md#4-ci-gates). Summary: format, lint, tests, `scripts/check-release-consistency.mjs` (version + doc-claim drift), `scripts/eval-check.js` (retrieval recall@5 / MRR / nDCG@5 floors, missing baseline fails), `scripts/bench-search.js` (search p99 < 50ms), `npm run bundle:prod`, `vsce package` clean.

## Pitfalls

- Editing `out/` or `out-test/` instead of `src/` — those are build output.
- Windows-only path bugs: this extension targets all OSes; use `path.join`, never hard-code separators.
- The `CLAUDE.md` / `.github/instructions/session-memory.instructions.md` `<!-- GHCP-MEM:START -->` block is auto-injected by the extension itself — do not hand-edit that region.
- Bumping `version` in [package.json](package.json) without running `node scripts/check-release-consistency.mjs` will fail CI — README/DEMO test-count claims are also checked against each other.
