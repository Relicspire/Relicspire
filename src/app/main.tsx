import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';
import { bundledRelease, createRuntime, type Runtime } from './runtime';
import './styles.css';

const element = document.getElementById('root');
if (!element) throw new Error('アプリのマウント先が見つかりません。');
const root = createRoot(element);
let runtime: Runtime | undefined;
root.render(<App startupMessage="起動準備中…" />);
async function boot() {
  try {
    const release = bundledRelease();
    if (!release) {
      root.render(<App />);
      return;
    }
    const buildId = import.meta.env.VITE_BUILD_ID;
    if (!buildId)
      throw new Error('ビルド識別子がありません。配信準備が必要です。');
    runtime = await createRuntime(release, buildId);
    root.render(
      <ErrorBoundary onError={() => runtime?.game.stopForOwnershipLoss()}>
        <App
          game={runtime.game}
          recheck={runtime.recheck}
          deliveryReady={runtime.deliveryReady}
          runtime={runtime}
        />
      </ErrorBoundary>,
    );
  } catch (error) {
    root.render(
      <App startupMessage={`起動できませんでした：${String(error)}`} />,
    );
  }
}
window.addEventListener('pagehide', () => runtime?.dispose());
window.addEventListener('pageshow', (event) => {
  if (event.persisted) window.location.reload();
});
void boot();
