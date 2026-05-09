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
  showDetails: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: '', showDetails: false };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[DSME ErrorBoundary]', error, errorInfo.componentStack);
    this.setState({ errorInfo: errorInfo.componentStack || '' });
  }

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
            <button
              className="error-boundary-btn"
              onClick={() => this.setState({ hasError: false, error: null, errorInfo: '' })}
            >
              🔄 尝试恢复
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
