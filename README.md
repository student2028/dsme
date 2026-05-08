# DSME — DeepSeek Matrix Engine

> A world-class TUI-aesthetic AI IDE powered by DeepSeek, built with Electron + React + TypeScript.

## Features

- 🖥️ **Monaco Editor** with custom Matrix dark theme (green-on-black)
- 🤖 **Autonomous AI Agent** powered by DeepSeek with tool-calling loop
- 📁 **Recursive File Explorer** with Git status indicators (M/U badges)
- 🔧 **Agent Tools**: read_file, write_file, replace_in_file, list_directory, search_codebase, run_command
- 💬 **Multi-Conversation Chat** with Markdown rendering and conversation history
- ⌨️ **Terminal** with real zsh PTY session
- 🔍 **Command Palette** (Ctrl+P) for instant file search
- ⚙️ **Settings Panel** (Ctrl+,) for API key and model configuration
- 📊 **Status Bar** with cursor position, language, git branch, and clock
- 🖱️ **Resizable Panels** — drag terminal height and chat width
- 🔄 **Live File Reload** — when AI edits a file, your editor updates instantly
- 💾 **Persistent Config** — API keys saved to disk across sessions

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+S` / `Cmd+S` | Save current file |
| `Ctrl+P` / `Cmd+P` | Open Command Palette |
| `Ctrl+W` / `Cmd+W` | Close current tab |
| `Ctrl+,` / `Cmd+,` | Open Settings |

## Getting Started

```bash
# Install dependencies
npm install

# Configure your API key (or use Settings panel)
export DEEPSEEK_API_KEY="sk-your-key-here"

# Start development
npm run dev
```

## Architecture

```
dsme/
├── electron/
│   ├── main.ts        # Electron main process, IPC handlers, PTY, file system
│   ├── preload.ts     # IPC bridge (contextBridge)
│   └── agent.ts       # DeepSeek Agent with tool-calling loop
├── src/
│   ├── App.tsx         # Main layout with tabs, shortcuts, resize
│   ├── index.css       # Complete TUI theme (Matrix aesthetic)
│   ├── types.d.ts      # TypeScript declarations
│   └── components/
│       ├── ChatPanel.tsx       # Multi-conversation AI chat
│       ├── EditorPanel.tsx     # Monaco editor with custom theme
│       ├── FileTree.tsx        # Recursive file explorer + git
│       ├── TerminalPanel.tsx   # xterm.js terminal
│       ├── StatusBar.tsx       # Bottom status bar
│       ├── CommandPalette.tsx  # Ctrl+P file finder
│       └── SettingsPanel.tsx   # API key / model config
├── vite.config.ts
└── package.json
```

## License

MIT
