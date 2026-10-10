import type { GameRelease } from '../../game/data/release-model';
import type { EnemyDefinition, SkillDefinition } from '../../game/data/model';
import type {
  BattleLogEntry,
  BattleSession,
  BattleDelta,
} from '../../game/battle';
import { getStatusDetails, getMainSchedules } from '../../game/battle';
import type { ParticipantId } from '../../game/data/battle';
import { effectText, statusText } from './effect-text';

import {
  titleFor,
  inactiveText,
  resultText,
  eventText,
  effectResultText,
} from './text';

export function SkillInfo({
  skill,
  release,
}: {
  skill: SkillDefinition;
  release: GameRelease;
}) {
  return (
    <div className="skill-info">
      <p>
        対象：{release.presentation.targets[skill.target]} ／ 詠唱{' '}
        {skill.castTime} TU ／ 基礎D {skill.delay} TU ／ CD {skill.cooldown} TU
      </p>
      <p>{release.presentation.entries[skill.id]?.description}</p>
      <ol>
        {skill.effects.map((effect, i) => (
          <li key={i}>
            {effectText(effect, release)}
            {'attached' in effect &&
              effect.attached.map((attached, j) => (
                <p key={j}>付随効果：{effectText(attached, release)}</p>
              ))}
          </li>
        ))}
      </ol>
    </div>
  );
}
const selectionText = {
  'lowest-hp': 'HPが最も低い味方',
  'highest-atk': 'ATKが最も高い味方',
  'highest-mag': 'MAGが最も高い味方',
  'highest-spd': 'SPDが最も高い味方',
  all: '適格対象全体',
  self: '敵自身',
};
export function EnemyActions({
  enemy,
  release,
  phaseIndex,
  actionIndex,
}: {
  enemy: EnemyDefinition;
  release: GameRelease;
  phaseIndex?: number;
  actionIndex?: number;
}) {
  return (
    <details>
      <summary>全行動列・移行条件・妨害耐性を見る</summary>
      <p>
        削り耐性 {enemy.breakResistance / 100}% ／ 後退耐性{' '}
        {enemy.knockbackResistance / 100}% ／ 詠唱中断{' '}
        {enemy.cancelImmune ? '無効' : '有効'} ／ 時間停止{' '}
        {enemy.timeStopImmune ? '無効' : '有効'} ／ 無効属性：
        {enemy.immuneElements
          ?.map((e) => release.presentation.elements[e])
          .join('・') || 'なし'}
      </p>
      {enemy.phases.map((phase, i) => (
        <article key={phase.id}>
          <h4>
            フェーズ{i + 1}
            {phaseIndex === i ? '（現在）' : ''}：
            {i === 0 ? '初期状態' : `HP ${phase.hpThreshold / 100}%以下で移行`}
          </h4>
          <p>末尾まで行動したら先頭へ戻ります。</p>
          <ol>
            {phase.actions.map((action, j) => (
              <li
                key={j}
                aria-current={
                  phaseIndex === i && actionIndex === j ? 'step' : undefined
                }
              >
                <strong>
                  {titleFor(release, action.skillId)}
                  {phaseIndex === i && actionIndex === j ? '（次の列）' : ''}
                </strong>{' '}
                ／ 対象規則：{selectionText[action.selection]}
                <SkillInfo
                  skill={release.content.skills.find(
                    (s) => s.id === action.skillId,
                  )!}
                  release={release}
                />
              </li>
            ))}
          </ol>
        </article>
      ))}
    </details>
  );
}
export function StatusDetails({
  session,
  id,
  release,
}: {
  session: BattleSession<unknown>;
  id: ParticipantId;
  release: GameRelease;
}) {
  const statuses = getStatusDetails(session, id);
  return (
    <div>
      {statuses.length === 0 ? (
        <p>状態効果なし</p>
      ) : (
        <ul>
          {statuses.map(
            ({
              status,
              remaining,
              frozen,
              nextTickRemaining,
              inactiveReason,
            }) => (
              <li key={status.id}>
                {statusText(status.spec, release)} ／ 付与者：
                {titleFor(release, status.sourceId)} ／{' '}
                {frozen ? '凍結残り' : '期限まで'} {remaining} TU ／ 残り回数：
                {status.remainingCharges ?? '制限なし'} ／{' '}
                {status.dispellable ? '解除可能' : '解除不可'}
                {nextTickRemaining !== null &&
                  ` ／ 次の周期発動 ${nextTickRemaining} TU`}
                {inactiveReason
                  ? ` ／ 一時無効：${inactiveText[inactiveReason]}`
                  : ' ／ 有効'}
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}
export function LogEntry({
  entry,
  release,
}: {
  entry: BattleLogEntry;
  release: GameRelease;
}) {
  const detail = entry.detail
    ? ((release.presentation.statuses as Record<string, string>)[
        entry.detail
      ] ??
      (resultText as Record<string, string>)[entry.detail] ??
      (
        {
          advance: '前進',
          delay: '後退',
          set: '設置',
          trigger: '発動',
          trap: '罠',
        } as Record<string, string>
      )[entry.detail])
    : null;
  return (
    <span>
      {entry.now} TU · {eventText[entry.kind]} ·{' '}
      {titleFor(release, entry.actorId)}
      {entry.targetId && ` → ${titleFor(release, entry.targetId)}`}
      {entry.skillId && ` · ${titleFor(release, entry.skillId)}`}
      {entry.amount !== null && ` · ${entry.amount}`}
      {detail && ` · ${detail}`}
    </span>
  );
}
export function DeltaDetails({
  delta,
  release,
  session,
}: {
  delta: BattleDelta;
  session: BattleSession<unknown>;
  release: GameRelease;
}) {
  const afterSession = { ...session, state: delta.after };
  const schedules = getMainSchedules(afterSession);
  return (
    <div className="prediction-details">
      <p>処理単位後：{resultText[delta.after.result]}</p>
      <ul>
        {delta.participants
          .filter((p) => JSON.stringify(p.before) !== JSON.stringify(p.after))
          .map((p) => (
            <li key={p.id}>
              <strong>{titleFor(release, p.id)}</strong>：HP {p.before.hp} →{' '}
              {p.after.hp}（{p.hpChange >= 0 ? '+' : ''}
              {p.hpChange}）
              {p.gaugeChange !== null &&
                p.after.side === 'enemy' &&
                ` ／ ゲージ ${p.after.breakGauge}（${p.gaugeChange >= 0 ? '+' : ''}${p.gaugeChange}）`}
              {p.after.side === 'enemy' &&
                ` ／ フェーズ ${p.after.phaseIndex + 1}`}
              <p>
                次回予定：
                {schedules.find((s) => s.participantId === p.id)?.remaining ??
                  'なし'}{' '}
                TU ／{' '}
                {p.after.timeStopUntil !== null
                  ? '時間停止中'
                  : p.after.action.kind === 'dead'
                    ? '戦闘不能'
                    : p.after.action.kind === 'casting'
                      ? '詠唱中'
                      : p.after.action.kind === 'broken'
                        ? 'ブレイク中'
                        : '通常'}
              </p>
              <StatusDetails
                session={afterSession}
                id={p.id}
                release={release}
              />
              {!!p.after.cooldowns.length && (
                <p>
                  CD：
                  {p.after.cooldowns
                    .map(
                      (c) =>
                        `${titleFor(release, c.id)} ${c.timer.kind === 'frozen' ? `凍結残り${c.timer.remaining}` : Math.max(0, c.timer.at - delta.after.now)} TU`,
                    )
                    .join(' ／ ')}
                </p>
              )}
            </li>
          ))}
      </ul>
      <ul>
        {delta.events.map((e) => (
          <li key={e.sequence}>
            <LogEntry entry={e} release={release} />
          </li>
        ))}
      </ul>
      {delta.effectResults.map((e) => (
        <p key={e.sequence}>
          {titleFor(release, e.targetId)}：
          {e.outcome === 'rejected' ? '不成立' : '成立'} ·{' '}
          {effectResultText[e.code]}
          {e.cause && `（${effectResultText[e.cause]}）`}
          {e.code === 'status-refreshed' &&
            '。強度・付与者・残り回数は変更せず、期限のみ延長'}
        </p>
      ))}
    </div>
  );
}
