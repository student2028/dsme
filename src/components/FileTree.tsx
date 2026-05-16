import React, { useEffect, useState, useCallback } from 'react';

interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  gitStatus?: 'modified' | 'untracked' | 'clean';
}

interface Props {
  onFileSelect: (filepath: string, name: string) => void;
  activePath?: string;
}

interface TreeNode extends FileNode {
  children?: TreeNode[];
  isExpanded?: boolean;
  depth: number;
}

export const FileTree: React.FC<Props> = ({ onFileSelect, activePath }) => {
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
    const interval = setInterval(loadRootTree, 15000);
    const unsubFile =
      window.electronAPI?.onFileChanged(() => {
        setTimeout(loadRootTree, 500);
      });
    return () => {
      clearInterval(interval);
      unsubFile?.();
    };
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

  const getFileIcon = (name: string): string => {
    const ext = name.split('.').pop()?.toLowerCase() || '';
    const icons: Record<string, string> = {
      'ts': 'TS', 'tsx': 'TX', 'js': 'JS', 'jsx': 'JX',
      'css': '#', 'scss': '#', 'less': '#',
      'html': '<>', 'json': '{}',
      'md': 'M↓', 'py': 'Py', 'rs': 'Rs', 'go': 'Go',
      'kt': 'Kt', 'dart': 'Da', 'swift': 'Sw', 'java': 'Jv',
      'sh': '$_', 'zsh': '$_', 'bash': '$_',
      'yaml': '≡', 'yml': '≡', 'toml': '≡', 'env': '≡',
      'sql': 'SQ', 'xml': '<>', 'svg': '◇',
      'png': '▪', 'jpg': '▪', 'jpeg': '▪', 'gif': '▪', 'webp': '▪', 'ico': '▪',
      'lock': '🔒', 'gitignore': '⊘',
      'c': 'C', 'cpp': 'C+', 'h': 'H',
      'vue': 'V', 'svelte': 'S',
    };
    return icons[ext] || '·';
  };

  const getFileIconColor = (name: string): string => {
    const ext = name.split('.').pop()?.toLowerCase() || '';
    const colors: Record<string, string> = {
      'ts': '#3178c6', 'tsx': '#3178c6',
      'js': '#f7df1e', 'jsx': '#f7df1e',
      'css': '#1572b6', 'scss': '#cc6699', 'less': '#1d365d',
      'html': '#e34f26', 'json': '#a8b034',
      'md': '#519aba', 'py': '#3776ab', 'rs': '#dea584', 'go': '#00add8',
      'kt': '#a97bff', 'swift': '#fa7343', 'java': '#007396',
      'sh': '#89e051', 'zsh': '#89e051',
      'yaml': '#cb171e', 'yml': '#cb171e', 'toml': '#9c4121',
      'sql': '#e38c00', 'xml': '#e34f26', 'svg': '#ffb13b',
      'png': '#a074c4', 'jpg': '#a074c4', 'gif': '#a074c4',
      'vue': '#42b883', 'svelte': '#ff3e00',
      'c': '#555555', 'cpp': '#f34b7d', 'h': '#555555',
    };
    return colors[ext] || 'var(--text-muted)';
  };

  return (
    <div className="filetree-panel">
      <div className="filetree-header">
        <span>{workspaceName.toUpperCase()}</span>
        <button className="filetree-open-btn" onClick={handleOpenWorkspace}>OPEN</button>
      </div>
      <div className="filetree-list">
        {nodes.map(node => (
          <div
            key={node.path}
            className={`filetree-item ${!node.isDirectory && node.path === activePath ? 'active' : ''}`}
            onClick={() => node.isDirectory ? toggleDir(node) : onFileSelect(node.path, node.name)}
            style={{
              paddingLeft: `${16 + node.depth * 16}px`,
              color: getStatusColor(node.gitStatus),
            }}
          >
            <span className="filetree-icon" style={{ 
              color: node.isDirectory ? 'var(--accent-color)' : getFileIconColor(node.name),
              fontSize: node.isDirectory ? '10px' : '9px',
              fontWeight: node.isDirectory ? 400 : 700,
            }}>
              {node.isDirectory 
                ? (expandedDirs.has(node.path) ? '▾' : '▸') 
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

