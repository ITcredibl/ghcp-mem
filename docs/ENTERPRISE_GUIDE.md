# Enterprise Guide

## Recommended settings

```json
{
  "ghcpMem.enterpriseMode": true,
  "ghcpMem.captureTerminalCommands": false,
  "ghcpMem.captureCodeSnippets": false,
  "ghcpMem.allowMcpWriteAccess": false,
  "ghcpMem.allowTeamExport": false,
  "ghcpMem.previewBeforePersist": true
}
```

## Policy options

- Use `ghcpMem.policySource` for centrally managed redaction rules.
- Prefer workspace settings for team-wide defaults.
- Use the memory audit view before sharing or exporting context.

## Operational guidance

- Disable terminal capture on regulated machines.
- Keep exports redacted and review them before distribution.
- Use purge commands to remove stale or incorrect memories quickly.
