import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import type { GameState } from '../state/game';
import type { Runtime } from './runtime';
import { SavePanel } from './SavePanel';
import { SettingsPanel } from './SettingsPanel';

export function App({
  game,
  recheck,
  deliveryReady = false,
  startupMessage = '正式なゲームデータとオフライン配信の準備を待っています。',
  runtime,
}: {
  game?: GameState;
  recheck?: () => Promise<void>;
  deliveryReady?: boolean;
  startupMessage?: string;
  runtime?: Runtime;
}) {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#content">
        本文へ移動
      </a>
      <header>
        <p className="eyebrow">思考型ダンジョンRPG</p>
        <h1>Relicspire</h1>
        <p>タイムラインと自由なリビルドで、神の試練を攻略する。</p>
        <span className="badge">第1階層 MVP · 開発中</span>
      </header>
      <main id="content" tabIndex={-1}>
        {game && recheck ? (
          <GameShell
            game={game}
            recheck={recheck}
            deliveryReady={deliveryReady}
            runtime={runtime}
          />
        ) : (
          <section>
            <h2>冒険の準備</h2>
            <p role="status">{startupMessage}</p>
            <p>ゲームデータ制作・配信機能の接続後に冒険を開始できます。</p>
          </section>
        )}
      </main>
      <footer>Relicspire — 迷宮に挑む、三人の冒険者</footer>
    </div>
  );
}

function GameShell({
  game,
  recheck,
  deliveryReady,
  runtime,
}: {
  game: GameState;
  recheck: () => Promise<void>;
  deliveryReady: boolean;
  runtime: Runtime | undefined;
}) {
  const status = useStore(game.status);
  const settings = useStore(game.settings).value;
  const progression = useStore(game.progression).value;
  const [page, setPage] = useState<'home' | 'settings' | 'save'>('home');
  const [dirty, setDirty] = useState(false);
  const [paused, setPaused] = useState(document.visibilityState === 'hidden');
  const [hidden, setHidden] = useState(document.visibilityState === 'hidden');
  const [reduced, setReduced] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    window.history.pushState({ relicspire: true }, '', window.location.href);
  }, []);
  const busy = status.value === 'saving' || status.value === 'loading';
  const blocked = busy || paused || status.value !== 'ready' || !deliveryReady;
  useEffect(() => {
    const visibility = () => {
      const isHidden = document.visibilityState === 'hidden';
      setHidden(isHidden);
      if (isHidden) setPaused(true);
    };
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const motion = () => setReduced(media.matches);
    motion();
    media.addEventListener('change', motion);
    document.addEventListener('visibilitychange', visibility);
    const unsubscribe = runtime?.ownership.subscribe(() => {
      if (!runtime.ownership.owned) game.stopForOwnershipLoss();
    });
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      media.removeEventListener('change', motion);
      unsubscribe?.();
    };
  }, [game, runtime]);
  useEffect(() => {
    // 将来のPixiJS/音声はこの休止・演出契約を購読し、ロジック時間を変更しない。
    document.documentElement.dataset.paused = String(
      paused || status.value !== 'ready',
    );
    document.documentElement.dataset.reducedMotion = String(reduced);
    return () => {
      delete document.documentElement.dataset.paused;
      delete document.documentElement.dataset.reducedMotion;
    };
  }, [paused, reduced, status.value]);
  useEffect(() => {
    const back = (event: KeyboardEvent | PopStateEvent) => {
      if (
        event instanceof KeyboardEvent &&
        event.key !== 'Escape' &&
        !(event.altKey && event.key === 'ArrowLeft')
      )
        return;
      if (event instanceof KeyboardEvent) event.preventDefault();
      if (event instanceof PopStateEvent)
        window.history.pushState(
          { relicspire: true },
          '',
          window.location.href,
        );
      if (
        busy ||
        dirty ||
        game.hasPendingSave() ||
        document.querySelector('[aria-modal="true"]')
      ) {
        setNotice('保存・編集を確定または取り消してから戻ってください。');
        return;
      }
      setPage('home');
    };
    window.addEventListener('keydown', back);
    window.addEventListener('popstate', back);
    return () => {
      window.removeEventListener('keydown', back);
      window.removeEventListener('popstate', back);
    };
  }, [busy, dirty, game]);
  return (
    <>
      <p role="status" className="delivery-status">
        {deliveryReady
          ? '配信版の保存キーを確認済み'
          : 'オフライン配信が未準備のため、新規開始・設定保存は待機中です。'}
      </p>
      {paused && (
        <section aria-label="休止中">
          <h2>休止中</h2>
          <p>画面が非表示になったため操作・演出・音を停止しました。</p>
          <button disabled={hidden} onClick={() => setPaused(false)}>
            再開
          </button>
        </section>
      )}
      {notice && <p role="status">{notice}</p>}
      {reduced && (
        <p>端末の「動きを減らす」に従い、揺れと移動演出を抑えます。</p>
      )}
      <nav aria-label="共通メニュー">
        <button
          disabled={busy || dirty || game.hasPendingSave()}
          onClick={() => setPage('home')}
        >
          現在地
        </button>
        <button disabled={blocked || dirty} onClick={() => setPage('settings')}>
          設定
        </button>
        <button disabled={busy || dirty} onClick={() => setPage('save')}>
          セーブ管理
        </button>
      </nav>
      {page === 'settings' && status.value === 'error' && (
        <SavePanel
          game={game}
          recheck={recheck}
          writesEnabled={deliveryReady && !paused}
        />
      )}
      {page === 'settings' && settings ? (
        <SettingsPanel
          key={JSON.stringify(settings)}
          initial={settings}
          disabled={blocked}
          onDirty={setDirty}
          onClose={() => setPage('home')}
          onSave={async (next) => {
            const data = game.snapshot();
            if (!data || blocked) throw new Error('現在は設定を保存できません');
            await game.update({ ...data, settings: next });
            setNotice('設定を保存しました。');
          }}
        />
      ) : (
        <>
          {page === 'home' && progression && (
            <section>
              <h2>
                {progression.location.kind === 'guild'
                  ? '迷宮ギルド'
                  : '探索の再開'}
              </h2>
              <p>
                保存した現在地：
                {progression.location.kind === 'guild'
                  ? '拠点'
                  : `${progression.location.floorId} / ${progression.location.nodeId}`}
              </p>
              <p>編成・探索・バトル画面は後続のMVPタスクで接続します。</p>
            </section>
          )}
          <SavePanel
            game={game}
            recheck={recheck}
            writesEnabled={deliveryReady && !paused}
          />
        </>
      )}
    </>
  );
}
