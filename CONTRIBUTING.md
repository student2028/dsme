# Contributing to DSME

Thank you for helping improve DSME. This project targets **open-source quality**: typed TypeScript, zero ESLint errors, and passing unit tests in CI.

## Development setup

```bash
npm install
npm run dev
```

In another terminal:

```bash
npm run test:ci    # typecheck + lint + unit tests
```

## Pull request checklist

- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes (no `@typescript-eslint/no-explicit-any` without justification)
- [ ] `npm run test:unit` passes
- [ ] User-visible behavior changes are noted in the PR description
- [ ] No secrets, API keys, or personal data in commits
- [ ] README / SECURITY updated if behavior or threat model changes

## Code style

- **Minimize scope** — focused diffs, match existing patterns
- **Pure logic** belongs in testable modules (`src/lib/`, `electron/agents/search-result-format.ts`, `electron/lib/`)
- **Electron-only code** stays in `electron/`; avoid top-level Electron imports in modules imported by unit tests
- Prefer `unknown` + narrowing over `any`
- Empty `catch` blocks should log with `console.warn` unless intentionally silent

## Architecture notes

- **`IAgent`** (`electron/agents/base.ts`) — pluggable LLM kernels
- **`BrowserViewManager`** — single owner of `WebContentsView`; browser tools go through `browser-use.ts`
- **Config** — `electron/config/store.ts`; provider presets in `providers.ts`
- **IPC** — typed in `electron/preload.ts` and `src/global.d.ts`

## Adding a tool

1. Implement in `electron/agents/browser-use.ts` (browser) or `shared-tools.ts` (filesystem/search)
2. Register in both `vercel.ts` (Zod `tool()`) and `builtin.ts` (OpenAI function schema) unless you extract a shared registry
3. Add `formatToolArgs` label in `electron/agents/tool-display.ts` for chat status display
4. Extend smoke tests if the tool is user-critical

## Reporting issues

Use GitHub Issues with: OS version, Node version, provider/model, steps to reproduce, and relevant logs from the main process terminal.

Security issues: see [SECURITY.md](./SECURITY.md) — please do not open public issues for exploitable bugs.
