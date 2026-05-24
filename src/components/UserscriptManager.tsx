import React, { useState, useEffect } from 'react';
import type { Userscript } from '../global';

interface UserscriptManagerProps {
  currentUrl: string;
  onClose: () => void;
}

export const UserscriptManager: React.FC<UserscriptManagerProps> = ({ currentUrl, onClose }) => {
  const [scripts, setScripts] = useState<Userscript[]>([]);
  const [editingScript, setEditingScript] = useState<Userscript | null>(null);

  useEffect(() => {
    window.electronAPI?.getConfig().then(config => {
      setScripts(config.userscripts || []);
    });
  }, []);

  const handleSave = async (script: Userscript) => {
    const isNew = !script.id;
    const newScripts = isNew 
      ? [...scripts, { ...script, id: Date.now().toString() }]
      : scripts.map(s => s.id === script.id ? script : s);
      
    setScripts(newScripts);
    await window.electronAPI?.saveConfig({ userscripts: newScripts });
    setEditingScript(null);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this script?')) return;
    const newScripts = scripts.filter(s => s.id !== id);
    setScripts(newScripts);
    await window.electronAPI?.saveConfig({ userscripts: newScripts });
  };

  const handleToggle = async (script: Userscript) => {
    const newScripts = scripts.map(s => s.id === script.id ? { ...s, enabled: !s.enabled } : s);
    setScripts(newScripts);
    await window.electronAPI?.saveConfig({ userscripts: newScripts });
  };

  const handleSearchGreasyFork = () => {
    try {
      const url = new URL(currentUrl);
      let domain = url.hostname;
      if (domain.startsWith('www.')) domain = domain.substring(4);
      if (domain) {
        window.electronAPI?.browserNavigateTo(`https://greasyfork.org/zh-CN/scripts/by-site/${domain}`);
        onClose();
      }
    } catch {
      // invalid url, default to home
      window.electronAPI?.browserNavigateTo(`https://greasyfork.org/zh-CN/scripts`);
      onClose();
    }
  };

  const handleAiGenerate = () => {
    try {
      const url = new URL(currentUrl);
      const domain = url.hostname;
      const requirement = prompt(`请输入您希望 AI 帮您在 ${domain} 上实现的功能（例如：去掉右下角的浮窗广告）：`);
      if (requirement && requirement.trim()) {
        window.electronAPI?.sendChatMessage(`我在 ${domain} 遇到问题：${requirement}。请帮我写一个 Tampermonkey 脚本并直接保存到我的内置管理器里！`);
        onClose();
      }
    } catch {
      alert('无法获取当前网页域名，请确保您在一个有效的网页中。');
    }
  };

  return (
    <div className="userscript-modal-overlay">
      <div className="userscript-modal">
        <div className="userscript-modal-header">
          <h2>🐒 篡改猴 (Tampermonkey)</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>

        {editingScript ? (
          <div className="userscript-editor">
            <div className="editor-field">
              <label>Script Name</label>
              <input 
                value={editingScript.name} 
                onChange={e => setEditingScript({ ...editingScript, name: e.target.value })}
                placeholder="e.g. My Awesome Script"
              />
            </div>
            <div className="editor-field">
              <label>Match URL (Glob)</label>
              <input 
                value={editingScript.match} 
                onChange={e => setEditingScript({ ...editingScript, match: e.target.value })}
                placeholder="e.g. *://*.github.com/*"
              />
            </div>
            <div className="editor-field code-field">
              <label>JavaScript Code</label>
              <textarea 
                value={editingScript.code} 
                onChange={e => setEditingScript({ ...editingScript, code: e.target.value })}
                placeholder="console.log('Hello World!');"
                spellCheck={false}
              />
            </div>
            <div className="editor-actions">
              <button onClick={() => setEditingScript(null)}>Cancel</button>
              <button className="primary" onClick={() => handleSave(editingScript)}>Save Script</button>
            </div>
          </div>
        ) : (
          <div className="userscript-list">
            <div className="userscript-actions-row">
              <button 
                className="new-script-btn" 
                onClick={() => setEditingScript({ id: '', name: 'New Script', match: '*://*/*', code: '// Your code here\n', enabled: true })}
              >
                + Create New Script
              </button>
              <button 
                className="search-greasyfork-btn" 
                onClick={handleSearchGreasyFork}
                style={{ marginLeft: '10px', background: '#333', color: '#fff' }}
              >
                🔍 搜索当前网站脚本
              </button>
              <button 
                className="ai-generate-btn" 
                onClick={handleAiGenerate}
                style={{ marginLeft: '10px', background: 'linear-gradient(90deg, #4b6cb7 0%, #182848 100%)', color: '#fff' }}
              >
                🤖 AI 专属定制脚本
              </button>
            </div>
            
            {scripts.length === 0 ? (
              <div className="empty-state">No scripts installed yet.</div>
            ) : (
              scripts.map(s => (
                <div key={s.id} className={`userscript-item ${s.enabled ? 'enabled' : 'disabled'}`}>
                  <div className="userscript-info">
                    <div className="userscript-name">{s.name}</div>
                    <div className="userscript-match">{s.match}</div>
                  </div>
                  <div className="userscript-controls">
                    <button onClick={() => handleToggle(s)}>
                      {s.enabled ? '🟢 On' : '⚪️ Off'}
                    </button>
                    <button onClick={() => setEditingScript(s)}>✏️ Edit</button>
                    <button onClick={() => handleDelete(s.id)}>🗑️ Del</button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
};
