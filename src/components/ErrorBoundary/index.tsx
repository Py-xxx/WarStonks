import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
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
        // Plain markup rather than `Panel`/`EmptyState`: this renders *because a render failed*,
        // so the fallback keeps its dependency surface small. `Button` is the exception — it is a
        // leaf primitive, and if it were the thing that broke, nothing in the app would render.
        <div className="m-3 rounded-lg border border-accent-red/25 bg-accent-red/8 p-6">
          <div className="flex flex-col items-center gap-2 text-center">
            <i className="ti ti-alert-triangle text-lg text-accent-red" aria-hidden="true" />
            <span className="text-xs font-medium text-ink">
              {tActive('err.boundaryTitle', { label: this.props.label })}
            </span>
            <span className="text-[11px] leading-relaxed text-ink-dim">
              {tActive('err.boundary')}
            </span>
            <Button variant="outline" size="sm" className="mt-1" onClick={this.handleRetry}>
              {tActive('common.retry')}
            </Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
