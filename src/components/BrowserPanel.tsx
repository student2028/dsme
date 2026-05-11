import React, { useEffect, useRef, useCallback, useState } from 'react';

interface BrowserSlot {
  url: string;
  label: string;
  status: 'idle' | 'loading' | 'navigating' | 'ready' | 'error';
}

/**
 * Persistent browser panel with a primary webview slot.
 * Handles both web_search delegation AND browser-use commands.
 *
 * The webview is created ONCE and persists across all interactions.
 * Agent tools (navigate, snapshot, click, type, scroll) execute
 * directly via webview.executeJavaScript() — zero distance.
 */
export const BrowserPanel: React.FC<{
  visible: boolean;
  onTabOpen: () => void;
}> = ({ visible, onTabOpen }) => {
  const [slot, setSlot] = useState<BrowserSlot>({ url: '', label: 'Browser', status: 'idle' });
  const [lastAction, setLastAction] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const webviewReady = useRef(false);

  // For web_search results
  const resultsRef = useRef<Map<string, string>>(new Map());

  // Get or create the persistent webview
  const getWebview = useCallback((): any => {
    const container = containerRef.current;
    if (!container) return null;

    const existing = container.querySelector('webview');
    if (existing) return existing;

    const wv = document.createElement('webview') as any;
    wv.setAttribute('useragent',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );
    wv.setAttribute('src', 'about:blank');
    wv.className = 'browser-webview';
    container.appendChild(wv);
    webviewReady.current = true;
    return wv;
  }, []);

  // Create webview when the panel first becomes visible
  useEffect(() => {
    if (visible && containerRef.current && !webviewReady.current) {
      getWebview();
    }
  }, [visible, getWebview]);

  // Navigate the webview to a URL
  const navigateTo = useCallback((url: string, label?: string) => {
    const wv = getWebview();
    if (!wv) return;
    setSlot({ url, label: label || new URL(url).hostname, status: 'navigating' });
    setLastAction(`Navigating to ${url}`);

    const onLoad = () => {
      wv.removeEventListener('did-finish-load', onLoad);
      wv.removeEventListener('did-fail-load', onError);
      setSlot(prev => ({ ...prev, status: 'ready' }));
      setLastAction(`Loaded: ${url}`);
    };
    const onError = () => {
      wv.removeEventListener('did-finish-load', onLoad);
      wv.removeEventListener('did-fail-load', onError);
      setSlot(prev => ({ ...prev, status: 'error' }));
    };

    wv.addEventListener('did-finish-load', onLoad);
    wv.addEventListener('did-fail-load', onError);
    wv.loadURL(url).catch(() => setSlot(prev => ({ ...prev, status: 'error' })));
  }, [getWebview]);

  // Execute JS on the webview
  const execJS = useCallback(async (script: string): Promise<string> => {
    const wv = getWebview();
    if (!wv) return 'Error: webview not ready';
    try {
      const result = await Promise.race([
        wv.executeJavaScript(script),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout after 10s')), 10000))
      ]);
      return result === null || result === undefined ? 'null' : String(result);
    } catch (e: any) {
      return `Script error: ${e.message}`;
    }
  }, [getWebview]);

  // ── Browser-use command handler ──
  useEffect(() => {
    if (!window.electronAPI?.onBrowserCommand) return;

    window.electronAPI.onBrowserCommand(async (cmd) => {
      const { id, command } = cmd;

      // Ensure browser tab is open and webview exists
      onTabOpen();
      await new Promise(r => setTimeout(r, 150)); // Let React render

      let result = '';
      try {
        switch (command) {
          case 'navigate': {
            const url = cmd.url as string;
            navigateTo(url);
            // Wait for page to load
            const wv = getWebview();
            if (wv) {
              result = await new Promise<string>((resolve) => {
                const timeout = setTimeout(() => resolve('Navigation timeout'), 20000);
                const done = () => {
                  clearTimeout(timeout);
                  wv.removeEventListener('did-finish-load', done);
                  resolve(`Navigated to ${url}. Title: ${wv.getTitle()}`);
                };
                wv.addEventListener('did-finish-load', done);
              });
            } else {
              result = 'Error: webview not available';
            }
            break;
          }
          case 'snapshot': {
            setLastAction('Taking snapshot...');
            result = await execJS(cmd.script as string);
            setLastAction(`Snapshot: ${result.split('\n').length} lines`);
            break;
          }
          case 'eval': {
            const script = cmd.script as string;
            setLastAction(`Executing: ${script.slice(0, 50)}...`);
            result = await execJS(script);
            setLastAction(`Done: ${result.slice(0, 50)}`);
            break;
          }
          case 'back': {
            const wv = getWebview();
            if (wv && wv.canGoBack()) {
              wv.goBack();
              await new Promise(r => setTimeout(r, 1500));
              result = `Went back. Now at: ${wv.getURL()}`;
              setSlot(prev => ({ ...prev, url: wv.getURL() }));
            } else {
              result = 'Cannot go back — no history.';
            }
            setLastAction(result);
            break;
          }
          default:
            result = `Unknown command: ${command}`;
        }
      } catch (e: any) {
        result = `Command error: ${e.message}`;
      }

      window.electronAPI.sendBrowserResult?.(id, result);
    });
  }, [onTabOpen, navigateTo, getWebview, execJS]);

  // ── Web search handler (existing, for backward compat) ──
  useEffect(() => {
    if (!window.electronAPI?.onWebSearchExecute) return;

    window.electronAPI.onWebSearchExecute(async (data) => {
      const { query, engines } = data;
      resultsRef.current.clear();
      onTabOpen();

      // Small delay to let React render the webview if just opened
      await new Promise(r => setTimeout(r, 200));
      const wv = getWebview();
      if (!wv) {
        sendAllResults(query);
        return;
      }

      for (const engine of engines) {
        if (!engine.extractJS) continue;

        navigateTo(engine.url, engine.label);

        // Wait for page load OR failure OR timeout
        await new Promise<void>((resolve) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            wv.removeEventListener('did-finish-load', finish);
            wv.removeEventListener('did-fail-load', finish);
            resolve();
          };
          wv.addEventListener('did-finish-load', finish);
          wv.addEventListener('did-fail-load', finish);
          setTimeout(finish, 8000); // 8s max wait per engine load
        });

        // Wait a bit for dynamic content to render
        await new Promise(r => setTimeout(r, 2000));

        try {
          const result = await Promise.race([
            wv.executeJavaScript(engine.extractJS),
            new Promise((_, rej) => setTimeout(() => rej(new Error('JS execution timeout')), 4000))
          ]);
          const text = typeof result === 'string' ? result.trim() : '';
          if (text && text.length > 20) {
            resultsRef.current.set(engine.label, `Results from ${engine.label}:\n${text}`);
          }
        } catch (e) {
          console.warn(`[WebSearch] Engine ${engine.label} extraction failed:`, e);
        }
      }

      sendAllResults(query);
    });
  }, [onTabOpen, navigateTo, getWebview]);

  const sendAllResults = (query: string) => {
    const allResults = Array.from(resultsRef.current.values());
    window.electronAPI.sendWebSearchResults?.(
      allResults.length > 0 ? allResults.join('\n\n---\n\n') : `No results found for "${query}".`
    );
  };

  return (
    <div className="browser-panel" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="browser-slot-header">
        <span className="browser-slot-label">🌐 {slot.label}</span>
        {slot.url && <span className="browser-slot-url">{slot.url}</span>}
        <StatusBadge status={slot.status} />
        {lastAction && <span className="browser-slot-action">{lastAction}</span>}
      </div>
      <div ref={containerRef} className="browser-slot-content" />
    </div>
  );
};

const StatusBadge: React.FC<{ status: string }> = ({ status }) => {
  if (status === 'idle') return null;
  const map: Record<string, { text: string; cls: string }> = {
    loading: { text: '加载中...', cls: 'loading' },
    navigating: { text: '导航中...', cls: 'loading' },
    ready: { text: '✓ 就绪', cls: 'done' },
    error: { text: '✗ 错误', cls: 'error' },
  };
  const info = map[status] || { text: status, cls: '' };
  return <span className={`browser-slot-badge ${info.cls}`}>{info.text}</span>;
};
