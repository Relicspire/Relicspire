import { useState } from 'react';
import { useStore } from 'zustand';
import type { GameState } from '../state/game';
import { Dialog } from './Dialog';

/** 保存管理器に接続する復旧画面。起動・所有権の再取得は呼出元が担当する。 */
export function SavePanel({
  game,
  recheck,
  writesEnabled = true,
}: {
  game: GameState;
  recheck: () => Promise<void>;
  writesEnabled?: boolean;
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
  const future = game.isFutureSave();
  const busy = state.value === 'saving' || state.value === 'loading';
  const writable = writesEnabled && !future && state.value !== 'readonly';
  return (
    <section aria-label="セーブ管理" className="space-y-4 p-6 text-slate-100">
      <h2>セーブ管理</h2>
      {future && (
        <p role="alert">
          このセーブは新版のものです。対応する新版アプリで開いてください。新規開始・復元を含む上書きはできません。
        </p>
      )}
      <fieldset disabled={busy}>
        <legend className="sr-only">セーブ操作</legend>
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
        {state.changes.length > 0 && writable && (
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
          <button disabled={!writable} onClick={() => void run(game.newGame)}>
            冒険を始める
          </button>
        )}
        {state.value === 'error' && game.hasPendingSave() && (
          <>
            <button disabled={!writable} onClick={() => void run(game.retry)}>
              保存を再試行
            </button>
            <button disabled={!writable} onClick={() => setConfirm('cancel')}>
              変更・未保存の勝利を取り消す
            </button>
          </>
        )}
        {['error', 'readonly', 'recovery'].includes(state.value) &&
          !game.hasPendingSave() && (
            <button onClick={() => void run(recheck)}>再確認・読み直し</button>
          )}
        {['recovery', 'ready', 'error', 'readonly'].includes(state.value) && (
          <button onClick={download}>current／previousをJSON書き出し</button>
        )}
        {['recovery', 'ready'].includes(state.value) && writable && (
          <>
            <button onClick={() => setConfirm('new')}>新規開始</button>
            {previous.candidate && !previous.future && (
              <button onClick={() => setConfirm('previous')}>
                直前のセーブへ復元
              </button>
            )}
          </>
        )}
      </fieldset>
      {confirm && (
        <Dialog
          title="保存変更の確認"
          onClose={() => {
            if (!busy) setConfirm(null);
          }}
        >
          {error && <p role="alert">{error}</p>}
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
            disabled={busy || !writable}
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
          <button disabled={busy} onClick={() => setConfirm(null)}>
            戻る
          </button>
        </Dialog>
      )}
    </section>
  );
}
