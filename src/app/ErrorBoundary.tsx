import { Component, type ReactNode } from 'react';
export class ErrorBoundary extends Component<
  { children: ReactNode; onError?: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError?.();
  }
  render() {
    return this.state.failed ? (
      <main className="app-shell">
        <h1>画面を表示できませんでした</h1>
        <p role="alert">
          操作を停止しました。再読み込みすると保存済みの状態から再開します。
        </p>
        <button onClick={() => window.location.reload()}>再読み込み</button>
      </main>
    ) : (
      this.props.children
    );
  }
}
