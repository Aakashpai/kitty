import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State { error: Error | null }

/** Last line of defence for render crashes: a calm message instead of a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: Error): State {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="center-box down">
        <h2>This page tripped over something</h2>
        <p className="muted">Your data is safe on the server. Reloading usually fixes it.</p>
        <p className="faint small mono">{this.state.error.message}</p>
        <button className="primary" onClick={() => window.location.reload()}>Reload</button>
      </div>
    );
  }
}
