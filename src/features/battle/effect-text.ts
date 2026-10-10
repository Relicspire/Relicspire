import type {
  AttackPayload,
  Effect,
  HitEffect,
  StatusSpec,
  UtilityPayload,
} from '../../game/data/model';
import type { GameRelease } from '../../game/data/release';

const bindings = {
  selected: '選択対象',
  'all-allies': '味方全体',
  'all-enemies': '敵全体',
  self: '自身',
  'hit-recipient': '実際の被弾者',
};
function attackText(attack: AttackPayload, release: GameRelease) {
  const power =
    typeof attack.power === 'number'
      ? String(attack.power)
      : `通常${attack.power.normal}／HP50%以下${attack.power.lowHp}`;
  return `${attack.damageType === 'physical' ? '物理' : '魔法'}・${attack.element === 'chosen' ? '選択属性' : release.presentation.elements[attack.element]}、威力${power}、削り${attack.breakDamage}、${attack.hits}ヒット（${attack.damageType === 'physical' ? 'ATKと対象DEF' : 'MAGと対象MDEF'}で計算）`;
}
export function statusText(status: StatusSpec, release: GameRelease): string {
  const name = release.presentation.statuses[status.familyId];
  if ('magnitude' in status) return `${name} ${status.magnitude / 100}%`;
  if ('ratio' in status)
    return `${name} ${status.ratio / 100}%・${status.charges}回`;
  if ('attack' in status)
    return `${name}：${attackText(status.attack, release)}`;
  if ('damage' in status)
    return `${name}：${status.interval} TUごとに${status.damage} HP`;
  if ('hpRatio' in status)
    return `${name}：最大HPの${status.hpRatio / 100}%・${status.charges}回`;
  return name;
}
function utilityText(effect: UtilityPayload, release: GameRelease) {
  switch (effect.kind) {
    case 'shift':
      return `${effect.direction === 'advance' ? '前進' : '後退'} ${effect.amount} TU`;
    case 'cancel-cast':
      return '詠唱を中断';
    case 'dispel':
      return `${effect.polarity === 'buff' ? '強化' : '弱体'}を${effect.count}件解除`;
    case 'apply-status':
      return `${statusText(effect.status, release)}、${effect.duration} TU、${effect.dispellable ? '解除可能' : '解除不可'}`;
  }
}
export function effectText(
  effect: Effect | HitEffect,
  release: GameRelease,
): string {
  const target = bindings[effect.target];
  switch (effect.kind) {
    case 'attack':
      return `${target}：${attackText(effect, release)}`;
    case 'trap':
      return `${target}：罠 ${effect.duration} TU、発動時に${attackText(effect.attack, release)}`;
    case 'heal':
      return `${target}：回復威力${effect.power}（MAGで計算）`;
    case 'revive':
      return `${target}：最大HPの${effect.hpRatio / 100}%で蘇生`;
    default:
      return `${target}：${utilityText(effect, release)}`;
  }
}
