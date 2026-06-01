# GHCP-MEM Threat Model

## Assets

- Local memory store
- VS Code `globalState`
- Disk mirror at `~/.ghcp-mem/sessions.json`
- MCP stdio server
- Copilot LM compression prompts
- Terminal capture stream
- Exported packs and backups

## Threats

| Surface | Threat | Mitigation |
|---|---|---|
| Local storage | Secret persistence or stale memory leakage | Redaction, enterprise mode, purge commands |
| `globalState` | Host compromise or workspace sharing | Local-only storage, workspace boundaries |
| JSON mirror | Tampering or partial writes | Atomic rename, owner-only permissions |
| MCP stdio | Untrusted tool calls or memory mutation | Read-only mode, write-tool gating |
| LM compression | Prompt echoing sensitive text | Output redaction before persistence |
| Terminal capture | Shell secrets in command lines | Disabled in enterprise mode |
| Team export | Over-sharing of context | Explicit allow/deny controls |
| Import | Malicious or stale third-party memory | Redaction on import, ID validation |

## Residual risk

GHCP-MEM reduces blast radius by keeping memory local and making policy explicit. It does not remove the need for operational review, especially in regulated environments.
