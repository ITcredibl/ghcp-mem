# Tuning GHCP-MEM

All settings live under **GHCP-MEM** in VS Code Settings.

## Retention & disk budget

| Setting                       | Default | What it controls                                          |
| ----------------------------- | ------- | --------------------------------------------------------- |
| `ghcpMem.retentionDays`       | 90      | Age-based eviction                                        |
| `ghcpMem.maxStoredSessions`   | 50      | Count-based eviction                                      |
| `ghcpMem.maxStoreSizeMB`      | 25      | Soft byte cap on `~/.ghcp-mem/sessions.json`              |

All three apply in order: age → count → size. The most conservative bound wins.

## Retrieval scope

| Setting                             | Default       | What it controls                                                     |
| ----------------------------------- | ------------- | -------------------------------------------------------------------- |
| `ghcpMem.scope`                     | `"user"`      | `user` = all sessions · `workspace` = current VS Code workspace only · `repo` = same git origin across machines |
| `ghcpMem.contextRetrievalCount`     | 5             | Number of past sessions injected into each search result             |
| `ghcpMem.validateAgainstCodebase`   | true          | Drop sessions whose key files no longer exist in the workspace       |
| `ghcpMem.freshnessFloor`            | 0.25          | Minimum fraction of key files that must still exist (0–1)            |

## Capture controls

| Setting                             | Default | What it controls                          |
| ----------------------------------- | ------- | ----------------------------------------- |
| `ghcpMem.captureFileEdits`          | true    | Record file edit events                   |
| `ghcpMem.captureTerminalCommands`   | true    | Record terminal commands (requires shell integration) |
| `ghcpMem.captureDiagnostics`        | true    | Record error/warning diagnostic changes   |
| `ghcpMem.captureGitOps`             | true    | Record git operations                     |

## Autosave

| Setting                             | Default | What it controls                                                     |
| ----------------------------------- | ------- | -------------------------------------------------------------------- |
| `ghcpMem.autosave.enabled`          | true    | Enable context-pressure autosave                                     |
| `ghcpMem.autosave.eventThreshold`   | 40      | Trigger a flush after this many buffered events                      |
| `ghcpMem.autosave.minutesThreshold` | 20      | Trigger a flush after this many minutes since last save              |

## Health alerting

| Setting                        | Default | What it controls                                                        |
| ------------------------------ | ------- | ----------------------------------------------------------------------- |
| `ghcpMem.healthAlertThreshold` | 30      | Show a startup warning when the memory health score falls below this value (0 = off) |

## Privacy

| Setting                          | Default | What it controls                                       |
| -------------------------------- | ------- | ------------------------------------------------------ |
| `ghcpMem.redactSecrets`          | true    | API keys, tokens, conn strings, PEM blocks, JWTs       |
| `ghcpMem.honorPrivateTags`       | true    | Strip text inside `<private>...</private>` markers     |
| `ghcpMem.excludeGlobs`           | see settings | Glob patterns whose file events are skipped entirely |

## GitHub-compatible mode

Toggle `ghcpMem.githubCompatibleMode` to mirror GitHub Copilot's agentic-memory contract:

- 28-day retention (overrides `retentionDays`)
- Repo-scoped retrieval by default (overrides `scope`)

Useful when you want behaviour parity with the hosted Copilot memory product.
