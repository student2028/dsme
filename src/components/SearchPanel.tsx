import React, { useState, useCallback, useRef, useEffect } from 'react';

interface SearchResult {
  filepath: string;
  filename: string;
  line: number;
  content: string;
  match: string;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onResultSelect: (filepath: string, name: string) => void;
}

export const SearchPanel: React.FC<Props> = ({ isOpen, onClose, onResultSelect }) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
      setQuery('');
      setResults([]);
    }
  }, [isOpen]);

  const performSearch = useCallback(async (q: string) => {
    if (!q.trim() || !window.electronAPI) {
      setResults([]);
      return;
    }

    setIsSearching(true);
    try {
      // Use the search-codebase IPC - we need to add this
      const raw = await window.electronAPI.searchCodebase(q);
      const lines = raw.split('\n').filter((l: string) => l.trim());
      const parsed: SearchResult[] = lines.slice(0, 50).map((line: string) => {
        // Format: ./path/to/file:lineNum:content
        const match = line.match(/^\.\/(.+?):(\d+):(.*)$/);
        if (!match) return null;
        const [, fp, lineNum, content] = match;
        return {
          filepath: fp,
          filename: fp.split('/').pop() || fp,
          line: parseInt(lineNum),
          content: content.trim(),
          match: q,
        };
      }).filter(Boolean) as SearchResult[];
      setResults(parsed);
      setSelectedIdx(0);
    } catch {
      setResults([]);
    }
    setIsSearching(false);
  }, []);

  const handleQueryChange = (v: string) => {
    setQuery(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => performSearch(v), 300);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIdx(i => Math.min(i + 1, results.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIdx(i => Math.max(i - 1, 0)); }
    if (e.key === 'Enter' && results[selectedIdx]) {
      const r = results[selectedIdx];
      onResultSelect(r.filepath, r.filename);
      onClose();
    }
  };

  const highlightMatch = (text: string, match: string) => {
    const idx = text.toLowerCase().indexOf(match.toLowerCase());
    if (idx === -1) return text;
    return (
      <>
        {text.slice(0, idx)}
        <span className="search-highlight">{text.slice(idx, idx + match.length)}</span>
        {text.slice(idx + match.length)}
      </>
    );
  };

  if (!isOpen) return null;

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="search-panel" onClick={e => e.stopPropagation()}>
        <div className="search-input-row">
          <span className="search-icon">🔍</span>
          <input
            ref={inputRef}
            className="command-palette-input"
            placeholder="Search in workspace..."
            aria-label="Search in workspace"
            value={query}
            onChange={e => handleQueryChange(e.target.value)}
            onKeyDown={handleKeyDown}
            style={{ borderBottom: 'none' }}
          />
        </div>

        <div className="search-status">
          {isSearching ? 'Searching...' : `${results.length} result${results.length !== 1 ? 's' : ''}`}
        </div>

        <div className="command-palette-results">
          {results.map((r, i) => (
            <div
              key={`${r.filepath}:${r.line}:${i}`}
              className={`search-result-item ${i === selectedIdx ? 'selected' : ''}`}
              onClick={() => { onResultSelect(r.filepath, r.filename); onClose(); }}
            >
              <div className="search-result-header">
                <span className="search-result-file">{r.filename}</span>
                <span className="search-result-line">L{r.line}</span>
              </div>
              <div className="search-result-content">
                {highlightMatch(r.content.slice(0, 120), r.match)}
              </div>
            </div>
          ))}
          {results.length === 0 && query && !isSearching && (
            <div className="command-palette-empty">No results for "{query}"</div>
          )}
        </div>
      </div>
    </div>
  );
};
