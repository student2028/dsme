# DSME — DeepSeek Matrix Engine

<p align="center">
  <img src="build/icon.png" width="120" alt="DSME Logo" />
</p>

<p align="center">
  <strong>English</strong> | <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/student2028/dsme/actions/workflows/ci.yml"><img src="https://github.com/student2028/dsme/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node 20+" />
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey" alt="Platform" />
</p>

---

## What is DSME?

**DSME (DeepSeek Matrix Engine)** is a **local, open-source AI web automation agent**. It pairs a conversational AI with a real embedded Chromium browser inside a single Electron desktop app. You describe a goal in natural language — the agent plans steps, opens pages, clicks elements, fills forms, extracts data, reads files, and runs shell commands on your machine, all while you watch it work in the browser panel.

Unlike remote browser automation stacks (Puppeteer/Playwright over WebSocket), DSME controls the browser **natively through Electron**: `WebContentsView` for rendering, `sendInputEvent` for clicks and keys, CDP accessibility snapshots for element refs (`[e1]`, `[e2]`, …), and direct session/cookie access. That means lower latency, persistent login state, and a UI you can interact with at any time.

DSME is built for developers and power users who want an **AI operator on the web** — research, form filling, dashboard exports, SPA data extraction, cookie-backed sessions — without wiring up a separate headless browser farm.

## Why DSME?

| | Typical headless automation | DSME |
|---|---|---|
| Browser | External process, often headless | Embedded panel, visible and controllable |
| Input | Synthetic DOM events via CDP | Electron-native input + CDP snapshots |
| Session | Often cold start per run | Persistent partition; Chrome cookie sync on macOS |
| AI integration | You glue LLM + tools yourself | Built-in agent with 30+ browser tools + filesystem/search/shell |
| Provider lock-in | Varies | Any OpenAI-compatible API (DeepSeek, Volcengine Ark, SiliconFlow, Google, …) |

## Use cases

- **Research & extraction** — Navigate sites, run Readability-based article extraction, capture network API responses from SPAs.
- **Logged-in workflows** — Sync Chrome cookies on macOS, or import/export cookie JSON to resume sessions.
- **Multi-step web tasks** — Named browser task timelines with Markdown export; rollback via snapshot/restore state.
- **Local dev assistant** — Read/write project files, search the codebase, run commands, and browse docs in one window.
- **Form & file automation** — Type into fields by ref, upload files without OS dialogs, export PDFs, manage downloads.

## Features

### Browser automation (core)

- Embedded Chromium panel with **Electron-native input** (`sendInputEvent`, `insertText`) and **CDP accessibility snapshots** (`[e1]`, `[e2]` refs)
- 30+ `browser_*` tools: navigate, snapshot, click, type, scroll, frames, network capture, PDF export, cookie import/export, state rollback, overlay highlights
- **Browser task timeline** in the UI — multi-step sessions with Markdown export
- Built-in **userscripts** (Tampermonkey-style) with a manager UI

### AI agent

- **Vercel AI SDK** kernel (`streamText` + Zod tools) and optional **Builtin** kernel (direct OpenAI-compatible API)
- Tools: `web_search`, `fetch_url`, `read_file`, `write_file`, `replace_in_file`, `list_directory`, `search_codebase`, `run_command`, `browse_page`, plus all `browser_*` tools
- Streaming tokens, multimodal input (paste/drop images), conversation persistence, abort/retry
- Pluggable providers: Volcengine Ark, SiliconFlow, Google, DeepSeek (any OpenAI-compatible endpoint)

### UX

- Split layout: resizable browser + chat panes
- Dark/light theme, keyboard shortcuts, settings panel, error boundaries
- macOS: Chrome cookie sync for logged-in sessions

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Electron Main Process                    │
│  ┌──────────────────┐  ┌─────────────────────────────────┐  │
│  │ BrowserViewManager│  │ VercelAgent / BuiltinAgent (IAgent)│
│  │ WebContentsView   │◄─┤ streamText + tools + shared-tools │  │
│  │ CDP + native I/O  │  └──────────────┬──────────────────┘  │
│  └────────▲─────────┘                 │ IPC                  │
│           │ bounds/show/hide            ▼                      │
│  ┌────────┴─────────┐  ┌─────────────────────────────────┐  │
│  │ preload (bridge)  │  │ React: BrowserPanel + ChatPanel   │  │
│  └──────────────────┘  └─────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## Security model

DSME is a **local automation tool**: the AI can run shell commands and control the browser on your machine.

| Control | Behavior |
|---------|----------|
| Renderer | `contextIsolation: true`, `nodeIntegration: false` |
| Browser view | `sandbox: true`, isolated session partition |
| `run_command` | Blocklist for obviously destructive patterns (`rm -rf /`, `mkfs`, …) — **not** a full sandbox |
| Downloads | Filenames sanitized with `path.basename` |
| Markdown | DOMPurify sanitization in chat |
| CDP proxy | Binds to **127.0.0.1** only (port `9418` by default) |
| API keys | Stored in Electron `userData`, never committed to git |

See [SECURITY.md](./SECURITY.md) for reporting vulnerabilities.

## Requirements

- **Node.js** 20+ (22+ recommended)
- **macOS** for Chrome cookie sync (other platforms: browser works; cookie sync returns unsupported)
- An API key for an OpenAI-compatible provider

## Quick start

```bash
git clone https://github.com/student2028/dsme.git
cd dsme
npm install
npm run dev
```

Set API keys via **Settings (⌘,)** or environment variables:

```bash
export DSME_API_KEY="sk-..."           # SiliconFlow
export VOLCENGINE_API_KEY="..."        # Volcengine Ark (default provider)
export DEEPSEEK_API_KEY="..."
export GOOGLE_API_KEY="..."
```

Build a macOS app bundle:

```bash
npm run build:pkg
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Vite HMR + Electron |
| `npm run build` | Typecheck + production build |
| `npm run build:pkg` | Build + electron-builder DMG (macOS) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (zero errors required) |
| `npm run test:unit` | Pure Node unit tests (no Electron) |
| `npm run test:smoke` | CDP smoke tests (requires running app) |
| `npm run test:ci` | typecheck + lint + unit + build (CI default) |

## Testing

**Unit tests** (CI):

```bash
npm run test:ci
```

**Smoke tests** (manual / optional):

1. Start the app: `npm run dev`
2. Run: `npm run test:smoke`  
   Uses CDP on `127.0.0.1:9418` (override with `DSME_CDP_PORT`).

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| ⌘N | New conversation |
| ⌘F | Find in conversation |
| ⌘L | Focus chat input |
| ⌘, | Settings |
| ⌘? | Keyboard shortcuts |
| Enter | Send message |
| ⇧Enter | New line |

## Project layout

```
electron/
  agents/          # IAgent kernels + shared tools
  browser-view-manager.ts
  config/          # Provider presets + user config persistence
  lib/             # errors, command guard, run_command helper
src/
  components/      # React UI
  lib/             # browserTaskTimeline (pure functions)
tests/             # unit.mjs + smoke.mjs
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT — see [LICENSE](./LICENSE).

## Changelog

See [CHANGELOG.md](./CHANGELOG.md).
