import { useState } from 'react';
import { getMainSchedules, type BattleSession } from '../../game/battle';
import type { GameRelease } from '../../game/data/release-model';
import { titleFor } from './text';
const scheduleText = {
  ready: '入力待ち／未処理',
  waiting: '次の手番',
  casting: '詠唱発動',
  broken: 'ブレイク復帰',
  stopped: '停止解除',
};
export function Timeline({
  session,
  release,
}: {
  session: BattleSession<unknown>;
  release: GameRelease;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const schedules = getMainSchedules(session);
  return (
    <div className="battle-timeline" aria-label="300 TUタイムライン">
      <div className="timeline-scale">
        <span>{session.state.now + 300} TU</span>
        <span>現在 {session.state.now} TU</span>
      </div>
      <div
        className="timeline-track"
        style={{ height: `${Math.max(1, schedules.length) * 58}px` }}
      >
        {schedules.map((s, i) => (
          <button
            key={s.participantId}
            type="button"
            className={`timeline-marker ${s.participantId.startsWith('party') ? 'party-marker' : 'enemy-marker'}`}
            style={{
              left: `${(1 - Math.min(300, Math.max(0, s.remaining)) / 300) * 100}%`,
              top: `${i * 58}px`,
            }}
            onClick={() => setSelected(s.participantId)}
            aria-label={`${titleFor(release, s.participantId)} ${scheduleText[s.kind]} ${s.remaining} TU`}
          >
            <span className="timeline-name">
              {s.participantId.startsWith('party')
                ? `● ${s.participantId.slice(-1)}`
                : `◆ ${titleFor(release, s.participantId)}`}
              {s.kind === 'casting'
                ? ' ✦'
                : s.kind === 'stopped'
                  ? ' ⏸'
                  : s.kind === 'broken'
                    ? ' ◇'
                    : ''}
            </span>
            <span>{s.remaining} TU</span>
          </button>
        ))}
      </div>
      {selected && (
        <p role="status">
          {schedules
            .filter((s) => s.participantId === selected)
            .map(
              (s) =>
                `${titleFor(release, s.participantId)}：${scheduleText[s.kind]} ${s.remaining} TU${s.skillId ? ` · ${titleFor(release, s.skillId)}` : ''}${s.frozenRemaining !== null ? ` ／ 凍結残り ${s.frozenRemaining} TU` : ''}`,
            )
            .join('')}
        </p>
      )}
      <details>
        <summary>行動順・予定の詳細</summary>
        <ol>
          {[...schedules]
            .sort(
              (a, b) =>
                a.at - b.at ||
                { stopped: 0, broken: 2, casting: 4, ready: 5, waiting: 5 }[
                  a.kind
                ] -
                  { stopped: 0, broken: 2, casting: 4, ready: 5, waiting: 5 }[
                    b.kind
                  ] ||
                session.state.participants.findIndex(
                  (p) => p.id === a.participantId,
                ) -
                  session.state.participants.findIndex(
                    (p) => p.id === b.participantId,
                  ),
            )
            .map((s) => (
              <li key={s.participantId}>
                {titleFor(release, s.participantId)}：{scheduleText[s.kind]}{' '}
                {s.remaining} TU
                {s.skillId && ` · ${titleFor(release, s.skillId)}`}
                {s.frozenRemaining !== null &&
                  ` ／ 凍結した予定の残り ${s.frozenRemaining} TU`}
                {s.recoveryWaitReference !== null &&
                  ` ／ 復帰後の待機参考値 ${s.recoveryWaitReference} TU（SPDで変化）`}
              </li>
            ))}
        </ol>
        <p>同着の処理順は予定種別・参加者順で決まります。</p>
      </details>
    </div>
  );
}
