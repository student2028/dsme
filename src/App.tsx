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
import { ShortcutsHelp } from './components/ShortcutsHelp';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ActivityBar } from './components/ActivityBar';
import { GitPanel } from './components/GitPanel';
import { DiffPreview } from './components/DiffPreview';
import type { DiffChange } from './components/DiffPreview';
import { ToastContainer, showToast } from './components/Toast';
import { useTheme } from './ThemeContext';
import './index.css';

interface Tab { path: string; name: string; content: string; isDirty: boolean; }

function App() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activePath, setActivePath] = useState('');
  const [cursorPos, setCursorPos] = useState({ line: 1, column: 1 });
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(220);
  const [chatWidth, setChatWidth] = useState(460);
  const [gitBranch, setGitBranch] = useState('');
  const [sidePanel, setSidePanel] = useState<string>('explorer');
  const [diffChanges, setDiffChanges] = useState<DiffChange[]>([]);
  const autoSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { toggleTheme } = useTheme();
  const [tabMenu, setTabMenu] = useState<{x: number; y: number; path: string} | null>(null);

  const activeTab = tabs.find(t => t.path === activePath);

  useEffect(() => {
    const f = () => { if (window.electronAPI) window.electronAPI.getGitBranch().then(setGitBranch).catch(() => {}); };
    f(); const i = setInterval(f, 10000); return () => clearInterval(i);
  }, []);

  // Dynamic window title
  useEffect(() => {
    if (window.electronAPI) {
      window.electronAPI.updateTitle(activeTab?.name || '');
    }
  }, [activeTab?.name]);

  const handleFileSelect = useCallback(async (filepath: string, name: string) => {
    if (tabs.find(t => t.path === filepath)) { setActivePath(filepath); return; }
    if (window.electronAPI) {
      try {
        const content = await window.electronAPI.readFile(filepath);
        setTabs(prev => [...prev, { path: filepath, name, content, isDirty: false }]);
        setActivePath(filepath);
      } catch (e: any) { showToast(`Failed: ${e.message}`, 'error'); }
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

  // Native menu actions
  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.onMenuAction((action: string) => {
      switch (action) {
        case 'settings': setSettingsOpen(p => !p); break;
        case 'quick-open': setCmdPaletteOpen(p => !p); break;
        case 'search': setSearchOpen(p => !p); break;
        case 'shortcuts': setHelpOpen(p => !p); break;
        case 'toggle-sidebar': setSidePanel(p => p ? '' : 'explorer'); break;
        case 'save': handleSave(); break;
        case 'find': window.dispatchEvent(new CustomEvent('dsme-find')); break;
        case 'new-conversation': window.dispatchEvent(new CustomEvent('dsme-new-conversation')); break;
        case 'focus-chat': document.querySelector<HTMLTextAreaElement>('.chat-input')?.focus(); break;
      }
    });
  }, [handleSave]);

  const handleEditorChange = useCallback((v: string | undefined) => {
    if (v !== undefined) {
      setTabs(prev => prev.map(t => t.path === activePath ? { ...t, content: v, isDirty: true } : t));
      if (autoSaveRef.current) clearTimeout(autoSaveRef.current);
      autoSaveRef.current = setTimeout(() => {
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
          showToast(`Applied: ${fp.split('/').pop()}`, 'success');
        } catch {}
      });

      // Diff preview from agent
      window.electronAPI.onDiffPreview(change => {
        setDiffChanges(prev => [...prev, {
          id: change.id,
          filepath: change.filepath,
          filename: change.filename,
          oldContent: change.oldContent,
          newContent: change.newContent,
          status: 'pending' as const,
        }]);
      });
    }
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === 's') { e.preventDefault(); handleSave(); }
      if (mod && e.key === 'p' && !e.shiftKey) { e.preventDefault(); setCmdPaletteOpen(p => !p); }
      if (mod && e.key === 'w') { e.preventDefault(); if (activePath) setTabs(prev => { const nt = prev.filter(t => t.path !== activePath); setActivePath(nt.length > 0 ? nt[nt.length - 1].path : ''); return nt; }); }
      if (mod && e.key === ',') { e.preventDefault(); setSettingsOpen(p => !p); }
      if (mod && e.shiftKey && e.key === 'F') { e.preventDefault(); setSearchOpen(p => !p); }
      if (mod && e.key === '?') { e.preventDefault(); setHelpOpen(p => !p); }
      if (mod && e.key === 'b') { e.preventDefault(); setSidePanel(p => p ? '' : 'explorer'); }
      if (mod && e.shiftKey && e.key === 'L') { e.preventDefault(); toggleTheme(); }
      if (mod && e.key === 'l' && !e.shiftKey) { e.preventDefault(); window.dispatchEvent(new Event('focus-chat')); }
    };
    window.addEventListener('keydown', handler);
    const save = () => handleSave();
    window.addEventListener('editor-save', save);
    const openSettings = () => setSettingsOpen(true);
    window.addEventListener('open-settings', openSettings);
    return () => { window.removeEventListener('keydown', handler); window.removeEventListener('editor-save', save); window.removeEventListener('open-settings', openSettings); };
  }, [handleSave, activePath]);

  const handleTerminalDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault(); const sY = e.clientY, sH = terminalHeight;
    const move = (ev: MouseEvent) => setTerminalHeight(Math.max(80, Math.min(500, sH + (sY - ev.clientY))));
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  }, [terminalHeight]);

  const handleChatDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault(); const sX = e.clientX, sW = chatWidth;
    const move = (ev: MouseEvent) => setChatWidth(Math.max(280, Math.min(800, sW + (sX - ev.clientX))));
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  }, [chatWidth]);

  const getLang = (n: string) => {
    const ext = n?.split('.').pop()?.toLowerCase() || '';
    return ({ ts:'TS', tsx:'TSX', js:'JS', jsx:'JSX', css:'CSS', html:'HTML', json:'JSON', md:'MD', py:'PY', kt:'KT', dart:'Dart', swift:'Swift', go:'Go', rs:'Rust', java:'Java', sh:'SH' } as any)[ext] || ext.toUpperCase() || 'TXT';
  };

  const handlePanelChange = (panel: string) => {
    if (panel === 'settings') { setSettingsOpen(p => !p); return; }
    setSidePanel(prev => prev === panel ? '' : panel);
  };

  return (
    <div className="app-container">
      <ActivityBar activePanel={sidePanel} onPanelChange={handlePanelChange} />

      {/* Side panel */}
      {sidePanel && (
        <div className="side-panel">
          {sidePanel === 'explorer' && (
            <ErrorBoundary fallbackMessage="File tree crashed">
              <FileTree onFileSelect={handleFileSelect} activePath={activePath} />
            </ErrorBoundary>
          )}
          {sidePanel === 'search' && (
            <SearchPanel isOpen={true} onClose={() => setSidePanel('')} onResultSelect={handleFileSelect} />
          )}
          {sidePanel === 'git' && (
            <ErrorBoundary fallbackMessage="Git panel crashed">
              <GitPanel />
            </ErrorBoundary>
          )}
        </div>
      )}

      <main className="main-content">
        <div className="tab-bar" onDoubleClick={() => setCmdPaletteOpen(true)}>
          {tabs.map(tab => (
            <div key={tab.path} onClick={() => setActivePath(tab.path)}
              onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); handleCloseTab(e as any, tab.path); } }}
              onContextMenu={(e) => { e.preventDefault(); setTabMenu({x: e.clientX, y: e.clientY, path: tab.path}); }}
              className={`tab-item ${activePath === tab.path ? 'active' : ''}`}>
              <span className="tab-name">{tab.name}</span>
              {tab.isDirty && <span className="tab-dirty">●</span>}
              <span className="tab-close" onClick={(e) => handleCloseTab(e, tab.path)}>×</span>
            </div>
          ))}
          {tabs.length === 0 && <div className="tab-empty">⌘P open file · ⌘L chat · ⌘B sidebar · double-click to open</div>}
        </div>

        {activeTab && (
          <div className="breadcrumb" title={activeTab.path}
            onClick={() => { navigator.clipboard.writeText(activeTab.path); showToast('Path copied', 'success'); }}>
            {activeTab.path.split('/').slice(-3).map((part, i, arr) => (
              <span key={i}>{i > 0 && <span className="breadcrumb-sep">›</span>}<span className={i === arr.length - 1 ? 'breadcrumb-active' : ''}>{part}</span></span>
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
          <ErrorBoundary fallbackMessage="Terminal crashed"><TerminalPanel /></ErrorBoundary>
        </div>
      </main>

      <div className="resize-handle-v" onMouseDown={handleChatDrag} />
      <div style={{ width: `${chatWidth}px`, flexShrink: 0, display: 'flex' }}>
        <ErrorBoundary fallbackMessage="Chat crashed">
          <ChatPanel currentFileContext={activeTab ? { path: activeTab.path, content: activeTab.content } : null} />
        </ErrorBoundary>
      </div>

      <StatusBar activePath={activeTab?.name || ''} language={getLang(activeTab?.name || '')} cursorPosition={cursorPos} gitBranch={gitBranch} />
      <CommandPalette isOpen={cmdPaletteOpen} onClose={() => setCmdPaletteOpen(false)} onFileSelect={handleFileSelect} />
      <SettingsPanel isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {searchOpen && <SearchPanel isOpen={searchOpen} onClose={() => setSearchOpen(false)} onResultSelect={handleFileSelect} />}
      {helpOpen && <ShortcutsHelp onClose={() => setHelpOpen(false)} />}

      {/* Agent Diff Preview */}
      {diffChanges.filter(c => c.status === 'pending').length > 0 && (
        <DiffPreview
          changes={diffChanges}
          onAccept={(id) => {
            if (window.electronAPI) window.electronAPI.acceptDiff(id);
            setDiffChanges(prev => prev.map(c => c.id === id ? { ...c, status: 'accepted' } : c));
          }}
          onReject={(id) => {
            if (window.electronAPI) window.electronAPI.rejectDiff(id);
            setDiffChanges(prev => prev.map(c => c.id === id ? { ...c, status: 'rejected' } : c));
          }}
          onAcceptAll={() => {
            diffChanges.filter(c => c.status === 'pending').forEach(c => {
              if (window.electronAPI) window.electronAPI.acceptDiff(c.id);
            });
            setDiffChanges(prev => prev.map(c => c.status === 'pending' ? { ...c, status: 'accepted' } : c));
          }}
          onClose={() => setDiffChanges([])}
        />
      )}

      {/* Tab context menu */}
      {tabMenu && (
        <div className="command-palette-overlay" onClick={() => setTabMenu(null)} style={{background: 'transparent'}}>
          <div className="tab-context-menu" style={{left: tabMenu.x, top: tabMenu.y}} onClick={e => e.stopPropagation()}>
            <div className="tab-context-item" onClick={() => {
              const e = new MouseEvent('click'); handleCloseTab(e as any, tabMenu.path); setTabMenu(null);
            }}>Close</div>
            <div className="tab-context-item" onClick={() => {
              setTabs(prev => { const nt = prev.filter(t => t.path === tabMenu.path); setActivePath(tabMenu.path); return nt; });
              setTabMenu(null);
            }}>Close Others</div>
            <div className="tab-context-item" onClick={() => {
              setTabs([]); setActivePath(''); setTabMenu(null);
            }}>Close All</div>
            <div className="tab-context-sep" />
            <div className="tab-context-item" onClick={() => {
              navigator.clipboard.writeText(tabMenu.path); showToast('Path copied', 'success'); setTabMenu(null);
            }}>Copy Path</div>
          </div>
        </div>
      )}

      <ToastContainer />
    </div>
  );
}

export default App;
