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
  onTabOpen: () => void;
}> = ({ visible, onTabOpen }) => {
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

  const completeStep = useCallback((stepId: string, status: 'done' | 'error', output?: string) => {
    const current = taskRef.current;
    if (!current) return;
    setCurrentTask(finishBrowserStep(current, stepId, { status, output }));
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

  // ── Show/hide WebContentsView when tab visibility changes ──
  useEffect(() => {
    if (visible) {
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
  }, [visible]);

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
      completeStep(stepId, isError ? 'error' : 'done', result);
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
