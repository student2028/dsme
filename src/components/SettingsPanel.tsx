import React, { useState, useEffect, useCallback } from 'react';
import { useTheme } from '../ThemeContext';

interface ProviderConfig {
  name: string;
  apiKey: string;
  baseUrl: string;
  models: string[];
}

export const SettingsPanel: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [activeProvider, setActiveProvider] = useState('Volcengine');
  const [model, setModel] = useState('');
  const [maxOutputTokens, setMaxOutputTokens] = useState(16384);
  const [maxContextTokens, setMaxContextTokens] = useState(128000);
  const [maxToolSteps, setMaxToolSteps] = useState(200);
  const [saved, setSaved] = useState(false);
  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({});
  const { theme, toggleTheme } = useTheme();

  useEffect(() => {
    if (isOpen && window.electronAPI) {
      window.electronAPI.getConfig().then((config) => {
        setProviders(config.providers || []);
        setActiveProvider(config.activeProvider || 'Volcengine');
        setModel(config.model || '');
        setMaxOutputTokens(config.maxOutputTokens || 16384);
        setMaxContextTokens(config.maxContextTokens || 128000);
        setMaxToolSteps(config.maxToolSteps || 200);
        setShowKeys({});
      }).catch(() => {});
    }
  }, [isOpen]);

  const currentProvider = providers.find(p => p.name === activeProvider) || providers[0];
  const currentModels = currentProvider?.models || [];

  const handleProviderSwitch = (name: string) => {
    setActiveProvider(name);
    const p = providers.find(pp => pp.name === name);
    if (p && p.models.length > 0) {
      setModel(p.models[0]);
    }
  };

  const handleProviderKeyChange = (providerName: string, newKey: string) => {
    setProviders(prev => prev.map(p =>
      p.name === providerName ? { ...p, apiKey: newKey } : p
    ));
  };

  const handleSave = useCallback(async () => {
    if (window.electronAPI) {
      await window.electronAPI.saveConfig({ providers, activeProvider, model, maxOutputTokens, maxContextTokens, maxToolSteps });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  }, [providers, activeProvider, model, maxOutputTokens, maxContextTokens, maxToolSteps]);

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

        <div className="settings-panel-scroll" role="region" aria-label="Settings form">

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

        {/* Provider Selector */}
        <div className="settings-section-label">API Provider</div>
        <div className="settings-group">
          <div className="provider-tabs">
            {providers.map(p => (
              <button
                key={p.name}
                className={`provider-tab ${activeProvider === p.name ? 'active' : ''}`}
                onClick={() => handleProviderSwitch(p.name)}
              >
                {p.name === 'SiliconFlow' && '🚀'}
                {p.name === 'Google' && '🔮'}
                {p.name === 'Volcengine' && '🌋'}
                {p.name === 'DeepSeek' && '🐳'}
                {!['SiliconFlow', 'Google', 'Volcengine', 'DeepSeek'].includes(p.name) && '⚡'}
                {' '}{p.name}
              </button>
            ))}
          </div>
        </div>

        {/* API Key for active provider */}
        {currentProvider && (
          <>
            <div className="settings-group">
              <label className="settings-label">{currentProvider.name} API Key</label>
              <div style={{ position: 'relative' }}>
                <input className="settings-input" type={showKeys[currentProvider.name] ? 'text' : 'password'}
                  value={currentProvider.apiKey} onChange={e => handleProviderKeyChange(currentProvider.name, e.target.value)}
                  placeholder="sk-..." spellCheck="false" style={{ paddingRight: '40px' }} />
                <button onClick={() => setShowKeys(prev => ({ ...prev, [currentProvider.name]: !prev[currentProvider.name] }))}
                  style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)',
                    background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)',
                    padding: '4px', borderRadius: '4px', fontSize: '11px' }}
                  title={showKeys[currentProvider.name] ? 'Hide' : 'Show'}>
                  {showKeys[currentProvider.name] ? '🙈' : '👁️'}
                </button>
              </div>
            </div>

            <div className="settings-group">
              <label className="settings-label">Base URL</label>
              <input className="settings-input" value={currentProvider.baseUrl} readOnly
                style={{ opacity: 0.7, cursor: 'default' }} />
            </div>
          </>
        )}

        {/* Model Selector */}
        <div className="settings-section-label">Model</div>
        <div className="settings-group">
          <div className="model-grid">
            {currentModels.map(m => (
              <button
                key={m}
                className={`model-chip ${model === m ? 'active' : ''}`}
                onClick={() => setModel(m)}
              >
                {model === m && <span className="model-chip-check">✓</span>}
                {m.split('/').pop()}
              </button>
            ))}
          </div>
        </div>

        <div className="settings-section-label">Token Limits</div>
        <div className="settings-group">
          <label className="settings-label">Max Output Tokens</label>
          <input
            className="settings-input"
            type="number"
            min="1"
            step="1"
            value={maxOutputTokens}
            onChange={e => setMaxOutputTokens(Math.max(1, Number(e.target.value) || 1))}
          />
        </div>
        <div className="settings-group">
          <label className="settings-label">Max Context Tokens</label>
          <input
            className="settings-input"
            type="number"
            min="1"
            step="1"
            value={maxContextTokens}
            onChange={e => setMaxContextTokens(Math.max(1, Number(e.target.value) || 1))}
          />
        </div>
        <div className="settings-group">
          <label className="settings-label">Max Tool Steps <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>(每轮对话最大工具调用次数)</span></label>
          <input
            className="settings-input"
            type="number"
            min="10"
            max="500"
            step="10"
            value={maxToolSteps}
            onChange={e => setMaxToolSteps(Math.max(10, Math.min(500, Number(e.target.value) || 200)))}
          />
        </div>

        {/* Engine Info */}
        <div className="settings-section-label">Engine</div>
        <div className="settings-group">
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
            ⚡ Vercel AI SDK — streamText + Zod tool schemas
          </div>
        </div>

        {/* Cookie Sync — macOS only, with Chrome Profile selector */}
        {navigator.platform.toLowerCase().includes('mac') && (
          <ChromeProfileSync />
        )}

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

/** Chrome Profile selector + cookie sync sub-component. */
const ChromeProfileSync: React.FC = () => {
  const [profiles, setProfiles] = useState<{ dirName: string; name: string; email: string }[]>([]);
  const [selectedProfile, setSelectedProfile] = useState('Default');
  const [syncing, setSyncing] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    window.electronAPI?.getChromeProfiles?.().then((p) => {
      if (p && p.length > 0) {
        setProfiles(p);
        setSelectedProfile(p[0].dirName);
      }
    }).catch(() => {});
  }, []);

  const handleSync = async () => {
    setSyncing(true);
    setStatus(null);
    try {
      const res = await window.electronAPI?.syncChromeCookies?.(selectedProfile);
      if (res?.success) {
        const label = profiles.find(p => p.dirName === selectedProfile)?.name || selectedProfile;
        setStatus({ ok: true, msg: `✅ 从 "${label}" 同步了 ${res.count} 个 Cookie` });
      } else {
        setStatus({ ok: false, msg: `❌ 同步失败: ${res?.error || 'Unknown error'}` });
      }
    } catch (e: unknown) {
      setStatus({ ok: false, msg: `❌ ${e instanceof Error ? e.message : String(e)}` });
    }
    setSyncing(false);
  };

  return (
    <>
      <div className="settings-section-label">Browser</div>
      <div className="settings-group">
        <label className="settings-label">Chrome Profile</label>
        {profiles.length > 0 ? (
          <select
            className="settings-input"
            value={selectedProfile}
            onChange={e => { setSelectedProfile(e.target.value); setStatus(null); }}
            style={{ cursor: 'pointer' }}
          >
            {profiles.map(p => (
              <option key={p.dirName} value={p.dirName}>
                {p.name}{p.email ? ` (${p.email})` : ''}{p.dirName === 'Default' ? ' ★' : ''}
              </option>
            ))}
          </select>
        ) : (
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>未检测到 Chrome Profile</div>
        )}
      </div>
      <div className="settings-group">
        <button
          className="settings-save-btn"
          style={{ width: '100%', opacity: syncing ? 0.6 : 1 }}
          disabled={syncing || profiles.length === 0}
          onClick={handleSync}
        >
          {syncing ? '⏳ 同步中...' : '🍪 同步 Cookie'}
        </button>
        {status && (
          <div style={{ fontSize: '12px', color: status.ok ? 'var(--accent-color)' : '#f87171', marginTop: '6px' }}>
            {status.msg}
          </div>
        )}
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
          从选定的 Chrome Profile 同步登录状态，让浏览器面板自动保持登录。
        </div>
      </div>
    </>
  );
};
