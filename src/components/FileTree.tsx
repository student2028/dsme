import React, { useEffect, useState, useCallback } from 'react';

interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  gitStatus?: 'modified' | 'untracked' | 'clean';
}

interface Props {
  onFileSelect: (filepath: string, name: string) => void;
}

interface TreeNode extends FileNode {
  children?: TreeNode[];
  isExpanded?: boolean;
  depth: number;
}

export const FileTree: React.FC<Props> = ({ onFileSelect }) => {
  const [nodes, setNodes] = useState<TreeNode[]>([]);
  const [workspaceName, setWorkspaceName] = useState<string>('PROJECT');
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());

  const fetchTree = useCallback(async (dir?: string) => {
    if (!window.electronAPI) return;
    const rawNodes = await window.electronAPI.getFileTree(dir);
    return rawNodes;
  }, []);

  const loadRootTree = useCallback(async () => {
    const rawNodes = await fetchTree();
    if (rawNodes) {
      setNodes(rawNodes.map(n => ({ ...n, depth: 0 })));
    }
  }, [fetchTree]);

  useEffect(() => {
    loadRootTree();
    const interval = setInterval(loadRootTree, 8000);
    return () => clearInterval(interval);
  }, [loadRootTree]);

  const toggleDir = async (node: TreeNode) => {
    const key = node.path;
    const newExpanded = new Set(expandedDirs);

    if (newExpanded.has(key)) {
      newExpanded.delete(key);
      setExpandedDirs(newExpanded);
      // Remove children
      setNodes(prev => prev.filter(n => !n.path.startsWith(key + '/')));
    } else {
      newExpanded.add(key);
      setExpandedDirs(newExpanded);
      // Load children
      if (window.electronAPI) {
        const children = await window.electronAPI.getFileTree(key);
        if (children) {
          const childNodes: TreeNode[] = children.map(c => ({ ...c, depth: node.depth + 1 }));
          // Insert after the parent
          setNodes(prev => {
            const idx = prev.findIndex(n => n.path === key);
            if (idx === -1) return prev;
            const before = prev.slice(0, idx + 1);
            // Find the next sibling at same or lower depth
            let endIdx = idx + 1;
            while (endIdx < prev.length && prev[endIdx].depth > node.depth) {
              endIdx++;
            }
            const after = prev.slice(endIdx);
            return [...before, ...childNodes, ...after];
          });
        }
      }
    }
  };

  const handleOpenWorkspace = async () => {
    if (window.electronAPI) {
      const path = await window.electronAPI.openWorkspace();
      if (path) {
        setWorkspaceName(path.split('/').pop() || 'PROJECT');
        setExpandedDirs(new Set());
        loadRootTree();
      }
    }
  };

  const getStatusColor = (status?: string) => {
    if (status === 'modified') return '#eab308';
    if (status === 'untracked') return '#22c55e';
    return 'var(--text-primary)';
  };

  const getStatusIndicator = (status?: string) => {
    if (status === 'modified') return 'M';
    if (status === 'untracked') return 'U';
    return '';
  };

  const getFileIcon = (name: string) => {
    const ext = name.split('.').pop()?.toLowerCase() || '';
    const icons: Record<string, string> = {
      'ts': '⟨⟩', 'tsx': '⟨⟩', 'js': '◇', 'jsx': '◇',
      'css': '◆', 'html': '◈', 'json': '{}',
      'md': '¶', 'py': '⊕', 'rs': '⊗', 'go': '◎',
      'kt': '◉', 'dart': '◊', 'swift': '⊙', 'java': '☕',
      'sh': '$', 'yaml': '≡', 'yml': '≡', 'toml': '≡',
      'sql': '⊞', 'xml': '≤≥', 'svg': '▲', 'png': '▣',
      'jpg': '▣', 'gif': '▣', 'lock': '🔒',
    };
    return icons[ext] || '·';
  };

  return (
    <div className="filetree-panel">
      <div className="filetree-header">
        <span>[ {workspaceName.toUpperCase()} ]</span>
        <button className="filetree-open-btn" onClick={handleOpenWorkspace}>OPEN</button>
      </div>
      <div className="filetree-list">
        {nodes.map(node => (
          <div
            key={node.path}
            className="filetree-item"
            onClick={() => node.isDirectory ? toggleDir(node) : onFileSelect(node.path, node.name)}
            style={{
              paddingLeft: `${16 + node.depth * 16}px`,
              color: getStatusColor(node.gitStatus),
            }}
          >
            <span className="filetree-icon">
              {node.isDirectory 
                ? (expandedDirs.has(node.path) ? '▼' : '▶') 
                : getFileIcon(node.name)
              }
            </span>
            <span className="filetree-name">{node.name}</span>
            {getStatusIndicator(node.gitStatus) && (
              <span className="filetree-git-badge">{getStatusIndicator(node.gitStatus)}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
