import { Component, type ErrorInfo, type ReactNode } from 'react';
import { tActive } from '../../i18n';

interface ErrorBoundaryProps {
  /** Short label for what failed, shown in the fallback (e.g. "Quick View"). */
  label: string;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Isolates render failures so one broken card can't blank the whole page. Each boundary
 * shows a compact fallback with a retry that clears the error and re-renders its subtree.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[ui] "${this.props.label}" failed to render`, error, info);
  }

  private handleRetry = () => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="card error-boundary-card">
          <div className="empty-state">
            <span className="empty-primary">{tActive('err.boundaryTitle', { label: this.props.label })}</span>
            <span className="empty-sub">
              {tActive('err.boundary')}
            </span>
            <button className="text-btn" type="button" onClick={this.handleRetry}>
              {tActive('common.retry')}
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
