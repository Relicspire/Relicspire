import { useState } from 'react';
import { useStore } from 'zustand';
import type { GameState } from '../state/game';

/** 保存管理器に接続する復旧画面。起動・所有権の再取得は呼出元が担当する。 */
export function SavePanel({
  game,
  recheck,
}: {
  game: GameState;
  recheck: () => Promise<void>;
}) {
  const state = useStore(game.status);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<'new' | 'previous' | 'cancel' | null>(
    null,
  );
  const run = async (operation: () => Promise<void>) => {
    setError('');
    try {
      await operation();
      setConfirm(null);
    } catch (cause) {
      setError(String(cause));
    }
  };
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([game.exportRaw()], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'relicspire-save-backup.json';
    link.click();
    URL.revokeObjectURL(url);
  };
  const previous = game.previousInspection();
  return (
    <section aria-label="セーブ管理" className="space-y-4 p-6 text-slate-100">
      <h2>セーブ管理</h2>
      <p role="status">
        {state.value === 'saving'
          ? '保存中…操作をお待ちください'
          : state.value === 'loading'
            ? '読み込み中…'
            : state.value === 'readonly'
              ? '読取専用：別のタブでプレイ中、または保存機能が利用できません'
              : state.value === 'ready'
                ? '保存済み'
                : state.message}
      </p>
      {error && <p role="alert">{error}</p>}
      {state.changes.length > 0 && (
        <>
          <ul>
            {state.changes.map((change, i) => (
              <li key={i}>{change}</li>
            ))}
          </ul>
          <button onClick={() => void run(game.repair)}>
            差分を確認して修復・移行を保存
          </button>
        </>
      )}
      {state.value === 'empty' && (
        <button onClick={() => void run(game.newGame)}>冒険を始める</button>
      )}
      {state.value === 'error' && (
        <>
          <button onClick={() => void run(game.retry)}>保存を再試行</button>
          <button onClick={() => setConfirm('cancel')}>
            変更・未保存の勝利を取り消す
          </button>
        </>
      )}
      {['error', 'readonly'].includes(state.value) && (
        <button onClick={() => void run(recheck)}>再確認・読み直し</button>
      )}
      {['recovery', 'ready', 'error', 'readonly'].includes(state.value) && (
        <button onClick={download}>current／previousをJSON書き出し</button>
      )}
      {['recovery', 'ready'].includes(state.value) && (
        <>
          <button onClick={() => setConfirm('new')}>新規開始</button>
          {previous.candidate && !previous.future && (
            <button onClick={() => setConfirm('previous')}>
              直前のセーブへ復元
            </button>
          )}
        </>
      )}
      {confirm && (
        <div role="alertdialog" aria-label="保存変更の確認">
          <p>
            {confirm === 'new'
              ? '現在の進行とプリセットを上書きして新規開始します。元データを書き出してから確定できます。'
              : confirm === 'cancel'
                ? '未保存の変更・勝利報酬を放棄し、最後の確定状態に戻ります。'
                : '進行とプリセットを直前世代へ巻き戻します。'}
          </p>
          {confirm === 'previous' && (
            <pre className="overflow-auto text-left">
              {JSON.stringify(previous.candidate, null, 2)}
            </pre>
          )}
          <button
            onClick={() =>
              void run(
                confirm === 'new'
                  ? game.newGame
                  : confirm === 'previous'
                    ? game.restorePrevious
                    : game.cancel,
              )
            }
          >
            確定
          </button>
          <button onClick={() => setConfirm(null)}>戻る</button>
        </div>
      )}
    </section>
  );
}
