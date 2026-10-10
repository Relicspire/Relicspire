import type { GameRelease } from '../../game/data/release';
import type { GuildSkillDetails } from '../../game/party';
import { effectText } from '../battle/effect-text';

export function SkillDetails({
  detail,
  release,
}: {
  detail: GuildSkillDetails;
  release: GameRelease;
}) {
  const { skill } = detail;
  return (
    <details>
      <summary>性能・効果を見る</summary>
      <p>
        対象：{release.presentation.targets[skill.target]} ／ 詠唱{' '}
        {skill.castTime} TU ／ 基礎D {skill.delay} TU ／ 現装備のD{' '}
        {detail.delayReference} TU ／ CD {skill.cooldown} TU
      </p>
      <p>
        CD共有：
        {release.presentation.entries[skill.cooldownId]?.name ??
          `${skill.cooldownId.endsWith('-a') ? 'A' : 'B'}系統（上位版と共有）`}{' '}
        ／ 選択属性：
        {skill.elementChoices
          .map((element) => release.presentation.elements[element])
          .join('・') || 'なし'}
      </p>
      <ol>
        {skill.effects.map((effect, i) => (
          <li key={i}>
            {effectText(effect, release)}
            {'attached' in effect && effect.attached.length > 0 && (
              <ul>
                {effect.attached.map((attached, j) => (
                  <li key={j}>付随効果：{effectText(attached, release)}</li>
                ))}
              </ul>
            )}
            {detail.effects[i]?.hpAmount !== null && (
              <p>HP量の参考値：{detail.effects[i]?.hpAmount}</p>
            )}
            {!!detail.effects[i]?.missing.length && (
              <p>
                参考値には
                {detail.effects[i]?.missing
                  .map(
                    (condition) =>
                      ({
                        target: '対象',
                        element: '属性',
                        'actor-hp': '行動者HP',
                      })[condition],
                  )
                  .join('・')}
                の指定が必要です。
              </p>
            )}
          </li>
        ))}
      </ol>
      <p>
        状態補正なしの独立した効果の参考値です。反応・対象の適格性や将来の状態変化は含みません。
      </p>
    </details>
  );
}
