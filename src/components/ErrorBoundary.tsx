/**
 * DSME Error Boundary — Production-grade crash recovery
 *
 * Features:
 * - Graceful fallback UI with error details
 * - Copy error to clipboard for bug reporting
 * - Retry (re-render) and hard reload options
 * - Auto-collapse stack trace for clean UX
 */

import { Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';

interface Props {
  children: ReactNode;
  fallbackMessage?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: string;
  copied: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: '', copied: false };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[DSME ErrorBoundary]', error, errorInfo.componentStack);
    this.setState({ errorInfo: errorInfo.componentStack || '' });
  }

  private handleCopy = () => {
    const { error, errorInfo } = this.state;
    const report = [
      `DSME Error Report — ${new Date().toISOString()}`,
      `Error: ${error?.message || 'Unknown'}`,
      `Stack: ${error?.stack || 'N/A'}`,
      `Component: ${errorInfo}`,
    ].join('\n\n');
    navigator.clipboard.writeText(report).then(() => {
      this.setState({ copied: true });
      setTimeout(() => this.setState({ copied: false }), 2000);
    });
  };

  private handleRetry = () => {
    this.setState({ hasError: false, error: null, errorInfo: '', copied: false });
  };

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary">
          <div className="error-boundary-card">
            <div className="error-boundary-icon">⚠️</div>
            <div className="error-boundary-title">渲染异常</div>
            <div className="error-boundary-msg">
              {this.props.fallbackMessage || '组件发生了一个意外错误，但应用仍在运行。'}
            </div>
            <pre className="error-boundary-detail">
              {this.state.error?.message || 'Unknown error'}
            </pre>
            {this.state.errorInfo && (
              <details className="error-boundary-stack">
                <summary>展开堆栈追踪</summary>
                <pre>{this.state.errorInfo}</pre>
              </details>
            )}
            <div className="error-boundary-actions">
              <button className="error-boundary-btn" onClick={this.handleRetry}>
                🔄 尝试恢复
              </button>
              <button className="error-boundary-btn secondary" onClick={this.handleCopy}>
                {this.state.copied ? '✓ 已复制' : '📋 复制错误信息'}
              </button>
              <button className="error-boundary-btn secondary" onClick={this.handleReload}>
                🔃 刷新页面
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
