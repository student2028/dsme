# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 2.1.x   | Yes       |
| < 2.1   | No        |

## Threat model

DSME is a **local-first desktop agent**. It is designed for a trusted user running automation on their own machine. It is **not** a multi-tenant server and does **not** isolate untrusted code from the host OS.

### Capabilities users should understand

- The AI can invoke **`run_command`** — arbitrary shell commands in the workspace directory, with a **minimal blocklist** only (see `electron/lib/command-guard.ts`).
- The AI can **control the embedded browser** and read page content, network traffic, cookies, and clipboard (when tools are used).
- **Userscripts** execute JavaScript in page context; only install scripts you trust.
- **API keys** are stored locally under Electron `userData`.

### Controls in place

- Renderer: `contextIsolation`, no `nodeIntegration`
- Browser panel: sandboxed `WebContentsView`, separate session partition
- CDP debug proxy: **127.0.0.1** binding by default
- Chat markdown: DOMPurify
- Auto-downloads: filename basename sanitization

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security bugs.

Report via [GitHub Security Advisories](https://github.com/student2028/dsme/security/advisories/new) (preferred) or contact [@student2028](https://github.com/student2028) privately. Include:

1. Description and impact
2. Steps to reproduce
3. Affected version / commit
4. Suggested fix (optional)

We aim to acknowledge within 72 hours and patch critical issues promptly.

## Safe use recommendations

- Run DSME only on machines you control
- Use dedicated API keys with spending limits
- Review `run_command` and file-write tool output in the chat before accepting destructive operations
- Do not expose the CDP port (`9418`) via port forwarding or firewall rules
