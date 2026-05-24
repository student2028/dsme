# DSME — DeepSeek Matrix Engine

<p align="center">
  <img src="public/icon.png" width="120" alt="DSME Logo" />
</p>

**DSME** is an open-source **AI web automation agent** built with Electron and the [Vercel AI SDK](https://sdk.vercel.ai/). The AI runs beside a real embedded browser (`WebContentsView`), can navigate pages, click elements, extract data, sync cookies, and chain dozens of tools — without Puppeteer/Playwright over WebSocket.

## Features

### Browser automation (core)
- Embedded Chromium panel with **Electron-native input** (`sendInputEvent`, `insertText`) and **CDP accessibility snapshots** (`[e1]`, `[e2]` refs)
- 30+ `browser_*` tools: navigate, snapshot, click, type, scroll, frames, network capture, PDF export, cookie import/export
- **Browser task timeline** in the UI — multi-step sessions with Markdown export
- Built-in **userscripts** (Tampermonkey-style) with a manager UI

### AI agent
- **Vercel AI SDK** kernel (`streamText` + Zod tools) and optional **Builtin** kernel (direct OpenAI-compatible API)
- Tools: `web_search`, `fetch_url`, `read_file`, `write_file`, `replace_in_file`, `list_directory`, `search_codebase`, `run_command`, `browse_page`, plus all `browser_*` tools
- Streaming tokens, multimodal input (paste/drop images), conversation persistence, abort/retry
- Pluggable providers: Volcengine Ark, SiliconFlow, Google, DeepSeek (any OpenAI-compatible endpoint)

### UX
- Split layout: browser + chat, resizable pane
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
