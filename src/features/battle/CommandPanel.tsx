import {
  titleFor,
  rejectionText,
  effectResultText,
  inactiveText,
} from './text';
import { useState } from 'react';
import {
  getBattleDisplay,
  getCommandDetails,
  previewCommand,
  type BattleSession,
  type PlayerCommand,
} from '../../game/battle';
import type { CharacterId, Element, SkillId } from '../../game/data/model';
import type { ParticipantId } from '../../game/data/battle';
import type { GameRelease } from '../../game/data/release-model';
import { DeltaDetails, SkillInfo } from './BattleInfo';

export function CommandPanel({
  session,
  actorId,
  release,
  disabled,
  onCommand,
}: {
  session: BattleSession<unknown>;
  actorId: CharacterId;
  release: GameRelease;
  disabled: boolean;
  onCommand: (command: PlayerCommand) => void;
}) {
  const [selected, setSelected] = useState<SkillId | null>(null);
  const [target, setTarget] = useState<ParticipantId | null>(null);
  const [element, setElement] = useState<Element | null>(null);
  const commands = getBattleDisplay(session).participants.find(
    (p) => p.participant.id === actorId,
  )!.commands;
  const candidate = (id: SkillId) => {
    const probe = getCommandDetails(session, {
      actorId,
      skillId: id,
      selectedTargetId: null,
      chosenElement: null,
    });
    const skill = probe.skill!;
    return {
      actorId,
      skillId: id,
      selectedTargetId: ['self', 'enemy-all', 'ally-all'].includes(skill.target)
        ? null
        : (probe.targets[0] ?? null),
      chosenElement: skill.elementChoices[0] ?? null,
    } satisfies PlayerCommand;
  };
  const command = selected
    ? {
        actorId,
        skillId: selected,
        selectedTargetId: target,
        chosenElement: element,
      }
    : null;
  const detail = command ? getCommandDetails(session, command) : null;
  const preview =
    command && detail?.check.ok ? previewCommand(session, command) : null;
  return (
    <article className="command-panel" aria-label="コマンド選択">
      <h3>{titleFor(release, actorId)}の手番</h3>
      <p>入力時間に制限はありません。</p>
      <div className="command-grid">
        {commands.map((id) => {
          const initial = candidate(id);
          const info = getCommandDetails(session, initial);
          return (
            <div key={id}>
              <button
                disabled={disabled || !info.check.ok}
                aria-pressed={selected === id}
                onClick={() => {
                  setSelected(id);
                  setTarget(initial.selectedTargetId);
                  setElement(initial.chosenElement);
                }}
              >
                {titleFor(release, id)}
              </button>
              <p>
                D {info.delayReference} TU ／ CD残り {info.cooldownRemaining} TU
              </p>
              {!info.check.ok && <p>{rejectionText[info.check.code]}</p>}
            </div>
          );
        })}
      </div>
      {command && detail?.skill && (
        <div className="command-selection">
          <h4>{titleFor(release, command.skillId)}</h4>
          <SkillInfo skill={detail.skill} release={release} />
          {!['self', 'enemy-all', 'ally-all'].includes(detail.skill.target) && (
            <label>
              対象
              <select
                aria-label="対象"
                disabled={disabled}
                value={target ?? ''}
                onChange={(e) => setTarget(e.target.value as ParticipantId)}
              >
                {detail.targets.map((id) => (
                  <option key={id} value={id}>
                    {titleFor(release, id)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!!detail.skill.elementChoices.length && (
            <label>
              属性
              <select
                aria-label="属性"
                disabled={disabled}
                value={element ?? ''}
                onChange={(e) => setElement(e.target.value as Element)}
              >
                {detail.skill.elementChoices.map((id) => (
                  <option key={id} value={id}>
                    {release.presentation.elements[id]}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p>
            現在SPDでのD {detail.delayReference} TU ／ CD残り{' '}
            {detail.cooldownRemaining} TU
          </p>
          {!detail.check.ok && (
            <p role="alert">{rejectionText[detail.check.code]}</p>
          )}
          {preview?.ok && (
            <details open className="command-preview">
              <summary>
                {preview.kind === 'immediate'
                  ? 'この行動の結果'
                  : '詠唱予約と現在の状態での参考値'}
              </summary>
              <p>
                {preview.kind === 'immediate'
                  ? 'この処理単位の結果です。以後の他者手番までの勝敗を保証しません。'
                  : '現在の状態での参考値。発動までの行動・効果終了・妨害で変化します。'}
              </p>
              <p>
                発動予定 {preview.activationAt} TU ／ CD期限{' '}
                {preview.cooldown
                  ? preview.cooldown.kind === 'running'
                    ? `${preview.cooldown.at} TU`
                    : `凍結残り ${preview.cooldown.remaining} TU`
                  : 'なし'}
              </p>
              <DeltaDetails
                session={session}
                delta={preview.committed}
                release={release}
              />
              {preview.reference && (
                <>
                  <h5>現在発動した場合の参考結果</h5>
                  <DeltaDetails
                    session={session}
                    delta={preview.reference}
                    release={release}
                  />
                </>
              )}
              {!!preview.precedingEvents.length && (
                <>
                  <h5>先に発生する予定</h5>
                  <ul>
                    {preview.precedingEvents.map((e) => (
                      <li key={e.id}>
                        {e.at} TU · {titleFor(release, e.participantId)} ·{' '}
                        {
                          {
                            ready: '手番',
                            'cast-complete': '詠唱発動',
                            'status-expiry': '状態期限',
                            'poison-tick': '毒',
                            'trap-expiry': '罠期限',
                            'break-recovery': 'ブレイク復帰',
                            'time-stop-end': '停止解除',
                          }[e.kind]
                        }
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {preview.expiringStatuses.map((s) => (
                <p key={`${s.participantId}-${s.statusId}`}>
                  発動予定前に期限切れ：{titleFor(release, s.participantId)} ·{' '}
                  {
                    release.presentation.statuses[
                      session.state.participants
                        .find((p) => p.id === s.participantId)!
                        .statuses.find((status) => status.id === s.statusId)!
                        .spec.familyId
                    ]
                  }{' '}
                  · {s.at} TU
                </p>
              ))}
              {preview.warnings.map((w, i) => (
                <p key={i}>
                  {titleFor(release, w.targetId)}：{effectResultText[w.code]}
                </p>
              ))}
              {preview.trapReferences.map((trap) => (
                <div key={trap.sequence}>
                  <p>
                    罠発動は将来の設置者能力に依存する参考値です。対象の行動開始前に発動し、設置者の戦闘不能・停止・ブレイク中は延期します。
                  </p>
                  {trap.inactiveReason && (
                    <p>{inactiveText[trap.inactiveReason]}</p>
                  )}
                  {trap.reference && (
                    <DeltaDetails
                      session={session}
                      delta={trap.reference}
                      release={release}
                    />
                  )}
                </div>
              ))}
            </details>
          )}
          <button
            disabled={disabled || !detail.check.ok}
            onClick={() => onCommand(command)}
          >
            コマンドを確定
          </button>
          <button
            disabled={disabled}
            onClick={() => {
              setSelected(null);
              setTarget(null);
              setElement(null);
            }}
          >
            選択を取り消す
          </button>
        </div>
      )}
    </article>
  );
}
