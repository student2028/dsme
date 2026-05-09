# DSME — DeepSeek Matrix Engine

> An AI-native code editor built with Electron + Vercel AI SDK

<p align="center">
  <img src="public/icon.png" width="120" alt="DSME Logo" />
</p>

## Features

### 🤖 AI Agent
- **Vercel AI SDK** engine with `streamText` + Zod tool schemas
- 8 built-in tools: `read_file`, `write_file`, `replace_in_file`, `list_directory`, `search_codebase`, `run_command`, `web_search`, `fetch_url`
- Real-time streaming with token-level display
- Multi-step tool chains (up to 25 steps per request)
- Multimodal support (text + image attachments via paste/drop)
- Context window management (50-message sliding window)
- **RAG engine** with TF-IDF + auto-reindex on file changes
- **Response time tracking** (⚡ duration badge per message)

### 📝 Code Editor
- Monaco-based editor with 16+ language syntax highlighting
- File tree with git status indicators
- Tab system with dirty indicators and auto-save
- Breadcrumb navigation with click-to-copy path
- Quick Open (⌘P) with fuzzy file search
- Code search across workspace (⌘⇧F)
- Diff preview for AI-generated code changes (accept/reject)

### 💻 Integrated Terminal
- Embedded terminal with shell access
- Resizable panel with drag handle
- Command output synced from AI agent tool calls

### 🎨 UI/UX
- Dark/Light theme with full CSS variable system (15 @keyframes animations)
- In-conversation search (⌘F) with real-time dimming + match count
- Per-message delete with safety guard
- One-click Markdown export with metadata
- Character + token counter in input area
- Conversation history with persistence
- Conversation isolation (reset on switch)
- ErrorBoundary with collapsible stack trace
- Window state persistence (remembers size/position)
- macOS native menu + 16 keyboard shortcuts

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Electron Main                     │
│  ┌─────────────────────────────────────────────┐    │
│  │            VercelAgent (IAgent)              │    │
│  │  • streamText() with AbortController         │    │
│  │  • Zod-schema tools × 8                      │    │
│  │  • TF-IDF RAG with file watcher              │    │
│  │  • pruneHistory() sliding window             │    │
│  │  • Retry with backoff (max 3)                │    │
│  └──────────────┬──────────────────────────────┘    │
│                 │ IPC (Set-based multi-subscriber)   │
│  chat-stream-{start,token,end} + chat-status        │
│                 │                                    │
│  ┌──────────────┴──────────────────────────────┐    │
│  │           Preload (contextBridge)            │    │
│  └──────────────┬──────────────────────────────┘    │
└─────────────────┼───────────────────────────────────┘
                  │
┌─────────────────┼───────────────────────────────────┐
│  ┌──────────────┴──────────────────────────────┐    │
│  │              React Frontend                  │    │
│  │  App.tsx → 15 components                     │    │
│  │  • ChatPanel (streaming + markdown + search) │    │
│  │  • EditorPanel (Monaco)                      │    │
│  │  • FileTree / GitPanel / SearchPanel          │    │
│  │  • TerminalPanel / StatusBar                 │    │
│  └─────────────────────────────────────────────┘    │
│                 Renderer Process                     │
└─────────────────────────────────────────────────────┘
```

## Security

- All 8 `exec()` calls sanitized against shell injection
- XSS prevention via Base64 `data-code` encoding in copy buttons
- URL validation with protocol whitelist (http/https only)
- Shell metacharacter escaping for grep, curl, git
- API keys stored in user data directory, never in source
- IPC memory leak prevention (Set-based multi-subscriber pattern)
- Graceful shutdown (PTY + Agent + CDP proxy cleanup)

## Quality

- **34 defects fixed** across 6 audit passes
- **0 TypeScript errors**, 0 build warnings
- **11/11 automated smoke tests** (CDP-based)
- **0 TODO/FIXME/HACK** in codebase
- All `.then()` chains have `.catch()` handlers

## Quick Start

```bash
# Install dependencies
npm install

# Development (Vite HMR + Electron)
npm run dev

# Production build
npm run build

# Run tests (requires running app on port 19223)
npm test
```

## Configuration

Set your API key via environment variable or Settings (⌘,):

```bash
export DSME_API_KEY="sk-your-key-here"
```

Compatible with any OpenAI-format API endpoint:
- SiliconFlow (default)
- DeepSeek
- OpenAI
- Any OpenAI-compatible provider

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| ⌘P | Quick Open (file) |
| ⌘N | New conversation |
| ⌘F | Find in conversation |
| ⌘L | Focus chat input |
| ⌘S | Save file |
| ⌘B | Toggle sidebar |
| ⌘O | Open workspace |
| ⌘W | Close tab |
| ⌘, | Settings |
| ⇧⌘L | Toggle theme |
| ⇧⌘F | Find in files |
| ⌘? | Keyboard shortcuts |
| Enter | Send message |
| ⇧Enter | New line |
| ⌘V | Paste image |
| Esc | Close search bar |

## Tech Stack

- **Runtime**: Electron 36
- **Frontend**: React 19 + Vite 8
- **AI Engine**: Vercel AI SDK (`ai` + `@ai-sdk/openai`)
- **Schema**: Zod
- **Editor**: Monaco Editor
- **Markdown**: marked + highlight.js
- **RAG**: Custom TF-IDF engine with file watcher

## License

MIT
