import React from 'react';

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary] Unhandled error:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="flex flex-col items-center justify-center min-h-[40vh] gap-4 text-txt-secondary p-8">
          <div className="text-5xl">⚠️</div>
          <h2 className="text-xl font-semibold text-txt-primary">Etwas ist schiefgelaufen</h2>
          {this.state.error && (
            <p className="text-sm text-txt-muted font-mono bg-app-elevated rounded-lg px-4 py-2 max-w-xl text-center break-all">
              {this.state.error.message}
            </p>
          )}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-txt-primary hover:bg-accent/80 transition-colors"
          >
            Seite neu laden
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
