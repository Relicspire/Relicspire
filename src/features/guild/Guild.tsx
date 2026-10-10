import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import type { CharacterId, JobId } from '../../game/data/model';
import {
  changeJob,
  getGuildBuildDetails,
  getRemainingSkillPoints,
  getSkillPointLimit,
  getSkillRefund,
  learnSkill,
  removeSkill,
  resetSkills,
  type FormationResult,
  type FormationState,
} from '../../game/party';
import { deriveProgression } from '../../game/progression';
import { getContentAvailability } from '../../game/data/release';
import type { GameState } from '../../state/game';
import { Dialog } from '../../app/Dialog';
import { SkillDetails } from './SkillDetails';
import { EquipmentPanel } from './EquipmentPanel';
import { PresetPanel } from './PresetPanel';

type View = 'party' | 'equipment' | 'presets' | 'board';
export function Guild({
  game,
  disabled,
  onDirty,
}: {
  game: GameState;
  disabled: boolean;
  onDirty: (dirty: boolean) => void;
}) {
  const formation = useStore(game.formation).value;
  const progression = useStore(game.progression).value;
  const battle = useStore(game.battle).session;
  const [draft, setDraft] = useState<FormationState>(() =>
    structuredClone(formation!),
  );
  const [view, setView] = useState<View>('party');
  const [character, setCharacter] = useState<CharacterId>('party-1');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState<{
    title: string;
    description: string;
    run: () => void;
  } | null>(null);
  const changed = JSON.stringify(draft) !== JSON.stringify(formation);
  const dirty = changed || name !== '';
  useEffect(() => {
    onDirty(dirty);
  }, [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  if (!formation || !progression) return null;
  const release = game.release;
  const label = (id: string) => release.presentation.entries[id]?.name ?? id;
  const context = {
    defeatedEnemyIds: progression.defeatedEnemyIds,
    inBattle: battle !== null,
  };
  const blocked =
    disabled || context.inBattle || progression.location.kind !== 'guild';
  const change = (result: FormationResult<FormationState>) => {
    if (blocked) return;
    if (result.ok) {
      setDraft(result.value);
      setError('');
    } else setError(result.issues.map((issue) => issue.message).join(' ／ '));
  };
  const build = draft.party.find((entry) => entry.id === character)!;
  const details = getGuildBuildDetails(release.content, build, context);
  const unlocked = deriveProgression(
    release.campaign,
    progression,
  ).unlockedFloorIds;
  return (
    <section className="guild" aria-label="迷宮ギルド">
      <div className="guild-banner">
        <p className="eyebrow">GUILD / BUILD & REBUILD</p>
        <h2>迷宮ギルド</h2>
        <p>三人の編成を整え、次の試練へ。リビルドは何度でも無料です。</p>
      </div>
      <nav aria-label="ギルドメニュー">
        {(
          [
            ['party', 'パーティ・スキル'],
            ['equipment', '宝物庫・装備'],
            ['presets', 'プリセット'],
            ['board', '伝言板・階層'],
          ] as const
        ).map(([key, title]) => (
          <button
            key={key}
            disabled={disabled && game.status.getState().value !== 'readonly'}
            aria-pressed={view === key}
            onClick={() => setView(key)}
          >
            {title}
          </button>
        ))}
      </nav>
      <div className="guild-actions">
        <button
          disabled={blocked || !changed || name !== ''}
          onClick={() =>
            void (async () => {
              const latest = game.snapshot();
              if (
                !latest ||
                latest.progression.location.kind !== 'guild' ||
                game.battle.getState().session ||
                blocked
              )
                return;
              try {
                await game.update({ ...latest, ...draft });
                setName('');
              } catch (cause) {
                setError(String(cause));
              }
            })()
          }
        >
          変更を保存
        </button>
        <button
          disabled={blocked || !dirty}
          onClick={() =>
            setConfirm({
              title: '編成変更の取消',
              description:
                '未保存の編成・プリセット変更を破棄し、最後の確定状態へ戻ります。',
              run: () => {
                setDraft(structuredClone(formation));
                setName('');
                setError('');
              },
            })
          }
        >
          変更を取り消す
        </button>
        <p role="status">
          {dirty ? '未保存の編集があります' : '編成は保存済みです'}
        </p>
      </div>
      {error && <p role="alert">{error}</p>}
      {view === 'party' && (
        <>
          <div className="party-grid">
            {draft.party.map((entry) => (
              <button
                key={entry.id}
                disabled={
                  disabled && game.status.getState().value !== 'readonly'
                }
                aria-pressed={entry.id === character}
                onClick={() => setCharacter(entry.id)}
              >
                {label(entry.id)}
                <br />
                {label(entry.jobId)}
                <br />
                残り {getRemainingSkillPoints(
                  release.content,
                  entry,
                  context,
                )}{' '}
                / {getSkillPointLimit(context, release.campaign)} pt
              </button>
            ))}
          </div>
          <h3>{label(character)}の編成</h3>
          <label>
            ジョブ
            <select
              value={build.jobId}
              disabled={blocked}
              onChange={(e) => {
                const job = e.target.value as JobId;
                if (job === build.jobId) return;
                setConfirm({
                  title: 'ジョブ変更の確認',
                  description: `${label(job)}へ変更し、${label(character)}の習得スキルを全解除します。装備と他の二人は維持します。`,
                  run: () =>
                    change(
                      changeJob(
                        release.content,
                        draft,
                        character,
                        job,
                        context,
                      ),
                    ),
                });
              }}
            >
              {release.content.jobs.map((job) => (
                <option key={job.id} value={job.id}>
                  {label(job.id)}
                </option>
              ))}
            </select>
          </label>
          <p>{release.presentation.entries[build.jobId]?.description}</p>
          <dl className="build-stats">
            {Object.entries(details.stats.effectiveStats).map(
              ([key, value]) => (
                <div key={key}>
                  <dt>{key === 'maxHp' ? 'HP' : key.toUpperCase()}</dt>
                  <dd>{value}</dd>
                </div>
              ),
            )}
          </dl>
          <p>
            初期待機 {details.stats.initialWait} TU ／ 残りポイント{' '}
            {getRemainingSkillPoints(release.content, build, context)}
          </p>
          <button
            disabled={blocked || !build.learnedSkills.length}
            onClick={() =>
              setConfirm({
                title: '無料リビルドの確認',
                description: `${label(character)}の全スキルを解除してポイントを返却します。`,
                run: () =>
                  change(
                    resetSkills(release.content, draft, character, context),
                  ),
              })
            }
          >
            全スキルを解除
          </button>
          <div className="skill-routes">
            {(['a', 'b'] as const).map((route) => (
              <div key={route}>
                <h3>{route.toUpperCase()}ルート</h3>
                {details.skills
                  .filter((entry) => entry.node.id.includes(`-${route}`))
                  .map((detail) => (
                    <article className="skill-card" key={detail.node.id}>
                      <h4>
                        {route.toUpperCase()}
                        {detail.node.rank} · {label(detail.node.id)}
                      </h4>
                      <p>
                        {
                          release.presentation.entries[detail.node.id]
                            ?.description
                        }
                      </p>
                      <p>
                        費用 {detail.node.cost} pt ／ 前提：
                        {detail.node.prerequisites.map(label).join('・') ||
                          'なし'}
                      </p>
                      <p>
                        {detail.learned
                          ? detail.replacedBy
                            ? `習得済み・${label(detail.replacedBy)}に置換`
                            : '習得済み・有効コマンド'
                          : detail.missingPrerequisites.length
                            ? '前提スキルが未習得'
                            : detail.canLearn
                              ? '習得可能'
                              : 'ポイント不足'}
                      </p>
                      <SkillDetails detail={detail} release={release} />
                      <button
                        disabled={
                          blocked || (!detail.learned && !detail.canLearn)
                        }
                        onClick={() => {
                          if (!detail.learned)
                            change(
                              learnSkill(
                                release.content,
                                draft,
                                character,
                                detail.node.id,
                                context,
                              ),
                            );
                          else {
                            const refund = getSkillRefund(
                              release.content,
                              build,
                              detail.node.id,
                            );
                            setConfirm({
                              title: 'スキル解除の確認',
                              description: `${refund.removedSkillIds.map(label).join('・')}を解除し、${refund.refundedPoints} pt返却します。`,
                              run: () =>
                                change(
                                  removeSkill(
                                    release.content,
                                    draft,
                                    character,
                                    detail.node.id,
                                    context,
                                  ),
                                ),
                            });
                          }
                        }}
                      >
                        {label(detail.node.id)}を
                        {detail.learned ? '解除' : '習得'}
                      </button>
                    </article>
                  ))}
              </div>
            ))}
          </div>
        </>
      )}
      {view === 'equipment' && (
        <EquipmentPanel
          release={release}
          draft={draft}
          context={context}
          disabled={blocked}
          change={change}
        />
      )}
      {view === 'presets' && (
        <PresetPanel
          release={release}
          draft={draft}
          context={context}
          disabled={blocked}
          change={change}
          name={name}
          setName={setName}
        />
      )}
      {view === 'board' && (
        <>
          <h3>伝言板・階層選択</h3>
          {dirty && (
            <p>
              探索前に編成・プリセットの変更を保存または取り消してください。
            </p>
          )}
          {release.campaign.floors.map((floor, i) => {
            const available =
              getContentAvailability(
                release.campaign,
                release.scope,
                floor.id,
              ) === 'playable';
            const open = unlocked.includes(floor.id);
            const text = release.presentation.floors[floor.id];
            return (
              <article className="floor-card" key={floor.id}>
                <h4>
                  第{i + 1}階層 · {label(floor.id)}
                </h4>
                <p>
                  {open
                    ? available
                      ? '解放済み'
                      : '解放済み・この版では未実装'
                    : '未解放'}
                </p>
                {text && (
                  <>
                    <p>{text.theme}</p>
                    <p>{text.entryText}</p>
                    <ul>
                      {text.hints.map((hint, j) => (
                        <li key={j}>{hint}</li>
                      ))}
                    </ul>
                  </>
                )}
                <button
                  disabled={blocked || dirty || !available || !open}
                  onClick={() =>
                    void (async () => {
                      const latest = game.snapshot();
                      if (!latest || blocked || dirty) return;
                      try {
                        await game.warp(floor.id);
                      } catch (cause) {
                        setError(String(cause));
                      }
                    })()
                  }
                >
                  第{i + 1}階層へワープ
                </button>
              </article>
            );
          })}
        </>
      )}
      {confirm && (
        <Dialog title={confirm.title} onClose={() => setConfirm(null)}>
          <p>{confirm.description}</p>
          <button
            disabled={blocked}
            onClick={() => {
              confirm.run();
              setConfirm(null);
            }}
          >
            候補へ反映
          </button>
          <button onClick={() => setConfirm(null)}>取消</button>
        </Dialog>
      )}
    </section>
  );
}
