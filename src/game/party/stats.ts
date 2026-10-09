import type { GameContent, Stats } from '../data/model';
import { clampStats, initialWaitTU } from '../battle/calculations';
import type { PartyBuild } from './types';

/** 状態補正のない拠点能力値。装備加算値と上下限適用後を分けて表示する。 */
export interface BuildStats {
  baseStats: Stats;
  equipmentStats: Stats;
  effectiveStats: Stats;
  initialWait: number;
}

/** 装備変更候補も照会できる共通集計。所持数・予算はvalidateFormationで別途検証する。
 * @param content 検証済みの人物・装備カタログ。
 * @param build 照会する人物の6枠編成。入力を変更しない。
 */
export function getBuildStats(
  content: GameContent,
  build: PartyBuild,
): BuildStats {
  const character = content.characters.find((c) => c.id === build.id);
  if (!character) throw new Error(`Unknown character: ${build.id}`);
  if (build.equipment.length !== 6)
    throw new Error('Exactly six equipment slots are required');
  const equipmentStats = { ...character.baseStats };
  for (const id of build.equipment) {
    if (id === null) continue;
    const item = content.equipment.find((e) => e.id === id);
    if (!item) throw new Error(`Unknown equipment: ${id}`);
    for (const key of Object.keys(equipmentStats) as (keyof Stats)[])
      equipmentStats[key] += item.stats[key] ?? 0;
  }
  const effectiveStats = clampStats(equipmentStats);
  return {
    baseStats: { ...character.baseStats },
    equipmentStats,
    effectiveStats,
    initialWait: initialWaitTU(effectiveStats.spd),
  };
}
