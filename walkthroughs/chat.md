# Chat with your memory

GHCP-MEM registers a Copilot chat participant named **@mem** with progressive-disclosure commands:

| Command          | What it does                                                      |
| ---------------- | ----------------------------------------------------------------- |
| `@mem /recent`   | Show the most recent sessions                                     |
| `@mem /search foo` | Keyword search with RRF (recency + match) ranking               |
| `@mem /timeline 7d` | Sessions within a time window                                  |
| `@mem /detail <id>` | Full session detail by ID prefix                               |
| `@mem /azure`    | Azure-tagged sessions grouped by subsystem                        |
| `@mem /export <id>` | Diff-friendly markdown export (paste into PRs)                 |
| `@mem /health`   | Memory health score with redaction coverage & retention headroom  |

## Inline filters

Search and timeline accept inline filters:

```
@mem /search type:feature since:7d tag:wip auth refactor
```

## Beyond Copilot

GHCP-MEM also ships a JSON-RPC stdio MCP server (`node mcpServer.js`) so non-Copilot agents (Claude Code, Cline, etc.) can query the same memory.
