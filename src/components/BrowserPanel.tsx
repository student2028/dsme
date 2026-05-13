import React, { useEffect, useRef, useCallback, useState } from 'react';
import {
  createBrowserTask,
  finishBrowserStep,
  formatBrowserTaskMarkdown,
  startBrowserStep,
  type BrowserStepKind,
  type BrowserTask,
  type BrowserTaskStep,
} from '../lib/browserTaskTimeline';

interface BrowserSlot {
  url: string;
  label: string;
  status: 'idle' | 'loading' | 'navigating' | 'ready' | 'error';
}

interface BrowserSummary {
  title: string;
  lines: string[];
  tone: 'info' | 'success' | 'error';
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
  const [summary, setSummary] = useState<BrowserSummary | null>(null);
  const [task, setTask] = useState<BrowserTask | null>(null);
  const taskRef = useRef<BrowserTask | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const webviewReady = useRef(false);

  // For web_search results
  const resultsRef = useRef<Map<string, string>>(new Map());

  const setCurrentTask = useCallback((next: BrowserTask) => {
    taskRef.current = next;
    setTask(next);
  }, []);

  const beginTask = useCallback((title: string) => {
    const next = createBrowserTask(title);
    setCurrentTask(next);
    return next;
  }, [setCurrentTask]);

  const beginStep = useCallback((kind: BrowserStepKind, label: string, input?: string) => {
    const base = taskRef.current ?? createBrowserTask('Browser Task');
    const next = startBrowserStep(base, { kind, label, input });
    setCurrentTask(next);
    return next.steps[next.steps.length - 1].id;
  }, [setCurrentTask]);

  const completeStep = useCallback((stepId: string, status: 'done' | 'error', output?: string) => {
    const current = taskRef.current;
    if (!current) return;
    setCurrentTask(finishBrowserStep(current, stepId, { status, output }));
  }, [setCurrentTask]);

  /** Keep multi-step browser-use under one timeline (never append to a completed web_search task). */
  const ensureBrowserTaskForCmd = useCallback((sessionTitle?: string) => {
    const cur = taskRef.current;
    const want = sessionTitle?.trim();
    if (want) {
      if (!cur || cur.title !== want) beginTask(want);
      return;
    }
    if (!cur || cur.title.startsWith('Search:')) beginTask('浏览器自动化');
  }, [beginTask]);

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

  const clearTaskTimeline = useCallback(() => {
    taskRef.current = null;
    setTask(null);
    setLastAction('');
  }, []);

  const userHistoryBack = useCallback(() => {
    const wv = getWebview();
    if (!wv?.canGoBack?.()) {
      setLastAction('无法后退 — 没有历史记录');
      return;
    }
    wv.goBack();
    setSlot(prev => ({ ...prev, status: 'navigating' }));
    window.setTimeout(() => {
      try {
        const url = wv.getURL?.() || '';
        setSlot(prev => {
          let label = prev.label;
          try {
            if (url.startsWith('http')) label = new URL(url).hostname;
          } catch { /* keep previous label */ }
          return { ...prev, url, label, status: 'ready' as const };
        });
        setLastAction(`用户后退 → ${url}`);
      } catch {
        setSlot(prev => ({ ...prev, status: 'ready' }));
      }
    }, 500);
  }, [getWebview]);

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
    setSummary({ title: '正在打开页面', lines: [url], tone: 'info' });

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
      setSummary({ title: '页面加载事件异常', lines: ['页面可能仍已显示，稍后会继续尝试解析。'], tone: 'error' });
    };

    wv.addEventListener('did-finish-load', onLoad);
    wv.addEventListener('did-fail-load', onError);
    wv.loadURL(url).catch(() => setSlot(prev => ({ ...prev, status: 'error' })));
  }, [getWebview]);

  /** Must stay below Electron main `browser_eval` IPC timeout (~120s). */
  const WEBVIEW_SCRIPT_TIMEOUT_MS = 115_000;

  // Execute JS on the webview — return value MUST be JSON-serializable (no DOM nodes / PerformanceEntry / Map).
  const execJS = useCallback(async (script: string, timeoutMs = WEBVIEW_SCRIPT_TIMEOUT_MS): Promise<string> => {
    const wv = getWebview();
    if (!wv) return 'Error: webview not ready';
    try {
      const result = await Promise.race([
        wv.executeJavaScript(script),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs),
        ),
      ]);
      if (result === null || result === undefined) {
        return (
          '[evaluate: undefined/null] Electron cannot pass non-JSON-serializable values from the page. ' +
          'Do not return DOM nodes, PerformanceEntry objects, or Map/Set. ' +
          'Example: return JSON.stringify(performance.getEntriesByType("resource").slice(0,40).map(e => ({ name: e.name, type: e.initiatorType, duration: Math.round(e.duration) })));'
        );
      }
      return typeof result === 'string' ? result : JSON.stringify(result);
    } catch (e: any) {
      return `Script error: ${e.message}`;
    }
  }, [getWebview]);

  const extractFromWebview = useCallback(async (
    wv: any,
    script: string,
    timeoutMs = 2500,
  ): Promise<string> => {
    const started = Date.now();
    let last = '';

    while (Date.now() - started < timeoutMs) {
      try {
        const result = await Promise.race([
          wv.executeJavaScript(script),
          new Promise((_, reject) => setTimeout(() => reject(new Error('JS execution timeout')), 1000)),
        ]);
        const text = typeof result === 'string' ? result.trim() : '';
        if (text.length > 20) return text;
        last = text;
      } catch {}
      await new Promise(r => setTimeout(r, 250));
    }

    return last;
  }, []);

  // ── Browser-use command handler ──
  useEffect(() => {
    if (!window.electronAPI?.onBrowserCommand) return;

    window.electronAPI.onBrowserCommand(async (cmd) => {
      const { id, command } = cmd;
      const sessionTitle = typeof cmd.sessionTitle === 'string' ? cmd.sessionTitle : undefined;

      // Ensure browser tab is open and webview exists
      onTabOpen();
      await new Promise(r => setTimeout(r, 150)); // Let React render

      if (command === 'task_start') {
        const goal = String(cmd.goal ?? '').trim() || 'Browser task';
        beginTask(goal);
        setSummary({ title: '浏览器会话', lines: [goal], tone: 'info' });
        window.electronAPI.sendBrowserResult?.(id, `Browser task started: ${goal}`);
        return;
      }

      if (command === 'task_finish') {
        const summaryText = String(cmd.summary ?? '').trim();
        if (summaryText) {
          setSummary({
            title: '浏览器任务已完成',
            lines: summaryText.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 8),
            tone: 'success',
          });
        }
        window.electronAPI.sendBrowserResult?.(
          id,
          summaryText ? `Browser task finished.\n${summaryText}` : 'Browser task finished.',
        );
        return;
      }

      ensureBrowserTaskForCmd(sessionTitle);

      let result = '';
      const stepId = beginStep(
        commandToStepKind(command, cmd.script as string | undefined),
        commandToStepLabel(command, cmd),
        commandToStepInput(command, cmd),
      );
      try {
        switch (command) {
          case 'navigate': {
            const url = cmd.url as string;
            navigateTo(url);
            // Wait for page to load
            const wv = getWebview();
            if (wv) {
              result = await new Promise<string>((resolve) => {
                const timeout = setTimeout(() => {
                  wv.removeEventListener('did-finish-load', done);
                  resolve('Navigation timeout');
                }, 20000);
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
            setLastAction(`Executing: ${script.slice(0, 80)}…`);
            result = await execJS(script);
            const errish =
              /^(Script error|Error:|Command error|\[evaluate:)/i.test(result.trim()) ||
              result.includes('GUEST_VIEW_MANAGER_CALL');
            const cap = errish ? 900 : 360;
            setLastAction(
              result.length > cap ? `Done: ${result.slice(0, cap - 1)}…` : `Done: ${result}`,
            );
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
        completeStep(stepId, result.startsWith('Error:') || result.startsWith('Command error:') ? 'error' : 'done', result);
      } catch (e: any) {
        result = `Command error: ${e.message}`;
        completeStep(stepId, 'error', result);
      }

      window.electronAPI.sendBrowserResult?.(id, result);
    });
  }, [onTabOpen, navigateTo, getWebview, execJS, beginStep, completeStep, beginTask, ensureBrowserTaskForCmd]);

  // ── Web search handler (existing, for backward compat) ──
  useEffect(() => {
    if (!window.electronAPI?.onWebSearchExecute) return;

    window.electronAPI.onWebSearchExecute(async (data) => {
      const { query, engines, stopOnFirstResult } = data;
      resultsRef.current.clear();
      onTabOpen();
      beginTask(`Search: ${query}`);
      setSummary({
        title: '准备搜索',
        lines: [`Query: ${query}`, `Engines: ${engines.map(e => e.label).join(' → ')}`],
        tone: 'info',
      });

      // Small delay to let React render the webview if just opened
      await new Promise(r => setTimeout(r, 200));
      const wv = getWebview();
      if (!wv) {
        sendAllResults(query);
        return;
      }

      for (const engine of engines) {
        if (!engine.extractJS) continue;

        setSummary({ title: `正在搜索 ${engine.label}`, lines: [query], tone: 'info' });
        const stepId = beginStep('search', `Search ${engine.label}`, engine.url);
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
          setTimeout(finish, 5000); // 5s max wait per engine load
        });

        try {
          setSlot(prev => ({ ...prev, status: 'loading' }));
          setLastAction(`Extracting results from ${engine.label}`);
          setSummary({ title: `正在解析 ${engine.label}`, lines: ['读取页面标题、摘要和链接...'], tone: 'info' });
          const parseStarted = Date.now();
          const extractionTimeout = engine.label.toLowerCase().includes('google') ? 7000 : 3500;
          const text = await extractFromWebview(wv, engine.extractJS, extractionTimeout);
          if (text && text.length > 20) {
            resultsRef.current.set(engine.label, `Results from ${engine.label}:\n${text}`);
            const lines = text.split('\n').filter(Boolean);
            const parseSeconds = ((Date.now() - parseStarted) / 1000).toFixed(1);
            setSlot(prev => ({ ...prev, status: 'ready' }));
            setLastAction(`Extracted ${lines.length} result${lines.length === 1 ? '' : 's'} from ${engine.label} in ${parseSeconds}s`);
            setSummary({
              title: `${engine.label} 解析成功 (${parseSeconds}s)`,
              lines: lines.slice(0, 4),
              tone: 'success',
            });
            completeStep(stepId, 'done', text);
            if (stopOnFirstResult) break;
          } else {
            setSummary({ title: `${engine.label} 没有提取到有效结果`, lines: ['继续尝试下一个搜索引擎。'], tone: 'error' });
            completeStep(stepId, 'error', 'No usable result extracted.');
          }
        } catch (e) {
          console.warn(`[WebSearch] Engine ${engine.label} extraction failed:`, e);
          const message = e instanceof Error ? e.message : String(e);
          setSummary({ title: `${engine.label} 解析失败`, lines: [message], tone: 'error' });
          completeStep(stepId, 'error', message);
        }
      }

      sendAllResults(query);
    });
  }, [onTabOpen, navigateTo, getWebview, extractFromWebview, beginTask, beginStep, completeStep]);

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
        <button type="button" className="browser-slot-user-btn" onClick={userHistoryBack} title="在历史记录中后退（不影响 Agent）">
          ← 后退
        </button>
        {lastAction && <span className="browser-slot-action">{lastAction}</span>}
      </div>
      {summary && (
        <div className={`browser-search-summary ${summary.tone}`}>
          <div className="browser-search-summary-title">{summary.title}</div>
          <div className="browser-search-summary-lines">
            {summary.lines.map((line, i) => <div key={i}>{line}</div>)}
          </div>
        </div>
      )}
      {task && (
        <BrowserTaskTimeline
          task={task}
          pageUrl={slot.url}
          onClearTimeline={clearTaskTimeline}
        />
      )}
      <div ref={containerRef} className="browser-slot-content" />
    </div>
  );
};

function commandToStepKind(command: string, script?: string): BrowserStepKind {
  if (command === 'snapshot') return 'observe';
  if (command === 'back') return 'back';
  if (command === 'navigate') return 'navigate';
  if (command === 'eval') {
    if (script?.includes('Clicked [')) return 'click';
    if (script?.includes('Typed into [')) return 'type';
    if (script?.includes('Scrolled ')) return 'scroll';
    return 'eval';
  }
  return 'eval';
}

interface BrowserCommandLike {
  url?: string;
  script?: string;
  [key: string]: unknown;
}

function commandToStepLabel(command: string, cmd: BrowserCommandLike): string {
  if (command === 'navigate') return 'Navigate';
  if (command === 'snapshot') return 'Observe page';
  if (command === 'back') return 'Go back';
  if (command === 'eval') {
    const kind = commandToStepKind(command, cmd.script);
    if (kind === 'click') return 'Click element';
    if (kind === 'type') return 'Type into element';
    if (kind === 'scroll') return 'Scroll page';
    return 'Evaluate page';
  }
  return command;
}

function commandToStepInput(command: string, cmd: BrowserCommandLike): string | undefined {
  if (command === 'navigate') return cmd.url;
  if (command === 'eval') return cmd.script?.slice(0, 220);
  return undefined;
}

const BrowserTaskTimeline: React.FC<{
  task: BrowserTask;
  pageUrl: string;
  onClearTimeline: () => void;
}> = ({ task, pageUrl, onClearTimeline }) => {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'err'>('idle');

  const toggleExpand = (id: string) => {
    setExpanded(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const copyMarkdown = async () => {
    try {
      const md = formatBrowserTaskMarkdown(task, { pageUrl: pageUrl || undefined });
      await navigator.clipboard.writeText(md);
      setCopyState('ok');
      window.setTimeout(() => setCopyState('idle'), 2000);
    } catch {
      setCopyState('err');
      window.setTimeout(() => setCopyState('idle'), 2500);
    }
  };

  const copyLabel = copyState === 'ok' ? '已复制' : copyState === 'err' ? '复制失败' : '复制 Markdown';

  return (
    <div className="browser-task-timeline">
      <div className="browser-task-header">
        <div>
          <div className="browser-task-title">{task.title}</div>
          <div className="browser-task-subtitle">
            {task.steps.length} steps · {task.summary.doneSteps} done
            {task.summary.runningSteps > 0 ? ' · running' : ''}
            {task.summary.errorSteps > 0 ? ` · ${task.summary.errorSteps} failed` : ''}
          </div>
        </div>
        <div className="browser-task-toolbar">
          <button type="button" className="browser-task-tool-btn" onClick={copyMarkdown}>
            {copyLabel}
          </button>
          <button type="button" className="browser-task-tool-btn muted" onClick={onClearTimeline} title="清空下方步骤列表（不关闭网页）">
            清空时间线
          </button>
          <span className="browser-task-elapsed">{formatDuration(task.summary.elapsedMs)}</span>
        </div>
      </div>
      <div className="browser-task-steps">
        {task.steps.map(step => (
          <BrowserTaskStepRow
            key={step.id}
            step={step}
            expanded={Boolean(expanded[step.id])}
            onToggleExpand={() => toggleExpand(step.id)}
          />
        ))}
      </div>
    </div>
  );
};

const BrowserTaskStepRow: React.FC<{
  step: BrowserTaskStep;
  expanded: boolean;
  onToggleExpand: () => void;
}> = ({ step, expanded, onToggleExpand }) => {
  const raw = step.outputRaw || '';
  const expandable = raw.length > 0 && (raw.includes('\n') || raw.length > (step.outputPreview?.length ?? 0) + 20);

  return (
    <div className={`browser-task-step ${step.status}`}>
      <div className="browser-task-step-dot" />
      <div className="browser-task-step-body">
        <div className="browser-task-step-line">
          <span className="browser-task-step-kind">{step.kind}</span>
          <span className="browser-task-step-label">{step.label}</span>
          {step.status === 'running' && <span className="browser-task-step-status">running</span>}
          {step.durationMs !== undefined && <span className="browser-task-step-duration">{formatDuration(step.durationMs)}</span>}
          {expandable && (
            <button type="button" className="browser-task-expand-btn" onClick={onToggleExpand}>
              {expanded ? '收起' : '详情'}
            </button>
          )}
        </div>
        {step.input && <div className="browser-task-step-input">{step.input}</div>}
        {step.outputPreview && <div className="browser-task-step-output">{step.outputPreview}</div>}
        {expandable && expanded && (
          <pre className="browser-task-step-detail">{raw}</pre>
        )}
      </div>
    </div>
  );
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

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
