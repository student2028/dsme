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
 * Browser panel — now uses WebContentsView (managed by main process).
 *
 * This component only:
 *   1. Reports its placeholder div's bounds to main process (ResizeObserver)
 *   2. Shows/hides the WebContentsView when the tab is toggled
 *   3. Renders the browser-use task timeline (step history)
 *   4. Displays URL bar and status from main process events
 *
 * NO <webview> is created. All browser interaction happens in main process.
 */
export const BrowserPanel: React.FC<{
  visible: boolean;
  overlayOpen?: boolean;
  onTabOpen: () => void;
}> = ({ visible, overlayOpen = false, onTabOpen }) => {
  const [slot, setSlot] = useState<BrowserSlot>({ url: '', label: 'Browser', status: 'idle' });
  const [lastAction, setLastAction] = useState('');
  const [summary, setSummary] = useState<BrowserSummary | null>(null);
  const [task, setTask] = useState<BrowserTask | null>(null);
  const taskRef = useRef<BrowserTask | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

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

  const completeStep = useCallback((stepId: string, status: 'done' | 'error', output?: string, screenshotUrl?: string) => {
    const current = taskRef.current;
    if (!current) return;
    setCurrentTask(finishBrowserStep(current, stepId, { status, output, screenshotUrl }));
  }, [setCurrentTask]);

  const clearTaskTimeline = useCallback(() => {
    taskRef.current = null;
    setTask(null);
    setLastAction('');
  }, []);

  const userHistoryBack = useCallback(() => {
    // Not yet implemented for WebContentsView — would need an IPC call
    setLastAction('后退功能正在迁移到 WebContentsView');
  }, []);

  // ── Bounds sync: tell main process where our placeholder div is ──
  useEffect(() => {
    if (!containerRef.current) return;

    const syncBounds = () => {
      if (!containerRef.current || !visible) return;
      const rect = containerRef.current.getBoundingClientRect();
      const bounds = {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
      window.electronAPI?.syncBrowserBounds?.(bounds);
    };

    const observer = new ResizeObserver(syncBounds);
    observer.observe(containerRef.current);

    // Also sync on window resize (for cases ResizeObserver doesn't catch)
    window.addEventListener('resize', syncBounds);

    // Initial sync
    syncBounds();

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', syncBounds);
    };
  }, [visible]);

  // ── Show/hide WebContentsView when tab visibility or overlay state changes ──
  // WebContentsView is a native layer above all DOM content, so we must explicitly
  // hide it when any modal overlay (Settings, CommandPalette, etc.) is open.
  useEffect(() => {
    if (visible && !overlayOpen) {
      // Show with current bounds
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        window.electronAPI?.showBrowserView?.({
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      } else {
        window.electronAPI?.showBrowserView?.();
      }
    } else {
      window.electronAPI?.hideBrowserView?.();
    }
  }, [visible, overlayOpen]);

  // ── Auto-clear timeline when a new chat round begins, or conversation switches ──
  useEffect(() => {
    const handleClear = () => {
      taskRef.current = null;
      setTask(null);
      setSummary(null);
      setLastAction('');
    };

    window.addEventListener('dsme-conversation-switched', handleClear);

    if (!window.electronAPI?.onChatStreamStart) return;
    const unsub = window.electronAPI.onChatStreamStart(handleClear);
    
    return () => { 
      unsub(); 
      window.removeEventListener('dsme-conversation-switched', handleClear);
    };
  }, []);

  // ── Listen for navigation events from main process ──
  useEffect(() => {
    if (!window.electronAPI?.onBrowserViewNavigated) return;
    const unsub = window.electronAPI.onBrowserViewNavigated((data: { url: string; title: string }) => {
      const { url, title } = data;
      let label = 'Browser';
      try { label = new URL(url).hostname; } catch {}
      setSlot({ url, label, status: 'ready' });
      setLastAction(`Loaded: ${title || url}`);
    });
    return () => { unsub(); };
  }, []);

  // ── Listen for browser-step events from main process (timeline) ──
  useEffect(() => {
    if (!window.electronAPI?.onBrowserStep) return;
    const unsub = window.electronAPI.onBrowserStep((data: any) => {
      const { command, sessionTitle, params, result } = data;

      if (command === 'task_start') {
        const goal = params?.goal || 'Browser task';
        beginTask(goal);
        setSummary({ title: '浏览器会话', lines: [goal], tone: 'info' });
        return;
      }

      if (command === 'task_finish') {
        const summaryText = params?.summary || '';
        if (summaryText) {
          setSummary({
            title: '浏览器任务已完成',
            lines: summaryText.split('\n').map((l: string) => l.trim()).filter(Boolean).slice(0, 8),
            tone: 'success',
          });
        }
        return;
      }

      // Ensure a task exists for grouping
      if (!taskRef.current || (sessionTitle && taskRef.current.title !== sessionTitle)) {
        beginTask(sessionTitle || '浏览器自动化');
      }

      const stepId = beginStep(
        commandToStepKind(command, params?.script),
        commandToStepLabel(command, params),
        commandToStepInput(command, params),
      );

      // Update slot status on navigate
      if (command === 'navigate' && params?.url) {
        setSlot(prev => ({
          ...prev,
          url: params.url,
          label: (() => { try { return new URL(params.url).hostname; } catch { return prev.label; } })(),
          status: 'navigating',
        }));
      }

      const isError = result?.startsWith('Error:') || result?.startsWith('Navigation error:');
      completeStep(stepId, isError ? 'error' : 'done', result, data.screenshotUrl);
      setLastAction(result?.slice(0, 200) || command);
    });
    return () => { unsub(); };
  }, [beginTask, beginStep, completeStep]);

  // ── Listen for browser-panel-open requests ──
  useEffect(() => {
    if (!window.electronAPI?.onBrowserPanelOpen) return;
    const unsub = window.electronAPI.onBrowserPanelOpen(() => {
      onTabOpen();
    });
    return () => { unsub(); };
  }, [onTabOpen]);

  return (
    <div className="browser-panel" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="browser-slot-header">
        <span className="browser-slot-label">🌐 {slot.label}</span>
        {slot.url && <span className="browser-slot-url">{slot.url}</span>}
        <StatusBadge status={slot.status} />
        <button type="button" className="browser-slot-user-btn" onClick={userHistoryBack} title="在历史记录中后退（不影响 Agent）">
          ← 后退
        </button>
        {navigator.platform.toLowerCase().includes('mac') && (
          <CookieSyncDropdown />
        )}
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
      {/* Placeholder div — WebContentsView is positioned over this area by main process */}
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
  if (command === 'click') return 'click';
  if (command === 'type') return 'type';
  if (command === 'scroll') return 'scroll';
  return 'eval';
}

interface BrowserCommandLike {
  url?: string;
  script?: string;
  ref?: string;
  text?: string;
  direction?: string;
  [key: string]: unknown;
}

function commandToStepLabel(command: string, cmd: BrowserCommandLike): string {
  if (command === 'navigate') return 'Navigate';
  if (command === 'snapshot') return 'Observe page';
  if (command === 'back') return 'Go back';
  if (command === 'click') return 'Click element';
  if (command === 'type') return 'Type into element';
  if (command === 'scroll') return 'Scroll page';
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
  if (command === 'click') return cmd.ref;
  if (command === 'type') return `[${cmd.ref}] "${cmd.text?.slice(0, 50)}"`;
  return undefined;
}

const BrowserTaskTimeline: React.FC<{
  task: BrowserTask;
  pageUrl: string;
  onClearTimeline: () => void;
}> = ({ task, pageUrl, onClearTimeline }) => {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'err'>('idle');
  /** Default collapsed so the webview stays visible during long search/browser runs. */
  const [stepsListOpen, setStepsListOpen] = useState(false);

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
    <div className={`browser-task-timeline${stepsListOpen ? ' is-steps-open' : ''}`}>
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
          <button
            type="button"
            className="browser-task-tool-btn muted"
            onClick={() => setStepsListOpen(v => !v)}
            title={stepsListOpen ? '收起步骤列表，留出网页区域' : '展开步骤列表'}
          >
            {stepsListOpen ? '收起步骤' : `展开步骤 (${task.steps.length})`}
          </button>
          <button type="button" className="browser-task-tool-btn" onClick={copyMarkdown}>
            {copyLabel}
          </button>
          <button type="button" className="browser-task-tool-btn muted" onClick={onClearTimeline} title="清空下方步骤列表（不关闭网页）">
            清空时间线
          </button>
          <span className="browser-task-elapsed">{formatDuration(task.summary.elapsedMs)}</span>
        </div>
      </div>
      {stepsListOpen && (
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
      )}
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
        {step.screenshotUrl && (
          <div className="browser-task-step-screenshot">
            <img
              src={step.screenshotUrl}
              alt={`Screenshot at step: ${step.label}`}
              loading="lazy"
              style={{
                width: '100%',
                maxHeight: '260px',
                objectFit: 'contain',
                borderRadius: '6px',
                marginTop: '6px',
                border: '1px solid rgba(255,255,255,0.08)',
                cursor: 'pointer',
              }}
              onClick={() => {
                // Open screenshot in a new window for full-size viewing
                const w = window.open('', '_blank', 'width=1200,height=800');
                if (w) {
                  w.document.write(`<html><body style="margin:0;background:#111;display:flex;align-items:center;justify-content:center;height:100vh"><img src="${step.screenshotUrl}" style="max-width:100%;max-height:100vh"/></body></html>`);
                }
              }}
              title="点击放大查看"
            />
          </div>
        )}
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

/** Compact cookie sync button with Chrome Profile dropdown. */
const CookieSyncDropdown: React.FC = () => {
  const [open, setOpen] = useState(false);
  const [profiles, setProfiles] = useState<{ dirName: string; name: string; email: string }[]>([]);
  const [syncing, setSyncing] = useState<string | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Load profiles when dropdown opens
  useEffect(() => {
    if (!open) return;
    window.electronAPI?.getChromeProfiles?.().then(p => {
      if (p && p.length > 0) setProfiles(p);
    }).catch(() => {});
  }, [open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleSync = async (profileDir: string) => {
    setSyncing(profileDir);
    try {
      const res = await window.electronAPI?.syncChromeCookies?.(profileDir);
      const label = profiles.find(p => p.dirName === profileDir)?.name || profileDir;
      if (res?.success) {
        alert(`✅ 从 "${label}" 同步了 ${res.count} 个 Cookie`);
      } else {
        alert(`❌ 同步失败: ${res?.error || 'Unknown error'}`);
      }
    } catch (e: any) {
      alert(`❌ ${e.message}`);
    }
    setSyncing(null);
    setOpen(false);
  };

  return (
    <div ref={dropdownRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        className="browser-slot-user-btn"
        onClick={() => setOpen(v => !v)}
        title="从本地 Chrome 同步登录状态 (Cookie) — 点击选择 Profile"
      >
        🍪 同步 Cookie ▾
      </button>
      {open && (
        <div style={{
          position: 'absolute',
          top: '100%',
          left: 0,
          marginTop: '4px',
          background: 'var(--bg-secondary, #1e1e2e)',
          border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
          borderRadius: '8px',
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
          zIndex: 100,
          minWidth: '280px',
          maxHeight: '320px',
          overflowY: 'auto',
          padding: '4px 0',
        }}>
          <div style={{ padding: '6px 12px', fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            选择 Chrome Profile
          </div>
          {profiles.length === 0 && (
            <div style={{ padding: '8px 12px', fontSize: '12px', color: 'var(--text-muted)' }}>加载中...</div>
          )}
          {profiles.map(p => (
            <button
              key={p.dirName}
              type="button"
              disabled={syncing !== null}
              onClick={() => handleSync(p.dirName)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '8px 12px',
                background: syncing === p.dirName ? 'rgba(99,102,241,0.15)' : 'transparent',
                border: 'none',
                cursor: syncing !== null ? 'wait' : 'pointer',
                color: 'var(--text-primary, #e2e8f0)',
                fontSize: '13px',
                borderRadius: 0,
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => { if (!syncing) (e.target as HTMLElement).style.background = 'rgba(99,102,241,0.1)'; }}
              onMouseLeave={e => { if (syncing !== p.dirName) (e.target as HTMLElement).style.background = 'transparent'; }}
            >
              <div style={{ fontWeight: 500 }}>
                {syncing === p.dirName ? '⏳ ' : ''}{p.name}
                {p.dirName === 'Default' && <span style={{ color: 'var(--accent-color)', marginLeft: '4px', fontSize: '11px' }}>★ 默认</span>}
              </div>
              {p.email && (
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>{p.email}</div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
