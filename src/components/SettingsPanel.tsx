import React, { useState, useEffect, useCallback } from 'react';
import { useTheme } from '../ThemeContext';

export const SettingsPanel: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [model, setModel] = useState('deepseek-chat');
  const [baseUrl, setBaseUrl] = useState('https://api.deepseek.com/v1');

  const [saved, setSaved] = useState(false);
  const { theme, toggleTheme } = useTheme();

  useEffect(() => {
    if (isOpen && window.electronAPI) {
      window.electronAPI.getConfig().then((config: any) => {
        setApiKey(config.apiKey || '');
        setModel(config.model || 'deepseek-chat');
        setBaseUrl(config.baseUrl || 'https://api.siliconflow.cn/v1');
      });
      setShowKey(false);
    }
  }, [isOpen]);

  const handleSave = useCallback(async () => {
    if (window.electronAPI) {
      await window.electronAPI.saveConfig({ apiKey, model, baseUrl });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  }, [apiKey, model, baseUrl]);

  // Keyboard shortcuts
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); handleSave(); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, onClose, handleSave]);

  if (!isOpen) return null;

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={e => e.stopPropagation()}>
        <div className="settings-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent-color)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          Settings
        </div>

        {/* Theme Section */}
        <div className="settings-section-label">Appearance</div>
        <div className="settings-group">
          <label className="settings-label">Theme</label>
          <div className="settings-theme-toggle">
            <button className={`settings-theme-btn ${theme === 'light' ? 'active' : ''}`}
              onClick={() => theme !== 'light' && toggleTheme()}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/>
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                <line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/>
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
              </svg>
              Light
            </button>
            <button className={`settings-theme-btn ${theme === 'dark' ? 'active' : ''}`}
              onClick={() => theme !== 'dark' && toggleTheme()}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
              </svg>
              Dark
            </button>
          </div>
        </div>

        {/* Engine Info */}
        <div className="settings-section-label">Engine</div>
        <div className="settings-group">
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
            ⚡ Vercel AI SDK — streamText + Zod tool schemas
          </div>
        </div>

        {/* API Section */}
        <div className="settings-section-label">API Configuration</div>
        <div className="settings-group">
          <label className="settings-label">API Key</label>
          <div style={{ position: 'relative' }}>
            <input className="settings-input" type={showKey ? 'text' : 'password'}
              value={apiKey} onChange={e => setApiKey(e.target.value)}
              placeholder="sk-..." spellCheck="false" style={{ paddingRight: '40px' }} />
            <button onClick={() => setShowKey(!showKey)}
              style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)',
                background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)',
                padding: '4px', borderRadius: '4px', fontSize: '11px' }}
              title={showKey ? 'Hide' : 'Show'}>
              {showKey ? '🙈' : '👁️'}
            </button>
          </div>
        </div>

        <div className="settings-group">
          <label className="settings-label">Model</label>
          <select className="settings-input" value={model} onChange={e => setModel(e.target.value)}>
            <optgroup label="DeepSeek">
              <option value="deepseek-ai/DeepSeek-V4-Flash">DeepSeek-V4-Flash (Default)</option>
              <option value="deepseek-ai/DeepSeek-V3.2">DeepSeek-V3.2</option>
              <option value="deepseek-ai/DeepSeek-OCR">DeepSeek-OCR</option>
            </optgroup>
            <optgroup label="Other Models">
              <option value="Pro/zai-org/GLM-5">GLM-5</option>
              <option value="Pro/MiniMaxAI/MiniMax-M2.5">MiniMax-M2.5</option>
              <option value="Pro/moonshotai/Kimi-K2.5">Kimi-K2.5</option>
              <option value="Qwen/Qwen3.5-4B">Qwen3.5-4B</option>
              <option value="Qwen/Qwen3-8B">Qwen3-8B</option>
              <option value="PaddlePaddle/PaddleOCR-VL-1.5">PaddleOCR-VL-1.5</option>
            </optgroup>
          </select>
        </div>

        <div className="settings-group">
          <label className="settings-label">Base URL</label>
          <input className="settings-input" value={baseUrl} onChange={e => setBaseUrl(e.target.value)}
            placeholder="https://api.deepseek.com/v1" spellCheck="false" />
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
            Compatible with any OpenAI-format API endpoint
          </div>
        </div>

        <div className="settings-actions">
          <button className={`settings-save-btn ${saved ? 'saved' : ''}`} onClick={handleSave}>
            {saved ? '✓ Saved' : 'Save  ⌘S'}
          </button>
          <button className="settings-cancel-btn" onClick={onClose}>Close  Esc</button>
        </div>
      </div>
    </div>
  );
};
