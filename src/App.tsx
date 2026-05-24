import React, { useState, useEffect, useCallback } from 'react';
import { ChatPanel } from './components/ChatPanel';
import { StatusBar } from './components/StatusBar';
import { SettingsPanel } from './components/SettingsPanel';
import { ShortcutsHelp } from './components/ShortcutsHelp';
import { ErrorBoundary } from './components/ErrorBoundary';
import { BrowserPanel } from './components/BrowserPanel';
import { ToastContainer } from './components/Toast';
import './index.css';

function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [chatWidth, setChatWidth] = useState(460);

  useEffect(() => {
    window.__DSME_READY = true;
    return () => {
      window.__DSME_READY = false;
    };
  }, []);

  // Set window title
  useEffect(() => {
    if (window.electronAPI) {
      window.electronAPI.updateTitle('AI Web Automation');
    }
  }, []);

  // Native menu actions
  useEffect(() => {
    if (!window.electronAPI) return;
    const unsub = window.electronAPI.onMenuAction((action: string) => {
      switch (action) {
        case 'settings':
          setSettingsOpen(p => !p);
          break;
        case 'shortcuts':
          setHelpOpen(p => !p);
          break;
        case 'find':
          window.dispatchEvent(new CustomEvent('dsme-find'));
          break;
        case 'new-conversation':
          window.dispatchEvent(new CustomEvent('dsme-new-conversation'));
          break;
        case 'focus-chat':
          document.querySelector<HTMLTextAreaElement>('.chat-input')?.focus();
          break;
      }
    });
    return () => {
      unsub();
    };
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === ',') {
        e.preventDefault();
        setSettingsOpen(p => !p);
      }
      if (mod && e.key === '?') {
        e.preventDefault();
        setHelpOpen(p => !p);
      }
      if (mod && e.key === 'l' && !e.shiftKey) {
        e.preventDefault();
        document.querySelector<HTMLTextAreaElement>('.chat-input')?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    const openSettings = () => setSettingsOpen(true);
    window.addEventListener('open-settings', openSettings);
    return () => {
      window.removeEventListener('keydown', handler);
      window.removeEventListener('open-settings', openSettings);
    };
  }, []);

  const handleChatDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const sX = e.clientX;
    const sW = chatWidth;
    const move = (ev: MouseEvent) => {
      setChatWidth(Math.max(280, Math.min(800, sW + (sX - ev.clientX))));
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }, [chatWidth]);

  return (
    <div className="app-container automation-layout">
      {/* Titlebar area for dragging native macOS window and quick actions */}
      <header
        className="app-titlebar"
        onMouseDown={(e) => {
          const target = e.target as HTMLElement;
          if (target.closest('button')) return;
          if (e.detail === 2 || e.button !== 0) return;
          let lastX = e.screenX;
          let lastY = e.screenY;
          const onMouseMove = (ev: MouseEvent) => {
            const dx = ev.screenX - lastX;
            const dy = ev.screenY - lastY;
            lastX = ev.screenX;
            lastY = ev.screenY;
            if (dx !== 0 || dy !== 0) {
              window.electronAPI?.moveWindowBy?.(dx, dy);
            }
          };
          const onMouseUp = () => {
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
          };
          window.addEventListener('mousemove', onMouseMove);
          window.addEventListener('mouseup', onMouseUp);
        }}
      >
        <div className="titlebar-left">
          <span className="app-title-text">🐬 DSME — AI Web Automation Agent</span>
        </div>
        <div className="titlebar-right">
          <button className="titlebar-btn" onClick={() => setHelpOpen(true)} title="快捷键 (⌘?)">
            ⌨️ 帮助
          </button>
          <button className="titlebar-btn" onClick={() => setSettingsOpen(true)} title="设置 (⌘,)">
            ⚙️ 设置
          </button>
        </div>
      </header>

      <main className="main-content-split">
        <div className="browser-pane">
          <ErrorBoundary fallbackMessage="Browser panel crashed">
            <BrowserPanel
              visible={true}
              overlayOpen={settingsOpen || helpOpen}
              onTabOpen={() => {}}
            />
          </ErrorBoundary>
        </div>

        <div className="resize-handle-v" onMouseDown={handleChatDrag} />

        <div className="chat-pane" style={{ width: `${chatWidth}px` }}>
          <ErrorBoundary fallbackMessage="Chat panel crashed">
            <ChatPanel />
          </ErrorBoundary>
        </div>
      </main>

      <StatusBar />
      <SettingsPanel isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {helpOpen && <ShortcutsHelp onClose={() => setHelpOpen(false)} />}
      <ToastContainer />
    </div>
  );
}

export default App;
