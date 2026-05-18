export type BrowserStepKind =
  | 'navigate'
  | 'observe'
  | 'extract'
  | 'click'
  | 'type'
  | 'scroll'
  | 'back'
  | 'eval'
  | 'search';

export type BrowserStepStatus = 'running' | 'done' | 'error';

/** Max chars retained per step for expandable detail + Markdown export (long snapshots stay usable). */
export const BROWSER_STEP_RAW_MAX = 12_000;

export interface BrowserTaskStep {
  id: string;
  kind: BrowserStepKind;
  label: string;
  input?: string;
  outputPreview?: string;
  /** Clipped tool/page output for expand + export (see BROWSER_STEP_RAW_MAX). */
  outputRaw?: string;
  /** Screenshot data URL captured at this step (snapshot/click/navigate). */
  screenshotUrl?: string;
  status: BrowserStepStatus;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
}

export interface BrowserTaskSummary {
  totalSteps: number;
  runningSteps: number;
  doneSteps: number;
  errorSteps: number;
  activeStepId: string | null;
  elapsedMs: number;
}

export interface BrowserTask {
  id: string;
  title: string;
  startedAt: number;
  updatedAt: number;
  steps: BrowserTaskStep[];
  summary: BrowserTaskSummary;
}

let idCounter = 0;

/** Single-line preview in the timeline row (expand shows full clipped raw). */
export function summarizeOutput(output: string, maxLength = 1200): string {
  const normalized = String(output || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd() + '…';
}

export function clipRawOutput(output: string, maxLength = BROWSER_STEP_RAW_MAX): string {
  const s = String(output ?? '');
  if (s.length <= maxLength) return s;
  return s.slice(0, Math.max(0, maxLength - 1)).trimEnd() + '…';
}

export function formatElapsedMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

/** Markdown report for sharing / auditing long browser sessions. */
export function formatBrowserTaskMarkdown(task: BrowserTask, opts?: { pageUrl?: string }): string {
  const lines: string[] = [];
  lines.push(`# Browser session: ${task.title}`);
  lines.push('');
  lines.push(`- Started (UTC): ${new Date(task.startedAt).toISOString()}`);
  lines.push(`- Wall elapsed: ${formatElapsedMs(task.summary.elapsedMs)}`);
  lines.push(`- Steps: ${task.steps.length} (${task.summary.doneSteps} done, ${task.summary.errorSteps} failed)`);
  if (opts?.pageUrl) lines.push(`- Current URL: ${opts.pageUrl}`);
  lines.push('');
  lines.push('## Steps');
  lines.push('');
  task.steps.forEach((s, i) => {
    lines.push(`### ${i + 1}. ${s.label} (\`${s.kind}\`) — **${s.status}**`);
    if (s.durationMs != null) lines.push(`- Duration: ${formatElapsedMs(s.durationMs)}`);
    if (s.input) {
      lines.push('- Input:');
      lines.push('');
      appendFence(lines, s.input.slice(0, 8000));
    }
    const body = (s.outputRaw || s.outputPreview || '').trim();
    if (body) {
      lines.push('');
      lines.push('- Output:');
      lines.push('');
      appendFence(lines, body.slice(0, 50_000));
      lines.push('');
    }
  });
  return lines.join('\n');
}

function appendFence(lines: string[], body: string): void {
  const normalized = body.replace(/\r\n/g, '\n');
  const fence = normalized.includes('```') ? '~~~' : '```';
  lines.push(fence);
  lines.push(normalized);
  lines.push(fence);
}

export function createBrowserTask(title: string, now = Date.now()): BrowserTask {
  return buildTask({
    id: `browser_task_${now}_${++idCounter}`,
    title,
    startedAt: now,
    updatedAt: now,
    steps: [],
    summary: {
      totalSteps: 0,
      runningSteps: 0,
      doneSteps: 0,
      errorSteps: 0,
      activeStepId: null,
      elapsedMs: 0,
    },
  }, now);
}

export function startBrowserStep(
  task: BrowserTask,
  step: {
    kind: BrowserStepKind;
    label: string;
    input?: string;
    now?: number;
  },
): BrowserTask {
  const now = step.now ?? Date.now();
  const next: BrowserTaskStep = {
    id: `browser_step_${now}_${++idCounter}`,
    kind: step.kind,
    label: step.label,
    input: step.input,
    status: 'running',
    startedAt: now,
  };

  return buildTask({
    ...task,
    updatedAt: now,
    steps: [...task.steps, next],
  }, now);
}

export function finishBrowserStep(
  task: BrowserTask,
  stepId: string,
  result: {
    status: Exclude<BrowserStepStatus, 'running'>;
    output?: string;
    screenshotUrl?: string;
    now?: number;
  },
): BrowserTask {
  const now = result.now ?? Date.now();
  return buildTask({
    ...task,
    updatedAt: now,
    steps: task.steps.map(step => {
      if (step.id !== stepId) return step;
      const raw = clipRawOutput(result.output || '');
      return {
        ...step,
        status: result.status,
        finishedAt: now,
        durationMs: Math.max(0, now - step.startedAt),
        outputPreview: summarizeOutput(result.output || ''),
        outputRaw: raw.length > 0 ? raw : undefined,
        screenshotUrl: result.screenshotUrl,
      };
    }),
  }, now);
}

function buildTask(task: BrowserTask, now: number): BrowserTask {
  const running = task.steps.filter(step => step.status === 'running');
  const doneSteps = task.steps.filter(step => step.status === 'done').length;
  const errorSteps = task.steps.filter(step => step.status === 'error').length;

  return {
    ...task,
    summary: {
      totalSteps: task.steps.length,
      runningSteps: running.length,
      doneSteps,
      errorSteps,
      activeStepId: running.length > 0 ? running[running.length - 1].id : null,
      elapsedMs: Math.max(0, now - task.startedAt),
    },
  };
}
