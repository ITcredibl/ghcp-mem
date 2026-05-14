# Tuning GHCP-MEM

All settings live under **GHCP-MEM** in VS Code Settings.

## Retention & disk budget

| Setting                       | Default | What it controls                                          |
| ----------------------------- | ------- | --------------------------------------------------------- |
| `ghcpMem.retentionDays`       | 90      | Age-based eviction                                        |
| `ghcpMem.maxStoredSessions`   | 50      | Count-based eviction                                      |
| `ghcpMem.maxStoreSizeMB`      | 25      | Soft byte cap on `~/.ghcp-mem/sessions.json`              |

All three apply in order: age → count → size. The most conservative bound wins.

## Privacy

| Setting                          | Default | What it controls                                       |
| -------------------------------- | ------- | ------------------------------------------------------ |
| `ghcpMem.redactSecrets`          | true    | API keys, tokens, conn strings, PEM blocks, JWTs       |
| `ghcpMem.honorPrivateTags`       | true    | Strip text inside `<private>...</private>` markers     |

## GitHub-compatible mode

Toggle `ghcpMem.githubCompatibleMode` to mirror GitHub Copilot's agentic-memory contract:

- 28-day retention (overrides `retentionDays`)
- Repo-scoped retrieval by default (overrides `scope`)

Useful when you want behaviour parity with the hosted Copilot memory product.
