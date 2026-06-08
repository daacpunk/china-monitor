import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional label shown in the fallback (e.g. the page name). */
  label?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Page-level error boundary.
 *
 * Previously, a single component throwing during render (e.g. a Chart.js
 * scale registration error) would blank the entire SPA until a full reload.
 * This boundary contains the failure to the affected page and offers a retry,
 * so the rest of the app — nav, other tabs — stays usable.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep a console trail for debugging in production.
    console.error("[ErrorBoundary]", this.props.label ?? "", error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-8 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
            <AlertTriangle className="h-6 w-6 text-destructive" />
          </div>
          <div className="space-y-1">
            <h2 className="text-lg font-semibold">
              {this.props.label ? `${this.props.label} failed to render` : "Something went wrong"}
            </h2>
            <p className="max-w-md text-sm text-muted-foreground">
              This section hit an error, but the rest of the app is still working. You can retry
              or switch to another tab.
            </p>
            {this.state.error?.message && (
              <p className="max-w-md break-words pt-1 font-mono text-xs text-muted-foreground/70">
                {this.state.error.message}
              </p>
            )}
          </div>
          <Button variant="outline" size="sm" onClick={this.handleReset} className="gap-2">
            <RefreshCw className="h-4 w-4" />
            Retry
          </Button>
        </div>
      );
    }

    return this.props.children;
  }
}
