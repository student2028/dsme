import React, { useState, useEffect, useRef, useCallback } from 'react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onFileSelect: (filepath: string, name: string) => void;
}

interface QuickResult {
  name: string;
  path: string;
}

export const CommandPalette: React.FC<Props> = ({ isOpen, onClose, onFileSelect }) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<QuickResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setResults([]);
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  const searchFiles = useCallback(async (q: string) => {
    if (!q.trim() || !window.electronAPI) {
      setResults([]);
      return;
    }
    try {
      const found = await window.electronAPI.searchFiles(q);
      setResults(found || []);
      setSelectedIndex(0);
    } catch {
      setResults([]);
    }
  }, []);

  useEffect(() => {
    const timeout = setTimeout(() => searchFiles(query), 200);
    return () => clearTimeout(timeout);
  }, [query, searchFiles]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && results.length > 0) {
      const selected = results[selectedIndex];
      onFileSelect(selected.path, selected.name);
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="command-palette" onClick={e => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="command-palette-input"
          placeholder="SEARCH FILES..."
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          spellCheck="false"
        />
        <div className="command-palette-results">
          {results.map((r, i) => (
            <div
              key={r.path}
              className={`command-palette-item ${i === selectedIndex ? 'selected' : ''}`}
              onClick={() => { onFileSelect(r.path, r.name); onClose(); }}
            >
              <span className="cpi-name">{r.name}</span>
              <span className="cpi-path">{r.path}</span>
            </div>
          ))}
          {query && results.length === 0 && (
            <div className="command-palette-empty">NO RESULTS FOUND</div>
          )}
        </div>
      </div>
    </div>
  );
};
