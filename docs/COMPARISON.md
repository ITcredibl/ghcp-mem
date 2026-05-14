<div align="center">

# 🔍 GHCP-MEM — Technical Comparison

### How GHCP-MEM compares to other persistent-memory tools for AI coding assistants

[![v1.2.0](https://img.shields.io/badge/version-1.2.0-7c3aed?style=for-the-badge)](../package.json)
[![Scope](https://img.shields.io/badge/scope-VS_Code_+_Copilot-007ACC?style=for-the-badge&logo=visualstudiocode&logoColor=white)](../README.md)

</div>

> [!NOTE]
> **This is a technical comparison, not a popularity contest.** GHCP-MEM is a young, focused project — most of the tools below have larger communities and longer track records. The point of this page is to help you pick the right tool for **your environment and constraints**, not to claim a winner.

---

## 🧭 How to read this

Different tools optimize for different things. Pick the column that matches your situation:

| Your situation | Tool that probably fits best |
|---|---|
| **You have Copilot Pro/Pro+ and want zero-setup repo-scoped memory across the cloud agent, code review, and CLI.** | [**GitHub Copilot Memory**](https://docs.github.com/en/copilot/concepts/agents/copilot-memory) (public preview, cloud-hosted, free with Pro). |
| **You live in Claude Code, want the largest community, and are fine installing Bun + uv + a local HTTP worker.** | [`thedotmack/claude-mem`](https://github.com/thedotmack/claude-mem) (the category leader, 75k★+). |
| **You live in VS Code + GitHub Copilot, work inside an enterprise, can't open ports, and need defensible privacy guarantees.** | **GHCP-MEM** (this project). |
| **You want a cloud-hosted MCP service.** | [contextstream](https://github.com/contextstream/mcp-server) or similar. |
| **You want a transcript-driven memory specifically for Claude Code.** | [`hjertefolger/cortex`](https://github.com/hjertefolger/cortex). |

GHCP-MEM is intentionally narrow: **VS Code + Copilot, zero deps, zero ports, secret-redacted by default.** If you need any of those things, the trade-offs below are worth it. If you don't, one of the larger projects is probably a better fit.

---

## 🗺️ Landscape

| Project | Target tool(s) | Storage | Retrieval | VS Code native? |
|---|---|---|---|---|
| **GHCP-MEM** (this repo) | VS Code + GitHub Copilot Chat | VS Code `globalState` + JSON mirror + inverted index | RRF (keyword + recency + embeddings) | ✅ |
| [GitHub Copilot Memory](https://docs.github.com/en/copilot/concepts/agents/copilot-memory) (preview) | Copilot cloud agent · code review (web) · CLI | GitHub-hosted (cloud, repo-scoped) | LLM-inferred patterns, citation-validated | ❌ (no VS Code surface yet) |
| [`plures/pluresLM-vscode`](https://github.com/plures/pluresLM-vscode) | Copilot Chat (`@memory`) | MCP service + optional SQLite + vector embeddings | Vector + keyword | ✅ |
| [`NiclasOlofsson/remember-mcp-vscode`](https://github.com/NiclasOlofsson/remember-mcp-vscode) | Copilot Chat via MCP | Markdown + YAML frontmatter | Copilot-driven | ✅ (requires Python + pipx) |
| [`SKULLFIRE07/cortex-memory`](https://github.com/SKULLFIRE07/cortex-memory) | Claude Code / Cursor / Cline / passive Copilot | `.cortex/` local dir; 3-layer (working / episodic / semantic) | LLM extraction + CLAUDE.md injection | ✅ (sidebar) |
| [`hjertefolger/cortex`](https://github.com/hjertefolger/cortex) | Claude Code plugin | SQLite + WASM + Nomic embeddings (768-dim) | Hybrid: vector + FTS5 + RRF + recency decay | ❌ (Claude Code only) |
| [`thedotmack/claude-mem`](https://github.com/thedotmack/claude-mem) | Claude Code · Codex · Gemini · Copilot (via hooks) | Bun + SQLite + FTS5 + Chroma + HTTP `:37777` worker | MCP `search` / `timeline` / `get_observations` (3-layer) | ❌ (web viewer on `:37777`) |
| [contextstream](https://github.com/contextstream/mcp-server) | MCP clients (Cursor / Claude / Windsurf) | Cloud-based | MCP | ❌ |

---

## 🆚 GHCP-MEM ↔ GitHub Copilot Memory (the closest cousin)

GitHub announced [Copilot Memory](https://docs.github.com/en/copilot/concepts/agents/copilot-memory) as a public preview in 2026 — it's the only other "memory layer for Copilot" with first-party backing. Both projects aim at the same goal but make opposite bets on **where memory lives**. GHCP-MEM v1.2.0 ships a `githubCompatibleMode` setting that mirrors Copilot Memory's contract (28-day retention + repo-scoped retrieval) for users who want the same semantics offline.

| Dimension | **GHCP-MEM v1.2.0** | **GitHub Copilot Memory** (public preview) |
|---|---|---|
| **Storage location** | 100% local: VS Code `globalState` + atomic mirror to `~/.ghcp-mem/sessions.json` (mode `0600`) | GitHub cloud, repo-scoped |
| **Where it works** | VS Code (`@mem` chat, agent tools, status bar, sidebar, MCP for Cursor / Cline / Windsurf / Claude Desktop) | Copilot cloud agent · Copilot code review (web) · Copilot CLI |
| **Retention** | 90 days default, configurable (or **28 days when `githubCompatibleMode: true`**) | 28 days, fixed; successful re-use refreshes |
| **Scope** | Configurable: `user` / `workspace` / `repo` (auto-detected from `.git/config`) | Repo only |
| **Trigger** | Active capture: every edit, diagnostic, git op, debug, task, terminal command (debounced, glob-filtered) | Passive inference from PRs / agent sessions / code review actions |
| **Validation against current code** | ✅ `validateAgainstCodebase` setting drops sessions whose `keyFiles` no longer exist (cached 60s) | ✅ Citations validated against current code before reuse |
| **Privacy boundary** | Never leaves the laptop; 24-rule dual-pass redactor; `<private>` tag stripping; `.gitignore` auto-guarded | Stays in originating repo on GitHub's infra; standard GitHub data terms |
| **User control** | All settings exposed in `settings.json`; export/import JSON; delete per session | Pro/Pro+ default on (toggle in personal settings); Enterprise default off (org toggle); repo owners can review + delete memories |
| **Air-gap / offline / locked-down enterprise machines** | ✅ Works — no network, no subprocess, no native binaries | ❌ Cloud-hosted; needs network reachability to github.com |
| **Cross-machine sync** | Manual via `.ghcpmem-pack.json` exports | Automatic (cloud) within repo permissions |
| **Eligibility / availability** | MIT, free, no tier gate | Pro / Pro+ / Enterprise (preview, may change) |
| **MCP-compatible (Cursor, Cline, Windsurf, Claude Desktop)** | ✅ bundled stdio JSON-RPC server | ❌ |
| **Azure-shop awareness** | ✅ 12-subsystem classifier, live `az` snapshot, 8 Azure-specific redaction rules | ❌ |
| **Eval / regression harness** | ✅ `recall@k + MRR`, baseline-gated via `npm run eval:check` | n/a (cloud-side) |

### When to pick which

- **Use GitHub Copilot Memory if** you're a Pro user, your code lives on github.com, you mostly work through cloud agents / PR review / the CLI, and you want zero local setup. Memory is shared across everyone on the repo automatically.
- **Use GHCP-MEM if** you ship from VS Code, you work inside an enterprise / on a locked-down laptop / in an air-gapped environment, you need explicit secret redaction, your codebase is on Azure (not just GitHub), or you want to query memory from non-Copilot AI clients via MCP.
- **Use both if** you want — they target different surfaces and don't conflict. Enable `ghcpMem.githubCompatibleMode` and the local store mirrors Copilot Memory's 28-day repo-scoped semantics, so users moving between cloud agent and IDE see consistent behaviour.

---

## 📊 Feature Matrix

> Legend: ✅ built-in · 🟡 partial / opt-in · ❌ missing

<details open>
<summary><b>🔬 Full feature comparison</b></summary>

| Dimension | **GHCP-MEM v1.2.0** | PluresLM | Remember-MCP | Cortex-Memory | Cortex (Claude) | claude-mem v13.x |
|---|---|---|---|---|---|---|
| No external service / port | ✅ | ❌ (service by default) | ❌ (needs pipx + Python server) | ✅ | ✅ | ❌ (`:37777` worker) |
| No native deps | ✅ | 🟡 (better-sqlite3 in legacy) | ❌ | ✅ | ❌ (sql-wasm, Nomic) | ❌ (SQLite, Chroma, Bun) |
| Auto-capture signals | ✅ (edits, diagnostics, git, debug, tasks, terminal) | 🟡 (file save only) | ❌ (user-driven) | ✅ (chat transcript) | ✅ (transcript hooks) | ✅ |
| Auto secret/PII redaction | ✅ (13 generic + 8 Azure, dual-pass + redact-on-import) | ❌ | ❌ | ❌ | ❌ | 🟡 (`<private>` tags only) |
| Glob-based file exclusion | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Observation typing | ✅ (12 types, rule + LM) | ❌ | 🟡 (manual scopes) | ✅ (decision / bug / arch) | ❌ | 🟡 (by tag) |
| Progressive disclosure | ✅ (`/search` → `/timeline` → `/detail`) | 🟡 (`/recall`) | ❌ | 🟡 | ❌ | ✅ |
| Inline query filters | ✅ (`type:X since:7d tag:Y workspaceId:Z`) | ❌ | ❌ | ❌ | ❌ | ❌ |
| Vector embeddings | 🟡 (feature-detected `vscode.lm.computeEmbeddings`) | ✅ | ❌ | 🟡 | ✅ (768d Nomic) | ✅ (Chroma) |
| Hybrid ranking (vec + FTS + recency) | ✅ (RRF K=60 + 7-day decay + workspace boost) | 🟡 | ❌ | ❌ | ✅ | 🟡 |
| Auto-inject prior context | ✅ (`.github/instructions/*.md`, auto-gitignored) | 🟡 | ✅ (frontmatter MD) | ✅ (CLAUDE.md) | ✅ | ✅ |
| Sidebar tree view | ✅ | ✅ | ✅ | ✅ | ❌ (statusline) | ❌ (external web viewer) |
| Status bar counter | ✅ (`MEM ●●●○○ 73`) | ✅ | ✅ | ✅ | ✅ | ❌ |
| Export / import | ✅ (JSON, redacted on import) | ✅ (bundles + named packs) | 🟡 (MD files) | ✅ (single-MD export) | 🟡 (raw sqlite) | 🟡 |
| Team-shareable packs | ✅ (`.ghcpmem-pack.json`, schema-versioned, redacted on import) | ✅ (`.memorypack.json`) | ✅ (workspace scope) | 🟡 (commit `.cortex/`) | ❌ | ❌ |
| Age-based retention | ✅ | ❌ | n/a | ❌ | ❌ | 🟡 (count only) |
| Per-session delete / tag | ✅ | ✅ (`/forget`) | ✅ (edit MD) | ✅ | ✅ | ❌ |
| Content-hash dedup | ✅ (SHA-256) | 🟡 | ❌ | ❌ | ✅ | 🟡 |
| Backups / recovery | ✅ (rolling 5, restore command) | 🟡 | n/a | ❌ | ✅ | ❌ |
| Context-pressure autosave | ✅ (event count + wall-clock) | ❌ | ❌ | 🟡 | ✅ | ✅ |
| Multi-AI interop (MCP) | ✅ (stdio MCP, 4 tools, workspace-scoped, JSON-RPC 2.0) | 🟡 (LM tool) | ✅ (MCP) | ✅ (MCP + CLAUDE.md) | ❌ | ✅ (3-layer MCP) |
| Azure-aware capture | ✅ (12-subsystem classifier + `az` snapshot) | ❌ | ❌ | ❌ | ❌ | ❌ |
| Health score alerting | ✅ (0–100, configurable threshold notification) | ❌ | ❌ | ❌ | ❌ | ❌ |
| Auto-gitignore injected files | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Async non-blocking index rebuild | ✅ (chunked `setImmediate`) | ❌ | n/a | ❌ | ❌ | n/a |
| Formal test suite | ✅ (132 `node:test` cases + eval gate + bench + smoke + CI matrix ubuntu×windows) | ✅ (vitest) | 🟡 | 🟡 | ✅ (231 tests) | ❌ |

</details>

---

## 🎯 Where GHCP-MEM is the right tool

These are the situations where GHCP-MEM is genuinely the best fit — not because it's "better," but because nothing else in the category was designed for them:

1. **Locked-down enterprise developer machines.** No admin rights, no Bun, no Python, no `:37777`. GHCP-MEM is a single `.vsix` file with zero runtime dependencies.
2. **Privacy-sensitive codebases.** 21 redaction rules with dual-pass scrubbing (input + output of the LM), `<private>...</private>` tag stripping, glob-based exclusion of `.env*` / `*.pem` / `secrets/**` by default. Most competitors persist whatever they see.
3. **Azure-shop workflows.** 12-subsystem classifier auto-tags `bicep` / `azd` / `aks` / `keyvault` / `functions` / `openai` / etc. Live `az` snapshot. 8 Azure-specific redaction rules. Unique in the category.
4. **VS Code + Copilot users who want native integration.** `@mem` chat participant, `#ghcpMemSearch` / `#ghcpMemStore` agent-mode tools, auto-injection via `.github/instructions/*.md` — all using Copilot's native protocols, not shell-level hooks.
5. **Air-gapped or audit-heavy environments.** No outbound network, no auto-update, no telemetry, no subprocess, no HTTP server, no native binaries. Smallest possible attack surface.

## 🎯 Where another tool is the right choice

Equally important to acknowledge:

- **If you primarily use Claude Code** and want the most battle-tested option with the largest community, [`thedotmack/claude-mem`](https://github.com/thedotmack/claude-mem) is the obvious pick. It has 75k★+, 270+ releases, and active development.
- **If you want a cloud-hosted memory service**, GHCP-MEM intentionally won't do that — pick a hosted MCP server.
- **If you need cross-editor support across many AI tools**, claude-mem's hook system covers more clients than GHCP-MEM's VS Code-only surface.

---

## 🔬 Design trade-offs

GHCP-MEM made specific bets that not every user will agree with:

| Bet | Trade-off |
|---|---|
| **Zero runtime deps.** | Means no embedded vector DB, no FTS5 — retrieval relies on inverted index + RRF + the `vscode.lm` embeddings API when available. Performance is fine for tens of thousands of sessions but won't match Chroma at multi-million scale. |
| **VS Code-only.** | Means no Claude Code / Codex / Gemini support out of the box. The bundled MCP server lets other clients query the store, but capture is VS Code-only. |
| **No background worker.** | Means everything runs inside the extension host. If VS Code is closed, capture stops. (This is intentional — no daemon means no port, no auto-start, no IT-blocker.) |
| **MIT license.** | Permissive but offers no patent grant. Apache-2.0 (which claude-mem uses) is stricter on that front. |
| **Per-user storage.** | No team-wide cloud sync. Use `.ghcpmem-pack.json` exports for team sharing. |

---

## ✅ Roadmap (v1.0 → v1.x)

Every gap from the original v0.x analysis was closed before v1.0. Remaining items are research-level:

- 🟡 **Chat transcript capture** — depends on Copilot Chat APIs exposing user turns.
- 🟡 **Quick-filter bar on the sessions tree view.**
- 🔬 **Intent-aware compression** — feed `@mem` the user's current prompt; rewrite the summary to emphasise relevant info (query-focused summarization).
- 🔬 **Cross-workspace knowledge graph** — extract `{entity, relation, entity}` triples from summaries.
- 🔬 **Evaluation harness** — record a real session, replay synthetic queries, measure recall@k vs keyword baseline.

---

<div align="center">

[← Back to README](../README.md) · [Live demo](DEMO.md) · [Report an issue](https://github.com/ITcredibl/ghcp-mem/issues)

<sub>**Comparison for GHCP-MEM v1.2.0** · last refreshed May 2026</sub>

</div>


