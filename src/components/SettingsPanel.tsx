import React, { useState, useEffect } from 'react';

export const SettingsPanel: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('deepseek-chat');
  const [baseUrl, setBaseUrl] = useState('https://api.deepseek.com/v1');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (isOpen && window.electronAPI) {
      window.electronAPI.getConfig().then((config: any) => {
        setApiKey(config.apiKey || '');
        setModel(config.model || 'deepseek-chat');
        setBaseUrl(config.baseUrl || 'https://api.deepseek.com/v1');
      });
    }
  }, [isOpen]);

  const handleSave = async () => {
    if (window.electronAPI) {
      await window.electronAPI.saveConfig({ apiKey, model, baseUrl });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={e => e.stopPropagation()}>
        <div className="settings-title">[ CONFIGURATION ]</div>

        <div className="settings-group">
          <label className="settings-label">API KEY</label>
          <input
            className="settings-input"
            type="password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder="sk-..."
            spellCheck="false"
          />
        </div>

        <div className="settings-group">
          <label className="settings-label">MODEL</label>
          <select className="settings-input" value={model} onChange={e => setModel(e.target.value)}>
            <option value="deepseek-chat">deepseek-chat</option>
            <option value="deepseek-coder">deepseek-coder</option>
            <option value="deepseek-reasoner">deepseek-reasoner</option>
          </select>
        </div>

        <div className="settings-group">
          <label className="settings-label">BASE URL</label>
          <input
            className="settings-input"
            value={baseUrl}
            onChange={e => setBaseUrl(e.target.value)}
            placeholder="https://api.deepseek.com/v1"
            spellCheck="false"
          />
        </div>

        <div className="settings-actions">
          <button className="settings-save-btn" onClick={handleSave}>
            {saved ? '✓ SAVED' : 'SAVE CONFIG'}
          </button>
          <button className="settings-cancel-btn" onClick={onClose}>CLOSE</button>
        </div>
      </div>
    </div>
  );
};
