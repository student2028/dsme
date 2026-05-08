import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ChatPanel } from './components/ChatPanel';
import { EditorPanel } from './components/EditorPanel';
import { FileTree } from './components/FileTree';
import { TerminalPanel } from './components/TerminalPanel';
import { StatusBar } from './components/StatusBar';
import { CommandPalette } from './components/CommandPalette';
import { SettingsPanel } from './components/SettingsPanel';
import { WelcomeScreen } from './components/WelcomeScreen';
import { SearchPanel } from './components/SearchPanel';
import { ShortcutHelp } from './components/ShortcutHelp';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastContainer, showToast } from './components/Toast';
import './index.css';

interface Tab {
  path: string;
  name: string;
  content: string;
  isDirty: boolean;
}

function App() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activePath, setActivePath] = useState<string>('');
  const [cursorPos, setCursorPos] = useState({ line: 1, column: 1 });
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(220);
  const [chatWidth, setChatWidth] = useState(420);
  const [gitBranch, setGitBranch] = useState('');
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeTab = tabs.find(t => t.path === activePath);

  useEffect(() => {
    const fetch = () => { if (window.electronAPI) window.electronAPI.getGitBranch().then(setGitBranch); };
    fetch();
    const i = setInterval(fetch, 10000);
    return () => clearInterval(i);
  }, []);

  const handleFileSelect = useCallback(async (filepath: string, name: string) => {
    if (tabs.find(t => t.path === filepath)) { setActivePath(filepath); return; }
    if (window.electronAPI) {
      try {
        const content = await window.electronAPI.readFile(filepath);
        setTabs(prev => [...prev, { path: filepath, name, content, isDirty: false }]);
        setActivePath(filepath);
      } catch (e: any) { showToast(`Failed to open: ${e.message}`, 'error'); }
    }
  }, [tabs]);

  const handleSave = useCallback(() => {
    const tab = tabs.find(t => t.path === activePath);
    if (tab?.isDirty && window.electronAPI) {
      window.electronAPI.writeFile(tab.path, tab.content);
      setTabs(prev => prev.map(t => t.path === activePath ? { ...t, isDirty: false } : t));
      showToast(`Saved: ${tab.name}`, 'success');
    }
  }, [tabs, activePath]);

  const handleEditorChange = useCallback((v: string | undefined) => {
    if (v !== undefined) {
      setTabs(prev => prev.map(t => t.path === activePath ? { ...t, content: v, isDirty: true } : t));
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = setTimeout(() => {
        if (window.electronAPI) {
          window.electronAPI.writeFile(activePath, v);
          setTabs(prev => prev.map(t => t.path === activePath ? { ...t, isDirty: false } : t));
        }
      }, 2000);
    }
  }, [activePath]);

  const handleCloseTab = useCallback((e: React.MouseEvent, p: string) => {
    e.stopPropagation();
    setTabs(prev => {
      const nt = prev.filter(t => t.path !== p);
      if (activePath === p) setActivePath(nt.length > 0 ? nt[nt.length - 1].path : '');
      return nt;
    });
  }, [activePath]);

  useEffect(() => {
    if (window.electronAPI) {
      window.electronAPI.onFileChanged(async (fp: string) => {
        try {
          const c = await window.electronAPI.readFile(fp);
          setTabs(prev => prev.map(t => t.path === fp ? { ...t, content: c, isDirty: false } : t));
          showToast(`Agent updated: ${fp.split('/').pop()}`, 'info');
        } catch {}
      });
    }
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === 's') { e.preventDefault(); handleSave(); }
      if (mod && e.key === 'p' && !e.shiftKey) { e.preventDefault(); setCmdPaletteOpen(p => !p); }
      if (mod && e.key === 'w') {
        e.preventDefault();
        if (activePath) setTabs(prev => {
          const nt = prev.filter(t => t.path !== activePath);
          setActivePath(nt.length > 0 ? nt[nt.length - 1].path : '');
          return nt;
        });
      }
      if (mod && e.key === ',') { e.preventDefault(); setSettingsOpen(p => !p); }
      if (mod && e.shiftKey && e.key === 'F') { e.preventDefault(); setSearchOpen(p => !p); }
      if (mod && e.key === '?') { e.preventDefault(); setHelpOpen(p => !p); }
    };
    window.addEventListener('keydown', handler);
    const save = () => handleSave();
    window.addEventListener('editor-save', save);
    return () => { window.removeEventListener('keydown', handler); window.removeEventListener('editor-save', save); };
  }, [handleSave, activePath]);

  const handleTerminalDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const sY = e.clientY, sH = terminalHeight;
    const move = (ev: MouseEvent) => setTerminalHeight(Math.max(80, Math.min(500, sH + (sY - ev.clientY))));
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  }, [terminalHeight]);

  const handleChatDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const sX = e.clientX, sW = chatWidth;
    const move = (ev: MouseEvent) => setChatWidth(Math.max(300, Math.min(700, sW + (sX - ev.clientX))));
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  }, [chatWidth]);

  const getLang = (n: string) => {
    const ext = n?.split('.').pop()?.toLowerCase() || '';
    return ({ ts:'TypeScript', tsx:'TypeScript', js:'JavaScript', jsx:'JavaScript', css:'CSS', html:'HTML', json:'JSON', md:'Markdown', py:'Python', kt:'Kotlin', dart:'Dart', swift:'Swift', go:'Go', rs:'Rust', java:'Java', sh:'Shell' } as any)[ext] || ext.toUpperCase() || 'TEXT';
  };

  return (
    <div className="app-container">
      <ErrorBoundary fallbackMessage="File tree crashed">
        <FileTree onFileSelect={handleFileSelect} />
      </ErrorBoundary>

      <main className="main-content">
        <div className="tab-bar">
          {tabs.map(tab => (
            <div key={tab.path} onClick={() => setActivePath(tab.path)} className={`tab-item ${activePath === tab.path ? 'active' : ''}`}>
              <span className="tab-name">{tab.name}{tab.isDirty ? ' ●' : ''}</span>
              <span className="tab-close" onClick={(e) => handleCloseTab(e, tab.path)}>×</span>
            </div>
          ))}
          {tabs.length === 0 && <div className="tab-empty">Ctrl+P search · Ctrl+Shift+F find · Ctrl+, settings</div>}
        </div>

        {activeTab && (
          <div className="breadcrumb">
            {activeTab.path.split('/').slice(-3).map((part, i, arr) => (
              <span key={i}>
                {i > 0 && <span className="breadcrumb-sep">/</span>}
                <span className={i === arr.length - 1 ? 'breadcrumb-active' : ''}>{part}</span>
              </span>
            ))}
          </div>
        )}

        <ErrorBoundary fallbackMessage="Editor crashed">
          {activeTab ? (
            <EditorPanel content={activeTab.content} onChange={handleEditorChange} filename={activeTab.name} onCursorChange={(l, c) => setCursorPos({ line: l, column: c })} />
          ) : (
            <WelcomeScreen />
          )}
        </ErrorBoundary>

        <div className="resize-handle-h" onMouseDown={handleTerminalDrag} />
        <div style={{ height: `${terminalHeight}px`, flexShrink: 0 }}>
          <ErrorBoundary fallbackMessage="Terminal crashed">
            <TerminalPanel />
          </ErrorBoundary>
        </div>
      </main>

      <div className="resize-handle-v" onMouseDown={handleChatDrag} />
      <div style={{ width: `${chatWidth}px`, flexShrink: 0, display: 'flex' }}>
        <ErrorBoundary fallbackMessage="Chat panel crashed">
          <ChatPanel currentFileContext={activeTab ? { path: activeTab.path, content: activeTab.content } : null} />
        </ErrorBoundary>
      </div>

      <StatusBar activePath={activeTab?.name || ''} language={getLang(activeTab?.name || '')} cursorPosition={cursorPos} gitBranch={gitBranch} />
      <CommandPalette isOpen={cmdPaletteOpen} onClose={() => setCmdPaletteOpen(false)} onFileSelect={handleFileSelect} />
      <SettingsPanel isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <SearchPanel isOpen={searchOpen} onClose={() => setSearchOpen(false)} onResultSelect={handleFileSelect} />
      <ShortcutHelp isOpen={helpOpen} onClose={() => setHelpOpen(false)} />
      <ToastContainer />
    </div>
  );
}

export default App;
