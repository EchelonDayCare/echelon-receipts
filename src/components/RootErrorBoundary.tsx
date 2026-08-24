import { Component, type ReactNode } from "react";
import { logError } from "../lib/errorLog";

interface Props { children: ReactNode }
interface State { error: Error | null }

/**
 * Root-level React error boundary. Catches render / lifecycle exceptions
 * from any screen and shows a recoverable failure card with a Reload
 * button, so a single bad screen doesn't unmount the whole tree into a
 * blank white window.
 *
 * We intentionally do NOT try to isolate individual screens with nested
 * boundaries — the auth gate must stay mounted (so unlock state survives)
 * and everything downstream is recoverable via a router-level remount.
 */
export class RootErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error): State {
    return { error };
  }
  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    void logError(
      "ERROR",
      `react-error-boundary: ${error.message}`,
      (error.stack ?? "") + "\n---\n" + (info.componentStack || ""),
    );
  }
  private handleReload = () => {
    // Full reload — cheaper than trying to hand-remount the tree and
    // guarantees state that snuck into module-level singletons is reset.
    window.location.reload();
  };
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{
        minHeight: "100vh", display: "flex", alignItems: "center",
        justifyContent: "center", background: "#f8fafc", padding: 24,
      }}>
        <div style={{
          maxWidth: 520, background: "white", padding: 24, borderRadius: 12,
          border: "1px solid #fecaca", boxShadow: "0 10px 30px rgba(0,0,0,0.08)",
        }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>⚠️</div>
          <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8, color: "#0f172a" }}>
            Something went wrong on this screen.
          </div>
          <div style={{ fontSize: 13, color: "#475569", marginBottom: 16 }}>
            The app couldn't render this view. Your data is safe — the error was
            captured to the diagnostic log. Reload to try again.
          </div>
          <details style={{ fontSize: 12, color: "#64748b", marginBottom: 16 }}>
            <summary style={{ cursor: "pointer" }}>Details</summary>
            <pre style={{
              margin: "8px 0 0 0", whiteSpace: "pre-wrap", wordBreak: "break-word",
              background: "#f1f5f9", padding: 8, borderRadius: 6, maxHeight: 200, overflow: "auto",
            }}>{this.state.error.message}</pre>
          </details>
          <button
            className="btn"
            onClick={this.handleReload}
            style={{ background: "#1d5fa3", color: "white" }}
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
