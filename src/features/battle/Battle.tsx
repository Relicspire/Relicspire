import { titleFor, resultText, inactiveText, effectResultText } from './text';
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import type { GameState } from '../../state/game';
import {
  getBattleDisplay,
  getDisplayLog,
  getInputActor,
  getTrapReference,
} from '../../game/battle';
import { Dialog } from '../../app/Dialog';
import { ExplorationView } from '../exploration/ExplorationView';
import { CommandPanel } from './CommandPanel';
import { Timeline } from './Timeline';
import {
  EnemyActions,
  StatusDetails,
  DeltaDetails,
  LogEntry,
} from './BattleInfo';

export function Battle({
  game,
  disabled,
  reducedMotion,
}: {
  game: GameState;
  disabled: boolean;
  reducedMotion: boolean;
}) {
  const { session, receipt, paused, feedback, changes, exitRequested } =
    useStore(game.battle);
  const settings = useStore(game.settings).value!;
  const status = useStore(game.status);
  const [confirmEscape, setConfirmEscape] = useState(false);
  const [error, setError] = useState('');
  const [transitioning, setTransitioning] = useState(false);
  const { release } = game;
  const blocked =
    disabled || paused || confirmEscape || transitioning || exitRequested;
  const actor = session ? getInputActor(session) : null;
  const skip = reducedMotion || settings.skipBattleAnimations;
  useEffect(() => {
    if (!session || blocked || actor || session.state.result !== 'ongoing')
      return;
    const timer = window.setTimeout(
      () => {
        if (document.visibilityState === 'hidden') return;
        try {
          game.advance(session);
        } catch (cause) {
          setError(String(cause));
        }
      },
      skip ? 0 : 550 / settings.animationSpeed,
    );
    return () => window.clearTimeout(timer);
  }, [session, actor, blocked, game, skip, settings.animationSpeed]);
  useEffect(() => {
    if (!session || disabled || session.state.result !== 'victory') return;
    void game.victory().catch(() => {
      /* 共通セーブ管理に保存失敗候補を残す。 */
    });
  }, [session, disabled, game]);
  const run = async (action: () => Promise<void>) => {
    if (disabled || transitioning) return;
    setTransitioning(true);
    try {
      await action();
      setError('');
    } catch (cause) {
      setError(String(cause));
    } finally {
      setTransitioning(false);
    }
  };
  if (receipt)
    return (
      <section aria-label="勝利報酬">
        <h2>勝利報酬を保存しました</h2>
        <h3>{titleFor(release, receipt.enemyId)}を討伐</h3>
        <p>
          各人のスキル予算 +{receipt.reward.skillPointsPerCharacter}ポイント
        </p>
        <ul>
          {receipt.reward.equipment.map((e) => (
            <li key={e.id}>
              {titleFor(release, e.id)} × {e.quantity}
            </li>
          ))}
        </ul>
        {receipt.reward.unlockFloorId && (
          <p>
            第{Number(receipt.reward.unlockFloorId.slice(-2))}階層を解放
            {!release.scope.playableFloorIds.includes(
              receipt.reward.unlockFloorId,
            ) && '（この版では未収録）'}
          </p>
        )}
        {receipt.enemyId === 'boss-01' && (
          <p>
            第1階層クリア。未討伐の守護者への挑戦やギルドでのリビルドを続けられます。
          </p>
        )}
        <button
          disabled={disabled || transitioning}
          onClick={() => game.dismissBattleResult()}
        >
          探索を続ける
        </button>
      </section>
    );
  if (!session) return null;
  const display = getBattleDisplay(session);
  const forecast = display.enemy.forecast;
  const logs = getDisplayLog(session);
  const cueEvent = [...logs]
    .reverse()
    .find((e) =>
      [
        'damage',
        'heal',
        'break',
        'death',
        'cancel',
        'shift',
        'status',
        'revive',
        'cast',
        'command',
      ].includes(e.kind),
    );
  const cue = cueEvent
    ? ['heal', 'revive'].includes(cueEvent.kind)
      ? 'heal'
      : cueEvent.kind === 'death'
        ? 'death'
        : cueEvent.kind === 'break'
          ? 'break'
          : ['cancel', 'shift', 'status', 'cast'].includes(cueEvent.kind)
            ? 'status'
            : cueEvent.kind === 'damage'
              ? 'damage'
              : 'command'
    : null;
  return (
    <section className="battle" aria-label="バトル">
      <p className="eyebrow">
        {resultText[session.state.result]} · 現在 {display.now} TU
      </p>
      <h2>戦闘開始：{titleFor(release, session.setup.enemyId)}</h2>
      <ExplorationView
        location={`battle-${session.log.at(-1)?.sequence}`}
        enemy={display.participants[3]!.participant.hp > 0}
        paths={0}
        paused={
          disabled || paused || confirmEscape || transitioning || exitRequested
        }
        reducedMotion={skip}
        speed={settings.animationSpeed}
        cue={cue}
        cueToken={cueEvent?.sequence ?? 0}
        shake={settings.screenShake}
      />
      <p role="status" className="battle-feedback">
        {logs.slice(-4).map((e) => (
          <span key={e.sequence}>
            <LogEntry entry={e} release={release} />
            <br />
          </span>
        ))}
      </p>
      {error && <p role="alert">{error}</p>}
      {session.state.result === 'ongoing' && (
        <>
          <button
            disabled={
              disabled || confirmEscape || transitioning || exitRequested
            }
            onClick={() => game.pauseBattle(!paused)}
          >
            {paused ? '戦闘を再開' : '戦闘を一時停止'}
          </button>
          <button
            disabled={
              disabled || confirmEscape || transitioning || exitRequested
            }
            onClick={() => setConfirmEscape(true)}
          >
            逃走
          </button>
          {paused && <p>戦闘の進行と演出を停止しています。</p>}
        </>
      )}
      <Timeline session={session} release={release} />
      <div className="battle-participants">
        {display.participants.map(
          ({ participant: p, effectiveStats: stats }) => (
            <article
              key={p.id}
              className={actor === p.id ? 'current-actor' : ''}
            >
              <h3>
                {p.side === 'party' ? `● ${p.slot + 1} ` : '◆ '}
                {titleFor(release, p.id)}
              </h3>
              {p.side === 'party' && <p>{titleFor(release, p.jobId)}</p>}
              <p>
                HP {p.hp} / {stats.maxHp}
                {p.hp === 0 && ' · 戦闘不能'}
              </p>
              <progress
                aria-label={`${titleFor(release, p.id)} HP`}
                value={p.hp}
                max={stats.maxHp}
              />
              {p.side === 'enemy' && (
                <>
                  <p>
                    ブレイクゲージ {p.breakGauge} / {p.maxBreakGauge}
                  </p>
                  <progress
                    aria-label="敵ブレイクゲージ"
                    value={p.breakGauge}
                    max={p.maxBreakGauge}
                  />
                  <p>
                    弱点：
                    {
                      release.presentation.elements[
                        display.enemy.definition.weakness
                      ]
                    }{' '}
                    ／ 耐性：
                    {
                      release.presentation.elements[
                        display.enemy.definition.resistance
                      ]
                    }
                  </p>
                  <p>フェーズ {p.phaseIndex + 1}</p>
                </>
              )}
              <p>
                {display.schedules
                  .filter((s) => s.participantId === p.id)
                  .map(
                    (s) =>
                      `${s.kind === 'casting' ? '詠唱発動' : s.kind === 'stopped' ? '停止解除' : s.kind === 'broken' ? 'ブレイク復帰' : '次の手番'}まで ${s.remaining} TU`,
                  )
                  .join('') || (p.hp === 0 ? '戦闘不能' : '予定なし')}
              </p>
              {!!p.statuses.length && (
                <p className="status-badges">
                  {p.statuses
                    .map((s) => release.presentation.statuses[s.spec.familyId])
                    .join('・')}
                </p>
              )}
              <details>
                <summary>状態・能力・予定を見る</summary>
                <p>
                  ATK {stats.atk} · MAG {stats.mag} · DEF {stats.def} · MDEF{' '}
                  {stats.mdef} · SPD {stats.spd}
                </p>
                <StatusDetails session={session} id={p.id} release={release} />
                {display.schedules
                  .filter((s) => s.participantId === p.id)
                  .map((s) => (
                    <p key={s.participantId}>
                      次回予定まで {s.remaining} TU
                      {s.skillId && ` · ${titleFor(release, s.skillId)}`}
                      {s.frozenRemaining !== null &&
                        ` ／ 凍結残り ${s.frozenRemaining} TU`}
                      {s.recoveryWaitReference !== null &&
                        ` ／ 復帰後待機の参考値 ${s.recoveryWaitReference} TU`}
                    </p>
                  ))}
                <p>
                  CD：
                  {p.cooldowns
                    .map(
                      (c) =>
                        `${titleFor(release, c.id)} ${c.timer.kind === 'frozen' ? `凍結残り ${c.timer.remaining}` : Math.max(0, c.timer.at - session.state.now)} TU`,
                    )
                    .join(' ／ ') || 'なし'}
                </p>
              </details>
            </article>
          ),
        )}
      </div>
      <article aria-label="敵の予告">
        <h3>{forecast.isCasting ? '予約済みの詠唱' : '敵の次回行動'}</h3>
        <p>
          {titleFor(release, forecast.command.skillId)} →{' '}
          {forecast.targets.map((id) => titleFor(release, id)).join('・') ||
            '適格対象なし'}
          {forecast.startsAt !== null && ` ／ 開始 ${forecast.startsAt} TU`}
          {forecast.activatesAt !== null &&
            ` ／ 発動 ${forecast.activatesAt} TU`}
          {forecast.frozenRemaining !== null &&
            ` ／ 凍結残り ${forecast.frozenRemaining} TU`}
          {forecast.blocked && ' ／ 現在は行動不能'}
        </p>
        {display.enemy.reservedCast && display.enemy.nextColumn && (
          <p>
            詠唱の後の列：{titleFor(release, display.enemy.nextColumn.skillId)}
            （発動後の状態で対象を選択）
          </p>
        )}
        <EnemyActions
          enemy={display.enemy.definition}
          release={release}
          phaseIndex={forecast.phaseIndex}
          actionIndex={forecast.actionIndex}
        />
      </article>
      {!!display.traps.length && (
        <details>
          <summary>設置罠・期限・発動参考値</summary>
          {display.traps.map((trap) => {
            const reference = getTrapReference(session, trap.sequence);
            return (
              <article key={trap.sequence}>
                <p>
                  {titleFor(release, trap.sourceId)} →{' '}
                  {titleFor(release, trap.targetId)} ／{' '}
                  {trap.expires.kind === 'frozen'
                    ? `凍結残り ${trap.expires.remaining}`
                    : `期限まで ${Math.max(0, trap.expires.at - session.state.now)}`}{' '}
                  TU。対象の行動開始前に発動。設置者が戦闘不能・停止・ブレイク中なら延期。将来の能力に依存する参考値です。
                </p>
                {reference?.inactiveReason && (
                  <p>{inactiveText[reference.inactiveReason]}</p>
                )}
                {reference?.reference && (
                  <DeltaDetails
                    session={session}
                    delta={reference.reference}
                    release={release}
                  />
                )}
              </article>
            );
          })}
        </details>
      )}
      {session.state.result === 'ongoing' &&
        (actor ? (
          <CommandPanel
            key={`${actor}-${display.now}-${session.log.at(-1)?.sequence}`}
            session={session}
            actorId={actor}
            release={release}
            disabled={blocked}
            onCommand={(command) => {
              if (blocked) return;
              try {
                game.command(command, session);
              } catch (cause) {
                setError(String(cause));
              }
            }}
          />
        ) : (
          <p>次の入力待ちまで進行中…</p>
        ))}
      {session.state.result !== 'ongoing' && (
        <article aria-label="戦闘結果">
          <h3>{resultText[session.state.result]}</h3>
          {session.state.result === 'victory' ? (
            <>
              <p>
                各人に{display.enemy.definition.reward.skillPointsPerCharacter}
                ポイント
                {display.enemy.definition.reward.equipment
                  .map((e) => ` ／ ${titleFor(release, e.id)} × ${e.quantity}`)
                  .join('')}
              </p>
              <p role="status">
                {status.value === 'saving'
                  ? '勝利報酬を保存中…次の操作はお待ちください。'
                  : status.value === 'error'
                    ? '勝利報酬は未保存です。下のセーブ管理から再試行、または確認して放棄できます。'
                    : '勝利報酬の保存を待っています。'}
              </p>
            </>
          ) : (
            <>
              <p>報酬はありません。開始前の編成と探索の親分岐へ戻れます。</p>
              <button
                disabled={disabled || transitioning}
                onClick={() => void run(() => game.leaveBattle())}
              >
                探索へ戻る
              </button>
              <button
                disabled={disabled || transitioning}
                onClick={() =>
                  void run(async () => {
                    await game.leaveBattle();
                    await game.returnToGuild();
                  })
                }
              >
                拠点へ帰還
              </button>
              <button
                disabled={disabled || transitioning}
                onClick={() =>
                  void run(async () => {
                    await game.retryBattle();
                  })
                }
              >
                同じ編成でリトライ
              </button>
            </>
          )}
        </article>
      )}
      {feedback && (
        <details>
          <summary>直前の処理単位の結果</summary>
          <DeltaDetails delta={feedback} release={release} session={session} />
        </details>
      )}
      <details>
        <summary>戦闘ログ（直近200件）</summary>
        <ol className="battle-log">
          {logs.map((e) => (
            <li key={e.sequence}>
              <LogEntry entry={e} release={release} />
            </li>
          ))}
        </ol>
        <h4>HP・ゲージ変化（直近200件）</h4>
        <ul>
          {changes.map((c, i) => (
            <li key={i}>
              {c.now} TU · {titleFor(release, c.id)} · HP {c.hp >= 0 ? '+' : ''}
              {c.hp}
              {c.gauge !== null &&
                ` ／ ゲージ ${c.gauge >= 0 ? '+' : ''}${c.gauge}`}
            </li>
          ))}
        </ul>
        <h4>直近の効果・不成立理由</h4>
        {session.effectResults.slice(-200).map((e) => (
          <p key={e.sequence}>
            {e.now} TU · {titleFor(release, e.actorId)} →{' '}
            {titleFor(release, e.targetId)} · {effectResultText[e.code]}
            {e.cause && `（${effectResultText[e.cause]}）`}
          </p>
        ))}
      </details>
      {exitRequested && !disabled && (
        <Dialog
          title="戦闘を離れる"
          onClose={() => {
            if (!transitioning) game.continueBattle();
          }}
        >
          <p>
            戦闘の進行と演出を停止しました。逃走・同じ編成でのリトライ・続行を選んでください。
          </p>
          {error && <p role="alert">{error}</p>}
          <button
            disabled={transitioning}
            onClick={() =>
              void run(async () => {
                game.escape(session);
                await game.leaveBattle();
              })
            }
          >
            逃走して探索へ戻る
          </button>
          <button
            disabled={transitioning}
            onClick={() => void run(() => game.retryBattle())}
          >
            同じ編成でリトライ
          </button>
          <button
            disabled={transitioning}
            onClick={() => game.continueBattle()}
          >
            戦闘を続ける
          </button>
        </Dialog>
      )}
      {confirmEscape && !disabled && (
        <Dialog title="逃走の確認" onClose={() => setConfirmEscape(false)}>
          <p>
            報酬を得ずに戦闘を終了します。開始前の編成・探索位置へ戻るか、同じ編成でリトライできます。
          </p>
          <button
            onClick={() => {
              game.escape(session);
              setConfirmEscape(false);
            }}
          >
            逃走を確定
          </button>
          <button onClick={() => setConfirmEscape(false)}>戦闘を続ける</button>
        </Dialog>
      )}
    </section>
  );
}
