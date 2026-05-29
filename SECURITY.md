# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 1.3.x (current) | ✅ |
| 1.2.x | Security fixes only |
| < 1.2.0 | ❌ |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report security issues privately via GitHub's built-in security advisory:

👉 [https://github.com/ITcredibl/ghcp-mem/security/advisories/new](https://github.com/ITcredibl/ghcp-mem/security/advisories/new)

Or email: **security@itcredibl.com**

Please include:
- A description of the vulnerability
- Steps to reproduce or a proof of concept
- The potential impact
- Your VS Code and GHCP-MEM versions

You will receive an acknowledgement within **48 hours** and a status update within **7 days**. We follow responsible disclosure — please give us time to patch before publishing.

## Security model

GHCP-MEM is designed with privacy and least-privilege in mind:

- **All data stays local** — no telemetry, no cloud sync, no outbound network calls beyond your existing GitHub Copilot subscription
- **No open ports** — the MCP server communicates via stdin/stdout only
- **Dual-pass redaction** — secrets are stripped at capture time and again at LM output time
- **Redact-on-import** — Memory Packs are re-redacted when imported from a third party
- **No native binaries** — zero compiled dependencies, zero supply-chain attack surface from native code
- **Workspace artifact is gitignored** — `.github/instructions/session-memory.instructions.md` is never committed unless you explicitly remove it from `.gitignore`
- **`<private>...</private>` blocks** are stripped before any persistence

## Known limitations

- The LM compression call goes through your existing Copilot subscription (GitHub's servers). Do not include secrets in source code comments — while redaction is comprehensive, defence in depth means not relying on it exclusively.
- The `~/.ghcp-mem/sessions.json` mirror is a plaintext file on your filesystem, protected by OS-level user permissions only. Encrypt your home directory if you need additional protection.
