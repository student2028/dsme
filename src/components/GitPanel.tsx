import React, { useState, useEffect, useCallback } from 'react';
import { showToast } from './Toast';

interface GitFile {
  status: string;
  path: string;
  staged: boolean;
}

export const GitPanel: React.FC = () => {
  const [files, setFiles] = useState<GitFile[]>([]);
  const [commitMsg, setCommitMsg] = useState('');
  const [branch, setBranch] = useState('');
  const [isCommitting, setIsCommitting] = useState(false);

  const refresh = useCallback(async () => {
    if (!window.electronAPI) return;
    try {
      setBranch(await window.electronAPI.getGitBranch());
    } catch {}

    // Fetch git status via searchCodebase workaround — we'll parse it
    try {
      const b = await window.electronAPI.getGitBranch();
      setBranch(b);
      const statusRaw = await window.electronAPI.getGitStatus();
      setFiles(statusRaw);
    } catch {}
  }, []);

  useEffect(() => {
    refresh();
    const i = setInterval(refresh, 5000);
    return () => clearInterval(i);
  }, [refresh]);

  const handleCommit = async () => {
    if (!commitMsg.trim() || !window.electronAPI) return;
    setIsCommitting(true);
    try {
      await window.electronAPI.gitCommit(commitMsg.trim());
      setCommitMsg('');
      showToast('Committed successfully', 'success');
      refresh();
    } catch (e: any) {
      showToast(`Commit failed: ${e.message}`, 'error');
    }
    setIsCommitting(false);
  };

  const getStatusIcon = (s: string) => {
    if (s.includes('M')) return { icon: 'M', color: '#eab308' };
    if (s.includes('A')) return { icon: 'A', color: '#22c55e' };
    if (s.includes('D')) return { icon: 'D', color: '#ff4444' };
    if (s.includes('?')) return { icon: 'U', color: '#22c55e' };
    if (s.includes('R')) return { icon: 'R', color: '#00ccff' };
    return { icon: '?', color: 'var(--text-secondary)' };
  };

  return (
    <div className="git-panel">
      <div className="git-panel-header">
        [ SOURCE CONTROL ]
        {branch && <span className="git-branch-name">⎇ {branch}</span>}
      </div>

      {/* Commit input */}
      <div className="git-commit-area">
        <input
          className="git-commit-input"
          placeholder="Commit message..."
          value={commitMsg}
          onChange={e => setCommitMsg(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleCommit(); }}
          disabled={isCommitting}
        />
        <button
          className="git-commit-btn"
          onClick={handleCommit}
          disabled={!commitMsg.trim() || isCommitting}
        >
          {isCommitting ? '...' : '✓'}
        </button>
      </div>

      {/* Changed files */}
      <div className="git-file-list">
        {files.length === 0 ? (
          <div className="git-empty">No changes detected</div>
        ) : (
          files.map((f, i) => {
            const { icon, color } = getStatusIcon(f.status);
            return (
              <div key={i} className="git-file-item">
                <span className="git-file-status" style={{ color }}>{icon}</span>
                <span className="git-file-name">{f.path}</span>
              </div>
            );
          })
        )}
      </div>

      <div className="git-actions">
        <button className="git-action-btn" onClick={refresh}>↻ Refresh</button>
      </div>
    </div>
  );
};
