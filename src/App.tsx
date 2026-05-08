import React, { useState, useEffect, useCallback } from 'react';
import { ChatPanel } from './components/ChatPanel';
import { EditorPanel } from './components/EditorPanel';
import { FileTree } from './components/FileTree';
import { TerminalPanel } from './components/TerminalPanel';
import { StatusBar } from './components/StatusBar';
import { CommandPalette } from './components/CommandPalette';
import { SettingsPanel } from './components/SettingsPanel';
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
  const [terminalHeight, setTerminalHeight] = useState(250);
  const [chatWidth, setChatWidth] = useState(450);
  const [gitBranch, setGitBranch] = useState('');

  const activeTab = tabs.find(t => t.path === activePath);

  // Fetch git branch
  useEffect(() => {
    const fetchBranch = () => {
      if (window.electronAPI) {
        window.electronAPI.getGitBranch().then(setGitBranch);
      }
    };
    fetchBranch();
    const interval = setInterval(fetchBranch, 10000);
    return () => clearInterval(interval);
  }, []);

  const handleFileSelect = useCallback(async (filepath: string, name: string) => {
    if (tabs.find(t => t.path === filepath)) {
      setActivePath(filepath);
      return;
    }
    if (window.electronAPI) {
      const content = await window.electronAPI.readFile(filepath);
      setTabs(prev => [...prev, { path: filepath, name, content, isDirty: false }]);
      setActivePath(filepath);
    }
  }, [tabs]);

  const handleSave = useCallback(() => {
    const tab = tabs.find(t => t.path === activePath);
    if (tab && tab.isDirty && window.electronAPI) {
      window.electronAPI.writeFile(tab.path, tab.content);
      setTabs(prev => prev.map(t => t.path === activePath ? { ...t, isDirty: false } : t));
    }
  }, [tabs, activePath]);

  const handleEditorChange = useCallback((newContent: string | undefined) => {
    if (newContent !== undefined) {
      setTabs(prev => prev.map(tab =>
        tab.path === activePath ? { ...tab, content: newContent, isDirty: true } : tab
      ));
    }
  }, [activePath]);

  const handleCloseTab = useCallback((e: React.MouseEvent, pathToClose: string) => {
    e.stopPropagation();
    setTabs(prev => {
      const newTabs = prev.filter(t => t.path !== pathToClose);
      if (activePath === pathToClose) {
        setActivePath(newTabs.length > 0 ? newTabs[newTabs.length - 1].path : '');
      }
      return newTabs;
    });
  }, [activePath]);

  // Live file reload from agent
  useEffect(() => {
    if (window.electronAPI) {
      window.electronAPI.onFileChanged(async (filepath: string) => {
        const newContent = await window.electronAPI.readFile(filepath);
        setTabs(prev => prev.map(tab =>
          tab.path === filepath ? { ...tab, content: newContent, isDirty: false } : tab
        ));
      });
    }
  }, []);

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
        e.preventDefault();
        setCmdPaletteOpen(prev => !prev);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'w') {
        e.preventDefault();
        if (activePath) {
          setTabs(prev => {
            const newTabs = prev.filter(t => t.path !== activePath);
            setActivePath(newTabs.length > 0 ? newTabs[newTabs.length - 1].path : '');
            return newTabs;
          });
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        setSettingsOpen(prev => !prev);
      }
    };
    window.addEventListener('keydown', handler);
    const saveHandler = () => handleSave();
    window.addEventListener('editor-save', saveHandler);
    return () => {
      window.removeEventListener('keydown', handler);
      window.removeEventListener('editor-save', saveHandler);
    };
  }, [handleSave, activePath]);

  // Resize handlers
  const handleTerminalDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = terminalHeight;
    const onMove = (ev: MouseEvent) => setTerminalHeight(Math.max(80, Math.min(500, startH + (startY - ev.clientY))));
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [terminalHeight]);

  const handleChatDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = chatWidth;
    const onMove = (ev: MouseEvent) => setChatWidth(Math.max(300, Math.min(700, startW + (startX - ev.clientX))));
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [chatWidth]);

  const getLanguage = (name: string) => {
    const ext = name?.split('.').pop()?.toLowerCase() || '';
    const map: Record<string, string> = {
      'ts': 'TypeScript', 'tsx': 'TypeScript', 'js': 'JavaScript', 'jsx': 'JavaScript',
      'css': 'CSS', 'html': 'HTML', 'json': 'JSON', 'md': 'Markdown',
      'py': 'Python', 'kt': 'Kotlin', 'dart': 'Dart', 'swift': 'Swift',
      'go': 'Go', 'rs': 'Rust', 'java': 'Java', 'sh': 'Shell',
    };
    return map[ext] || ext.toUpperCase() || 'TEXT';
  };

  return (
    <div className="app-container">
      <FileTree onFileSelect={handleFileSelect} />

      <main className="main-content">
        <div className="tab-bar">
          {tabs.map(tab => (
            <div key={tab.path} onClick={() => setActivePath(tab.path)} className={`tab-item ${activePath === tab.path ? 'active' : ''}`}>
              <span className="tab-name">{tab.name}{tab.isDirty ? ' ●' : ''}</span>
              <span className="tab-close" onClick={(e) => handleCloseTab(e, tab.path)}>×</span>
            </div>
          ))}
          {tabs.length === 0 && <div className="tab-empty">Ctrl+P search · Ctrl+, settings</div>}
        </div>

        <EditorPanel
          content={activeTab ? activeTab.content : ''}
          onChange={handleEditorChange}
          filename={activeTab ? activeTab.name : ''}
          onCursorChange={(line, col) => setCursorPos({ line, column: col })}
        />

        <div className="resize-handle-h" onMouseDown={handleTerminalDrag} />
        <div style={{ height: `${terminalHeight}px`, flexShrink: 0 }}>
          <TerminalPanel />
        </div>
      </main>

      <div className="resize-handle-v" onMouseDown={handleChatDrag} />
      <div style={{ width: `${chatWidth}px`, flexShrink: 0, display: 'flex' }}>
        <ChatPanel />
      </div>

      <StatusBar
        activePath={activeTab?.name || ''}
        language={getLanguage(activeTab?.name || '')}
        cursorPosition={cursorPos}
        gitBranch={gitBranch}
      />

      <CommandPalette isOpen={cmdPaletteOpen} onClose={() => setCmdPaletteOpen(false)} onFileSelect={handleFileSelect} />
      <SettingsPanel isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

export default App;
