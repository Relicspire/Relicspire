import { useState } from 'react';
import { DEFAULT_SETTINGS, type Settings } from '../state/save-model';
import { Dialog } from './Dialog';

const volumes = [
  ['masterVolume', '総音量'],
  ['bgmVolume', 'BGM'],
  ['seVolume', '効果音'],
  ['ambientVolume', '環境音'],
] as const;
export function SettingsPanel({
  initial,
  disabled,
  onSave,
  onClose,
  onDirty,
}: {
  initial: Settings;
  disabled: boolean;
  onSave: (settings: Settings) => Promise<void>;
  onClose: () => void;
  onDirty: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState({ ...initial });
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(false);
  const dirty = JSON.stringify(initial) !== JSON.stringify(draft);
  const change = (next: Settings) => {
    setDraft(next);
    onDirty(JSON.stringify(initial) !== JSON.stringify(next));
  };
  const close = () => {
    if (disabled) return;
    if (dirty) setConfirm(true);
    else onClose();
  };
  return (
    <section aria-label="設定">
      <h2>設定</h2>
      <p>
        変更は「設定を保存」で確定します。演出設定は戦闘の計算に影響しません。
      </p>
      <fieldset disabled={disabled} className="settings-fields">
        <legend>音量・演出</legend>
        {volumes.map(([key, label]) => (
          <label key={key}>
            {label} <output>{draft[key]}%</output>
            <input
              type="range"
              min="0"
              max="100"
              value={draft[key]}
              onChange={(e) =>
                change({ ...draft, [key]: Number(e.target.value) })
              }
            />
          </label>
        ))}
        <label>
          <input
            type="checkbox"
            checked={draft.muted}
            onChange={(e) => change({ ...draft, muted: e.target.checked })}
          />
          全音を消す
        </label>
        <label>
          演出速度
          <select
            value={draft.animationSpeed}
            onChange={(e) =>
              change({ ...draft, animationSpeed: Number(e.target.value) })
            }
          >
            {[0.5, 1, 2].map((speed) => (
              <option key={speed} value={speed}>
                {speed}倍
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={draft.screenShake}
            onChange={(e) =>
              change({ ...draft, screenShake: e.target.checked })
            }
          />
          画面揺れ
        </label>
        <label>
          <input
            type="checkbox"
            checked={draft.skipBattleAnimations}
            onChange={(e) =>
              change({ ...draft, skipBattleAnimations: e.target.checked })
            }
          />
          戦闘演出をスキップ
        </label>
        <button onClick={() => change({ ...DEFAULT_SETTINGS })}>
          設定を初期化
        </button>
        <button
          onClick={() =>
            void (async () => {
              setError('');
              try {
                await onSave(draft);
                onDirty(false);
                onClose();
              } catch (cause) {
                change({ ...initial });
                setError(String(cause));
              }
            })()
          }
        >
          設定を保存
        </button>
        <button onClick={close}>戻る</button>
      </fieldset>
      {error && <p role="alert">{error}</p>}
      {confirm && (
        <Dialog title="設定変更の取消" onClose={() => setConfirm(false)}>
          <p>未保存の設定を破棄して戻りますか？</p>
          <button
            onClick={() => {
              onDirty(false);
              onClose();
            }}
          >
            変更を破棄して戻る
          </button>
          <button onClick={() => setConfirm(false)}>編集を続ける</button>
        </Dialog>
      )}
    </section>
  );
}
