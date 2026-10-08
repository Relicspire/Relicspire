import type { ActorSnapshot, BattleParticipant } from '../data/battle';
import type {
  AttackPayload,
  Element,
  EnemyDefinition,
  Stats,
} from '../data/model';
export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));
const limits: Record<keyof Stats, [number, number]> = {
  maxHp: [1, 99999],
  atk: [1, 9999],
  mag: [1, 9999],
  def: [0, 9999],
  mdef: [0, 9999],
  spd: [25, 400],
};
export function clampStats(stats: Stats): Stats {
  return Object.fromEntries(
    Object.entries(stats).map(([key, value]) => [
      key,
      clamp(value, ...limits[key as keyof Stats]),
    ]),
  ) as unknown as Stats;
}
export function effectiveStats(participant: BattleParticipant): Stats {
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
export const delayTU = (base: number, spd: number) =>
  Math.max(1, Math.ceil((base * 100) / spd));
export const initialWaitTU = (spd: number) => Math.ceil(10000 / spd);
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
export function damageAmount(
  attack: AttackPayload,
  actor: ActorSnapshot,
  target: BattleParticipant,
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
