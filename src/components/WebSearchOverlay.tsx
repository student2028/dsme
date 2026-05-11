import React, { useState, useEffect, useCallback, useRef } from 'react';

interface EngineConfig {
  label: string;
  url: string;
  extractJS: string;
}

interface EngineState {
  label: string;
  url: string;
  extractJS: string;
  status: 'loading' | 'extracting' | 'done' | 'error';
  result?: string;
}

/**
 * Inline search panel embedded in the main content area.
 * Uses real <webview> tags — native Chrome content, directly visible through CDP.
 * Renders inside the editor area (not as a popup overlay).
 */
export const WebSearchOverlay: React.FC = () => {
  const [engines, setEngines] = useState<EngineState[]>([]);
  const [query, setQuery] = useState('');
  const [visible, setVisible] = useState(false);
  const resultsRef = useRef<Map<string, string>>(new Map());
  const resolvedRef = useRef(0);
  const expectedRef = useRef(0);

  useEffect(() => {
    if (!window.electronAPI?.onWebSearchExecute) return;

    window.electronAPI.onWebSearchExecute((data) => {
      const { query: q, engines: configs } = data;
      setQuery(q);
      setEngines(configs.map((e: EngineConfig) => ({
        ...e,
        status: 'loading' as const,
      })));
      setVisible(true);
      resultsRef.current.clear();
      resolvedRef.current = 0;
      expectedRef.current = configs.length;
    });
  }, []);

  const onEngineResult = useCallback((label: string, result: string | null) => {
    setEngines(prev => prev.map(e =>
      e.label === label
        ? { ...e, status: 'done', result: result || undefined }
        : e
    ));

    if (result) {
      resultsRef.current.set(label, `Web search results for "${query}" (${label}):\n${result}`);
    }

    resolvedRef.current++;
    if (resolvedRef.current >= expectedRef.current) {
      const allResults = Array.from(resultsRef.current.values());
      const finalResult = allResults.length > 0
        ? allResults.join('\n\n---\n\n')
        : `No results found for "${query}".`;
      window.electronAPI.sendWebSearchResults?.(finalResult);
      // Keep visible so user can review — auto-hide after delay
      setTimeout(() => setVisible(false), 4000);
    }
  }, [query]);

  const onEngineError = useCallback((label: string) => {
    setEngines(prev => prev.map(e =>
      e.label === label ? { ...e, status: 'error' } : e
    ));

    resolvedRef.current++;
    if (resolvedRef.current >= expectedRef.current) {
      const allResults = Array.from(resultsRef.current.values());
      window.electronAPI.sendWebSearchResults?.(
        allResults.length > 0 ? allResults.join('\n\n---\n\n') : `No results found for "${query}".`
      );
      setTimeout(() => setVisible(false), 4000);
    }
  }, [query]);

  const handleClose = useCallback(() => {
    setVisible(false);
  }, []);

  if (!visible || engines.length === 0) return null;

  const allDone = engines.every(e => e.status === 'done' || e.status === 'error');
  const successCount = engines.filter(e => e.status === 'done' && e.result).length;

  return (
    <div className="web-search-inline">
      {/* Header bar */}
      <div className="web-search-header">
        <div className="web-search-header-left">
          <span className="web-search-icon">🔍</span>
          <span className="web-search-title">联网搜索</span>
          <span className="web-search-query-inline">{query}</span>
        </div>
        <div className="web-search-header-right">
          {allDone ? (
            <span className="web-search-status-badge done">✓ {successCount}/{engines.length}</span>
          ) : (
            <span className="web-search-status-badge loading">搜索中...</span>
          )}
          <button className="web-search-close" onClick={handleClose}>×</button>
        </div>
      </div>

      {/* Engine webviews side by side */}
      <div className="web-search-live-views">
        {engines.map(engine => (
          <WebviewCard
            key={engine.label}
            engine={engine}
            onResult={onEngineResult}
            onError={onEngineError}
          />
        ))}
      </div>

      {/* Footer */}
      <div className="web-search-footer">
        {allDone ? (
          <span className="web-search-footer-text done">
            搜索完成 · {successCount}/{engines.length} 个引擎返回结果 · 即将关闭
          </span>
        ) : (
          <span className="web-search-footer-text">
            正在并行搜索 {engines.length} 个引擎...
          </span>
        )}
      </div>
    </div>
  );
};

/**
 * Individual webview card — creates a real <webview> element imperatively.
 */
const WebviewCard: React.FC<{
  engine: EngineState;
  onResult: (label: string, result: string | null) => void;
  onError: (label: string) => void;
}> = ({ engine, onResult, onError }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const setupDone = useRef(false);

  useEffect(() => {
    if (!containerRef.current || setupDone.current) return;
    setupDone.current = true;

    const wv = document.createElement('webview') as any;
    wv.setAttribute('src', engine.url);
    wv.setAttribute('useragent',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );
    wv.className = 'web-search-webview';

    containerRef.current.appendChild(wv);

    const handleLoad = async () => {
      await new Promise(r => setTimeout(r, 2500));
      try {
        const result = await wv.executeJavaScript(engine.extractJS);
        onResult(engine.label, result?.trim()?.length > 20 ? result.trim() : null);
      } catch {
        onResult(engine.label, null);
      }
    };

    const handleError = () => {
      onError(engine.label);
    };

    wv.addEventListener('did-finish-load', handleLoad);
    wv.addEventListener('did-fail-load', handleError);

    const timeout = setTimeout(() => {
      if (engine.status === 'loading') {
        onError(engine.label);
      }
    }, 15000);

    return () => {
      clearTimeout(timeout);
      try { wv.remove(); } catch {}
    };
  }, [engine.url]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`web-search-live-card ${engine.status}`}>
      <div className="web-search-live-label">
        <span className="web-search-engine-icon">
          {engine.label === 'Google' ? '🇬' : engine.label === 'Sogou' ? '🐕' : '🔗'}
        </span>
        <span className="web-search-engine-name">{engine.label}</span>
        <span className={`web-search-engine-badge ${engine.status}`}>
          {engine.status === 'loading' && '加载中...'}
          {engine.status === 'extracting' && '提取中...'}
          {engine.status === 'done' && (engine.result ? '✓ 成功' : '✗ 无结果')}
          {engine.status === 'error' && '✗ 失败'}
        </span>
      </div>

      {(engine.status === 'loading' || engine.status === 'extracting') && (
        <div className="web-search-engine-progress">
          <div className="web-search-engine-progress-bar" />
        </div>
      )}

      {/* Real embedded browser */}
      <div ref={containerRef} className="web-search-webview-container" />

      {engine.result && (
        <div className="web-search-engine-result">
          {engine.result.split('\n').slice(0, 4).map((line, i) => (
            <div key={i} className="web-search-result-line">{line}</div>
          ))}
        </div>
      )}
    </div>
  );
};
