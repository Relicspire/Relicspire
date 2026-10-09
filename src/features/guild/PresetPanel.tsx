import { useState } from 'react';
import type { GameRelease } from '../../game/data/release';
import {
  createPreset,
  deletePreset,
  overwritePreset,
  previewPresetRepair,
  recallPreset,
  renamePreset,
  sortPresets,
  validatePreset,
  MAX_PRESETS,
  type FormationContext,
  type FormationResult,
  type FormationState,
} from '../../game/party';
import { Dialog } from '../../app/Dialog';

export function PresetPanel({
  release,
  draft,
  context,
  disabled,
  change,
  name,
  setName,
}: {
  release: GameRelease;
  draft: FormationState;
  context: FormationContext;
  disabled: boolean;
  change: (result: FormationResult<FormationState>) => void;
  name: string;
  setName: (name: string) => void;
}) {
  const [confirm, setConfirm] = useState<{
    title: string;
    text: string[];
    run: () => FormationResult<FormationState>;
    canApply: boolean;
  } | null>(null);
  const submit = (result: FormationResult<FormationState>) => {
    change(result);
    if (result.ok) setName('');
  };
  return (
    <>
      <h3>
        構成プリセット {draft.presets.length} / {MAX_PRESETS}
      </h3>
      <p>
        プリセットは編成だけを記録します。登録・改名などで候補へ反映し、最後に「変更を保存」で確定してください。
      </p>
      <label>
        プリセット名
        <input
          value={name}
          disabled={disabled}
          onChange={(e) => setName(e.target.value)}
          placeholder="1〜24文字"
        />
      </label>
      <button
        disabled={
          disabled || draft.presets.length >= MAX_PRESETS || !name.trim()
        }
        onClick={() =>
          submit(
            createPreset(
              release.content,
              draft,
              {
                id: `preset-${crypto.randomUUID()}`,
                name,
                now: Date.now(),
                contentVersion: release.contentVersion,
              },
              context,
            ),
          )
        }
      >
        現在の編成を登録
      </button>
      {sortPresets(draft.presets).map((preset) => {
        const issues = validatePreset(release.content, preset, context);
        return (
          <article className="preset-card" key={preset.id}>
            <h4>{preset.name}</h4>
            <p>
              内容版 {preset.contentVersion} ／ 更新{' '}
              {new Date(preset.updatedAt).toLocaleString('ja-JP', {
                timeZone: 'Asia/Tokyo',
              })}
            </p>
            <p>
              {(Array.isArray(preset.party) ? preset.party : [])
                .map((build) =>
                  typeof build?.jobId === 'string'
                    ? (release.presentation.entries[build.jobId]?.name ??
                      build.jobId)
                    : '構造が不正',
                )
                .join(' ／ ')}
            </p>
            {issues.length > 0 && (
              <p>
                呼出不可：{issues.map((issue) => issue.message).join(' ／ ')}
              </p>
            )}
            <div className="guild-actions">
              <button
                disabled={disabled || issues.length > 0}
                onClick={() =>
                  setConfirm({
                    title: 'プリセット呼出の確認',
                    text: [`${preset.name}で3人の編成候補を置き換えます。`],
                    run: () =>
                      recallPreset(release.content, draft, preset.id, context),
                    canApply: true,
                  })
                }
              >
                {preset.name}を呼び出す
              </button>
              <button
                disabled={disabled || !name.trim()}
                onClick={() =>
                  submit(
                    renamePreset(
                      draft,
                      preset.id,
                      name,
                      Math.max(Date.now(), preset.updatedAt),
                    ),
                  )
                }
              >
                {preset.name}を改名
              </button>
              <button
                disabled={disabled}
                onClick={() =>
                  setConfirm({
                    title: 'プリセット上書きの確認',
                    text: [`${preset.name}を現在の編成候補で上書きします。`],
                    run: () =>
                      overwritePreset(
                        release.content,
                        draft,
                        {
                          id: preset.id,
                          name: name || preset.name,
                          now: Math.max(Date.now(), preset.updatedAt),
                          contentVersion: release.contentVersion,
                        },
                        context,
                      ),
                    canApply: true,
                  })
                }
              >
                {preset.name}を上書き
              </button>
              <button
                disabled={disabled}
                onClick={() =>
                  setConfirm({
                    title: 'プリセット削除の確認',
                    text: [
                      `${preset.name}を削除します。現在の編成は維持します。`,
                    ],
                    run: () => deletePreset(draft, preset.id),
                    canApply: true,
                  })
                }
              >
                {preset.name}を削除
              </button>
              {issues.length > 0 && (
                <button
                  disabled={disabled}
                  onClick={() => {
                    const repair = previewPresetRepair(
                      release.content,
                      preset,
                      context,
                    );
                    setConfirm({
                      title: '旧プリセットの修復確認',
                      text: repair.ok
                        ? [
                            ...repair.value.changes.map(
                              (entry) =>
                                `${entry.path}：${entry.before} → ${entry.after ?? '解除'}（${entry.reason}）`,
                            ),
                            ...repair.value.issues.map(
                              (issue) => issue.message,
                            ),
                            '修復した編成だけを候補へ呼び出します。保存済みプリセット原本は保持します。',
                          ]
                        : repair.issues.map((issue) => issue.message),
                      run: () =>
                        recallPreset(
                          release.content,
                          draft,
                          preset.id,
                          context,
                          { repair: true },
                        ),
                      canApply: repair.ok && repair.value.issues.length === 0,
                    });
                  }}
                >
                  {preset.name}の修復を確認
                </button>
              )}
            </div>
          </article>
        );
      })}
      {confirm && (
        <Dialog title={confirm.title} onClose={() => setConfirm(null)}>
          <ul>
            {confirm.text.map((text, i) => (
              <li key={i}>{text}</li>
            ))}
          </ul>
          <button
            disabled={disabled || !confirm.canApply}
            onClick={() => {
              submit(confirm.run());
              setConfirm(null);
            }}
          >
            候補へ反映
          </button>
          <button onClick={() => setConfirm(null)}>取消</button>
        </Dialog>
      )}
    </>
  );
}
