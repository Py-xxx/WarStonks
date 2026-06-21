import { Component, type ErrorInfo, type ReactNode } from 'react';

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
            <span className="empty-primary">{this.props.label} hit an error</span>
            <span className="empty-sub">
              This section failed to render. The rest of the page is unaffected.
            </span>
            <button className="text-btn" type="button" onClick={this.handleRetry}>
              Try again
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
