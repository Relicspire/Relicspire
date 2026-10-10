import { createRoot } from 'react-dom/client';
import { createStore, set } from 'idb-keyval';
import input from '../content/release.json';
import { App } from '../app/App';
import { ErrorBoundary } from '../app/ErrorBoundary';
import { createRuntime, type Runtime } from '../app/runtime';
import { DELIVERY_KEY, SaveOwnership } from '../storage/save';
import '../app/styles.css';

// Viteの通常ビルドの入口はindex.htmlだけ。製品の配信準備判定は変更しない。
if (!import.meta.env.DEV) throw new Error('プレイテストは開発サーバー専用です');
const root = createRoot(document.getElementById('root')!);
let runtime: Runtime | undefined;
async function boot() {
  const ownership = new SaveOwnership();
  try {
    await ownership.acquire();
    const store = createStore('relicspire-playtest-v1', 'state');
    const buildId = 'floor-01-playtest-v1';
    // 開発用DBだけに検証版を設定する。製品用DB・セーブ・配信キーには触れない。
    if (ownership.owned) await set(DELIVERY_KEY, { buildId }, store);
    runtime = await createRuntime(input, buildId, { ownership, store });
    root.render(
      <ErrorBoundary onError={() => runtime?.game.stopForOwnershipLoss()}>
        <aside className="p-4 text-center text-amber-200">
          第1階層プレイテスト · 開発専用 / セーブは製品から独立しています。
          正式なオフライン配信・音声・完成アセットは後続タスクで接続します。
        </aside>
        <App
          game={runtime.game}
          recheck={runtime.recheck}
          deliveryReady={runtime.deliveryReady}
        />
      </ErrorBoundary>,
    );
  } catch (error) {
    ownership.release();
    root.render(
      <App
        startupMessage={`プレイテストを開始できませんでした：${String(error)}`}
      />,
    );
  }
}
window.addEventListener('pagehide', () => runtime?.dispose());
window.addEventListener('pageshow', (event) => {
  if (event.persisted) window.location.reload();
});
void boot();
