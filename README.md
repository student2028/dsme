# DSME — DeepSeek Matrix Engine

> **A world-class TUI-style AI IDE** built with Electron, React, Monaco Editor, and DeepSeek.

```
 ██████╗  ███████╗ ███╗   ███╗ ███████╗
 ██╔══██╗ ██╔════╝ ████╗ ████║ ██╔════╝
 ██║  ██║ ███████╗ ██╔████╔██║ █████╗
 ██║  ██║ ╚════██║ ██║╚██╔╝██║ ██╔══╝
 ██████╔╝ ███████║ ██║ ╚═╝ ██║ ███████╗
 ╚═════╝  ╚══════╝ ╚═╝     ╚═╝ ╚══════╝
```

## Features

### 🤖 Autonomous AI Agent
- **6 atomic tools**: `read_file`, `write_file`, `replace_in_file`, `list_directory`, `search_codebase`, `run_command`
- **25-round iterative loop** with automatic error recovery
- **Real-time token streaming** — watch the AI think character by character
- **Context-aware**: automatically sends your current file to the agent
- **Multi-conversation** with persistent history across restarts

### 📝 Professional Editor
- **Monaco Editor** with custom Matrix theme (`dsme-dark`)
- Multi-tab editing with dirty state detection
- Auto-save (2s debounce) + manual Ctrl+S
- Breadcrumb path navigation
- Full Monaco keybindings (Ctrl+F, Ctrl+H, Ctrl+G, etc.)

### 🖥 Integrated Terminal
- Real zsh PTY session via `node-pty`
- Full ANSI color rendering
- ResizeObserver-driven auto-fit
- 5000-line scrollback buffer

### 📁 Activity Bar & Sidebar
- **Explorer**: Recursive file tree with Git status (`[M]` / `[U]`)
- **Search**: Global grep across workspace (Ctrl+Shift+F)
- **Git**: View changes, commit directly from the IDE

### ⚡ Silicon Flow Multi-Model
DeepSeek-V4-Flash, DeepSeek-V3.2, GLM-5, MiniMax-M2.5, Kimi-K2.5, Qwen3, PaddleOCR-VL

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+P` | Quick open file |
| `Ctrl+S` | Save file |
| `Ctrl+W` | Close tab |
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+,` | Settings |
| `Ctrl+Shift+F` | Search workspace |
| `Ctrl+?` | Shortcut help |

## Quick Start

```bash
# Clone & install
git clone <repo-url> dsme && cd dsme
npm install

# Development
npm run dev

# Production build (macOS .dmg)
npm run build:pkg
```

## Architecture

```
dsme/
├── electron/           # Main process
│   ├── main.ts         # Window, IPC, PTY, Git, Config
│   ├── preload.ts      # contextBridge (18 APIs)
│   └── agent.ts        # Streaming DeepSeek agent
├── src/                # React renderer
│   ├── App.tsx         # Layout orchestrator
│   ├── index.css       # 1100+ lines TUI theme
│   └── components/     # 17 components
│       ├── ActivityBar, FileTree, GitPanel
│       ├── EditorPanel, TerminalPanel
│       ├── ChatPanel (streaming + persistence)
│       ├── CommandPalette, SearchPanel
│       ├── SettingsPanel, WelcomeScreen
│       ├── StatusBar, Toast, DiffPreview
│       ├── ErrorBoundary, ShortcutHelp
│       └── ...
└── package.json        # electron-builder config
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop Shell | Electron 42 |
| UI Framework | React 19 |
| Code Editor | Monaco Editor |
| Terminal | xterm.js 6 |
| AI Engine | OpenAI SDK → Silicon Flow |
| Build | Vite 8 + vite-plugin-electron |
| Package | electron-builder |

## Configuration

Settings are stored in `~/Library/Application Support/dsme/dsme-config.json`.

Default API: **Silicon Flow** (`https://api.siliconflow.cn/v1`)

---

*Built with obsessive attention to detail. Every pixel is intentional.*
