# GHCP-MEM — Configuration Reference

All settings live under the `ghcpMem` namespace and can be edited in VS Code Settings (`Ctrl+,` / `Cmd+,`) or directly in `settings.json`.

---

## Core

| Setting | Type | Default | Description |
|---|---|---|---|
| `ghcpMem.enabled` | boolean | `true` | Master switch — disable to pause all capture and injection. |
| `ghcpMem.scope` | `"user"` \| `"workspace"` \| `"repo"` | `"user"` | Retrieval scope. `user` = all sessions; `workspace` = current VS Code workspace only; `repo` = same git origin URL across machines. |
| `ghcpMem.githubCompatibleMode` | boolean | `false` | Mirror GitHub Copilot's agentic-memory contract: forces `retentionDays = 28` and `scope = repo`. Overrides those two settings when enabled. |

---

## Capture

| Setting | Type | Default | Description |
|---|---|---|---|
| `ghcpMem.captureFileEdits` | boolean | `true` | Capture file edit, create, delete, rename, open, and close events. |
| `ghcpMem.captureTerminalCommands` | boolean | `true` | Capture terminal activity (requires VS Code 1.93+ shell integration). |
| `ghcpMem.captureDiagnostics` | boolean | `true` | Capture error/warning diagnostic transitions. |
| `ghcpMem.captureGitOps` | boolean | `true` | Capture git state changes (branch, commit, merge, rebase). |
| `ghcpMem.excludeGlobs` | string[] | `["**/.env*", "**/*.pem", "**/*.key", "**/secrets/**", "**/node_modules/**"]` | Glob patterns whose file events are silently skipped. |

---

## Compression & autosave

| Setting | Type | Default | Description |
|---|---|---|---|
| `ghcpMem.compressionIntervalMinutes` | number (1–1440) | `15` | How often the timer-based compression job runs. |
| `ghcpMem.autosave.enabled` | boolean | `true` | Enable context-pressure autosave (flush when event count or wall clock threshold is hit). |
| `ghcpMem.autosave.eventThreshold` | number (1–10000) | `40` | Trigger autosave once this many events are buffered. |
| `ghcpMem.autosave.minutesThreshold` | number (1–1440) | `20` | Trigger autosave after this many minutes since the last flush (with any pending events). |

---

## Storage & retention

| Setting | Type | Default | Description |
|---|---|---|---|
| `ghcpMem.maxStoredSessions` | number (1–10000) | `50` | Maximum number of compressed sessions to keep. Oldest are evicted first when the cap is reached. |
| `ghcpMem.maxStoreSizeMB` | number (1–1024) | `25` | Soft cap on `~/.ghcp-mem/sessions.json` disk size. Oldest sessions are evicted until under cap (after count and age eviction). |
| `ghcpMem.retentionDays` | number (0–3650) | `90` | Delete sessions older than this many days. Set to `0` to disable age-based eviction. |

---

## Retrieval

| Setting | Type | Default | Description |
|---|---|---|---|
| `ghcpMem.contextRetrievalCount` | number (1–50) | `5` | Number of top-ranked past sessions to inject into startup context and `@mem` responses. |
| `ghcpMem.validateAgainstCodebase` | boolean | `true` | Drop or de-rank memories whose `keyFiles` no longer exist in the current workspace. |
| `ghcpMem.freshnessFloor` | number (0–1) | `0.25` | Minimum freshness score required for a memory to survive validation. Lower = more lenient. `0` = accept all. |

---

## Privacy & security

| Setting | Type | Default | Description |
|---|---|---|---|
| `ghcpMem.redactSecrets` | boolean | `true` | Run dual-pass redaction (24 patterns) on all captured text before storage. Strongly recommended. |
| `ghcpMem.honorPrivateTags` | boolean | `true` | Exclude content wrapped in `<private>...</private>` markers from persistence. |

---

## Notifications & health

| Setting | Type | Default | Description |
|---|---|---|---|
| `ghcpMem.autoInjectStartupContext` | boolean | `true` | On startup and after each compression, write `.github/instructions/session-memory.instructions.md` (Copilot auto-injection), `CLAUDE.md`, and `.cursor/rules` with recent session context. |
| `ghcpMem.startupContextSessionCount` | number | `5` | How many recent sessions (1–20) to include in the auto-injected instructions file. |
| `ghcpMem.healthAlertThreshold` | number (0–100) | `30` | Show a warning notification if the memory health score falls below this value. Set to `0` to disable. |

---

## Recommended configurations

### Minimal / quiet (reduce notifications and captures)

```json
{
  "ghcpMem.compressionIntervalMinutes": 30,
  "ghcpMem.autosave.eventThreshold": 80,
  "ghcpMem.healthAlertThreshold": 0,
  "ghcpMem.captureDiagnostics": false
}
```

### Maximum retention (power user)

```json
{
  "ghcpMem.maxStoredSessions": 500,
  "ghcpMem.maxStoreSizeMB": 100,
  "ghcpMem.retentionDays": 365,
  "ghcpMem.contextRetrievalCount": 10
}
```

### GitHub Copilot cloud parity

```json
{
  "ghcpMem.githubCompatibleMode": true
}
```

Forces 28-day retention and repo-scoped retrieval to match GitHub's hosted Copilot Memory behaviour.

### Repo-scoped team setup

```json
{
  "ghcpMem.scope": "repo",
  "ghcpMem.retentionDays": 60,
  "ghcpMem.maxStoredSessions": 200
}
```

---

[← Back to README](../README.md) · [Uninstall guide](UNINSTALL.md) · [Demo walkthrough](DEMO.md)
