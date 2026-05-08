import React, { Component } from 'react';
import type { ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallbackMessage?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[DSME ErrorBoundary]', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary">
          <div className="error-boundary-icon">⚠</div>
          <div className="error-boundary-title">COMPONENT CRASH</div>
          <div className="error-boundary-msg">
            {this.state.error?.message || this.props.fallbackMessage || 'Unknown error'}
          </div>
          <button
            className="error-boundary-btn"
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            RETRY
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
