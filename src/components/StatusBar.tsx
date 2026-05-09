import React, { useState, useEffect } from 'react';
import { useTheme } from '../ThemeContext';

interface Props {
  activePath: string;
  language: string;
  cursorPosition: { line: number; column: number };
  gitBranch: string;
}

export const StatusBar: React.FC<Props> = ({ activePath, language, cursorPosition, gitBranch }) => {
  const [model, setModel] = useState('');
  const [connected, setConnected] = useState(false);
  const [agentStatus, setAgentStatus] = useState('idle');
  const [ragFiles, setRagFiles] = useState(0);
  const { theme, toggleTheme } = useTheme();

  useEffect(() => {
    const checkConfig = () => {
      if (window.electronAPI) {
        window.electronAPI.getConfig().then(c => {
          const m = c?.model || '';
          setModel(m.includes('/') ? m.split('/').pop() || m : m || 'Not configured');
          setConnected(!!(c?.apiKey && c.apiKey.length > 5 && c?.baseUrl));
        }).catch(() => setConnected(false));
      }
    };
    checkConfig();
    const timer = setInterval(checkConfig, 5000);
    return () => clearInterval(timer);
  }, []);

  // Listen to agent status for real-time indicator
  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.onChatStatus((status: string) => setAgentStatus(status));
    window.electronAPI.onRagStatus((count: number) => setRagFiles(count));
  }, []);

  const getStatusText = () => {
    if (agentStatus === 'idle') return null;
    if (agentStatus === 'thinking') return '🧠 Thinking...';
    if (agentStatus.startsWith('tool:')) {
      const tool = agentStatus.replace('tool:', '');
      const labels: Record<string, string> = {
        web_search: '🔍 Searching', fetch_url: '🌐 Fetching',
        read_file: '📖 Reading', write_file: '✏️ Writing',
        replace_in_file: '🔧 Editing', list_directory: '📁 Listing',
        search_codebase: '🔎 Searching', run_command: '⚡ Running',
      };
      return labels[tool] || `⚙️ ${tool}`;
    }
    return null;
  };

  const fileName = activePath ? activePath.split('/').pop() || '' : 'No file';
  const statusText = getStatusText();

  return (
    <div className="status-bar">
      <div className="status-bar-left">
        <span className="status-item status-branch" title="Git branch">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{verticalAlign: '-1px', marginRight: '4px'}}>
            <circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/>
            <path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" y1="9" x2="6" y2="21"/>
          </svg>
          {gitBranch || 'main'}
        </span>
        <span className="status-item" title={activePath}>{fileName}</span>
        {statusText && (
          <span className="status-item status-agent-active">
            <span className="status-pulse" />
            {statusText}
          </span>
        )}
      </div>
      <div className="status-bar-right">
        <span className="status-item">Ln {cursorPosition.line}, Col {cursorPosition.column}</span>
        <span className="status-item status-lang">{language}</span>
        <span className="status-item status-encoding">UTF-8</span>
        <span className="status-item status-theme" onClick={toggleTheme} title="Toggle theme (⇧⌘L)" style={{cursor: 'pointer'}}>
          {theme === 'dark' ? (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
          )}
        </span>
        <span className={`status-item status-model ${connected ? 'connected' : 'disconnected'}`}
          title={connected ? `Connected: ${model}` : 'Not connected — click to open Settings'}
          onClick={() => window.dispatchEvent(new CustomEvent('open-settings'))}
          style={{ cursor: 'pointer' }}>
          <span className="status-dot" />
          {model || 'No model'}
        </span>
        {ragFiles > 0 && (
          <span className="status-item" title={`RAG: ${ragFiles} project files indexed for context retrieval`} style={{ opacity: 0.7 }}>
            🧠 {ragFiles}
          </span>
        )}
        <span className="status-item status-version">🐬 DSME v2.0</span>
      </div>
    </div>
  );
};
