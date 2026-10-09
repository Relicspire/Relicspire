import type { ActorSnapshot, BattleParticipant } from '../data/battle';
import type {
  AttackPayload,
  Element,
  EnemyDefinition,
  Stats,
} from '../data/model';
/**
 * 値を指定した下限・上限の範囲に収める。
 *
 * @param value 検証または制限する値。
 * @param min 許可する下限（含む）。
 * @param max 許可する上限（含む）。
 */
export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));
/** 最終能力値の下限・上限。能力補正を適用した後で制限する。 */
const limits: Record<keyof Stats, [number, number]> = {
  maxHp: [1, 99999],
  atk: [1, 9999],
  mag: [1, 9999],
  def: [0, 9999],
  mdef: [0, 9999],
  spd: [25, 400],
};
/**
 * 各能力に定められた最終値の上下限を適用し、新しい能力値を返す。
 *
 * @param stats 制限を適用する能力値。
 */
export function clampStats(stats: Stats): Stats {
  return Object.fromEntries(
    Object.entries(stats).map(([key, value]) => [
      key,
      clamp(value, ...limits[key as keyof Stats]),
    ]),
  ) as unknown as Stats;
}
/**
 * 装備加算後の基礎値に強化・弱体を加算し、丸めと上下限を適用する。
 *
 * @param participant 能力を参照する戦闘参加者。
 */
export function effectiveStats(
  participant: Pick<BattleParticipant, 'stats' | 'statuses'>,
): Stats {
  const result = { ...participant.stats };
  for (const stat of ['atk', 'mag', 'spd'] as const) {
    let modifier = 0;
    for (const effect of participant.statuses) {
      const spec = effect.spec;
      if ('magnitude' in spec) {
        if (spec.familyId === `${stat}-up`) modifier += spec.magnitude;
        if (spec.familyId === `${stat}-down`) modifier -= spec.magnitude;
      }
    }
    result[stat] = Math.floor(
      (result[stat] * (10000 + clamp(modifier, -7500, 30000))) / 10000,
    );
  }
  return clampStats(result);
}
/**
 * 発動直前の能力・HP条件を固定する。同一行動の途中で自身が変化しても保存値は変えない。
 *
 * @param participant 能力を参照する戦闘参加者。
 */
export function actorSnapshot(participant: BattleParticipant): ActorSnapshot {
  const stats = effectiveStats(participant);
  return {
    reference: 'before-activation',
    actorId: participant.id,
    atk: stats.atk,
    mag: stats.mag,
    spd: stats.spd,
    hp: participant.hp,
    maxHp: stats.maxHp,
    damageModifier: 10000,
    healingModifier: 10000,
  };
}
/**
 * 基礎ディレイを保存済みSPDで補正し、切り上げて最低1 TUにする。
 *
 * @param base スキルの基礎ディレイTU。
 * @param spd 補正と範囲制限を適用済みの速度。
 */
export const delayTU = (base: number, spd: number) =>
  Math.max(1, Math.ceil((base * 100) / spd));
/**
 * 開始時またはブレイク復帰時の速度から開始待機TUを切り上げ計算する。
 *
 * @param spd 補正と範囲制限を適用済みの速度。
 */
export const initialWaitTU = (spd: number) => Math.ceil(10000 / spd);
/**
 * 属性の通常・弱点・耐性・無効倍率を10000基準で返す。無属性は常に通常。
 *
 * @param element 確定した攻撃属性。
 * @param enemy 対象が敵ならその属性・耐性定義、味方ならnull。
 */
export function elementMultiplier(
  element: Element,
  enemy: EnemyDefinition | null,
): number {
  if (element === 'none' || !enemy) return 10000;
  if (enemy.immuneElements?.includes(element)) return 0;
  if (enemy.weakness === element) return 15000;
  if (enemy.resistance === element) return 5000;
  return 10000;
}
/**
 * 防御・属性・与被ダメージ補正を整数の分数で計算し、最後に一度だけ切り捨てる。
 *
 * @param attack 攻撃の威力・種別・属性・削り性能。
 * @param actor 発動直前に固定した攻撃者の能力とHP。
 * @param target 効果の対象。
 * @param element 確定した攻撃属性。
 * @param enemy 対象が敵ならその属性・耐性定義、味方ならnull。
 * @returns HP上限への制限前のダメージ。属性無効なら0。
 */
export function damageAmount(
  attack: AttackPayload,
  actor: ActorSnapshot,
  target: Pick<BattleParticipant, 'stats' | 'statuses' | 'action'>,
  element: Element,
  enemy: EnemyDefinition | null,
): number {
  if (elementMultiplier(element, enemy) === 0) return 0;
  const power =
    typeof attack.power === 'number'
      ? attack.power
      : actor.hp * 2 <= actor.maxHp
        ? attack.power.lowHp
        : attack.power.normal;
  const stats = effectiveStats(target);
  const offense = BigInt(
    attack.damageType === 'physical' ? actor.atk : actor.mag,
  );
  const defense = BigInt(
    attack.damageType === 'physical' ? stats.def : stats.mdef,
  );
  const rawBase = offense * BigInt(power) - defense * 100n;
  const baseNumerator = rawBase < 100n ? 100n : rawBase;
  let received = target.action.kind === 'broken' ? 15000 : 10000;
  for (const status of target.statuses) {
    if (
      (attack.damageType === 'physical' &&
        status.spec.familyId === 'physical-guard') ||
      (attack.damageType === 'magic' && status.spec.familyId === 'magic-guard')
    )
      received -= status.spec.magnitude;
  }
  const numerator =
    baseNumerator *
    BigInt(elementMultiplier(element, enemy)) *
    BigInt(clamp(actor.damageModifier, 2500, 40000)) *
    BigInt(clamp(received, 1000, 30000));
  return Math.max(1, Number(numerator / (100n * 10000n ** 3n)));
}
/**
 * 弱点による2倍補正とブレイク耐性からゲージ削り量を一度だけ切り捨て計算する。
 *
 * @param base 攻撃の基礎ゲージ削り量。
 * @param element 確定した攻撃属性。
 * @param enemy 対象敵の弱点とブレイク耐性。
 */
export function breakAmount(
  base: number,
  element: Element,
  enemy: EnemyDefinition,
): number {
  return Number(
    (BigInt(base) *
      BigInt(element !== 'none' && element === enemy.weakness ? 2 : 1) *
      BigInt(10000 - enemy.breakResistance)) /
      10000n,
  );
}
/**
 * 行動者の保存済みMAGと回復補正から回復量を一度だけ切り捨て計算する。
 *
 * @param power 回復威力（100を基準とする）。
 * @param actor 発動直前に固定した回復者の能力。
 * @returns 対象の不足HPへの制限前の回復量。
 */
export const healAmount = (power: number, actor: ActorSnapshot) =>
  Math.max(
    1,
    Number(
      (BigInt(actor.mag) *
        BigInt(power) *
        BigInt(clamp(actor.healingModifier, 2500, 40000))) /
        (100n * 10000n),
    ),
  );

/** 最大HPと10000基準の蘇生割合から復帰HPを導出する。
 * @param maxHp 対象の確定最大HP。
 * @param ratio 蘇生時のHP割合。
 */
export const reviveHp = (maxHp: number, ratio: number) =>
  Math.max(1, Math.floor((maxHp * ratio) / 10000));
