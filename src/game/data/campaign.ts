import type { BattleReward, FloorId, EnemyId, RelicId } from './model';
import type {
  CampaignMetadata,
  ContentAvailability,
  ReleaseScope,
} from './release-model';
import type { DataIssue } from './validation';
import { array, choice, fail, id, integer, object, union } from './schema';
/** 全編の固定階層ID。 */
export const FLOOR_IDS: readonly FloorId[] = Array.from(
  { length: 10 },
  (_, i) => `floor-${String(i + 1).padStart(2, '0')}` as FloorId,
);
/** 固定の守護者番号。 */
const GUARDIANS = ['01', '02', '03', '04', '05'] as const;
/** 固定報酬を持つ全編メタデータを生成する。能力値・表示文言は仮置きしない。 */
export function createCampaignMetadata(): CampaignMetadata {
  return {
    floors: FLOOR_IDS.map((id) => ({ id })),
    enemies: FLOOR_IDS.flatMap((floorId, index) => {
      const number = floorId.slice(-2);
      const reward: BattleReward = {
        skillPointsPerCharacter: index === 9 ? 0 : 1,
        equipment: [],
        unlockFloorId: FLOOR_IDS[index + 1] ?? null,
        finalClear: index === 9,
      };
      return [
        { id: `boss-${number}` as EnemyId, floorId, reward },
        ...GUARDIANS.map((g) => ({
          id: `guardian-${number}-${g}` as EnemyId,
          floorId,
          reward: {
            skillPointsPerCharacter: 0,
            equipment: [{ id: `relic-${number}-${g}` as RelicId, quantity: 1 }],
            unlockFloorId: null,
            finalClear: false,
          },
        })),
      ];
    }),
    relics: FLOOR_IDS.flatMap((floorId) =>
      GUARDIANS.map((g) => ({
        id: `relic-${floorId.slice(-2)}-${g}` as RelicId,
        floorId,
        sourceEnemyId: `guardian-${floorId.slice(-2)}-${g}` as EnemyId,
        maxOwned: 1 as const,
      })),
    ),
  };
}
/** 型未確認のメタデータの構造。余分な能力値や表示情報は拒否する。 */
const schema = object({
  floors: array(object({ id: id(/^floor-(?:0[1-9]|10)$/) })),
  enemies: array(
    object({
      id: id(/^(?:boss-(?:0[1-9]|10)|guardian-(?:0[1-9]|10)-0[1-5])$/),
      floorId: id(/^floor-(?:0[1-9]|10)$/),
      reward: object({
        skillPointsPerCharacter: integer(),
        equipment: array(
          object({
            id: id(/^relic-(?:0[1-9]|10)-0[1-5]$/),
            quantity: integer(1),
          }),
        ),
        unlockFloorId: union([id(/^floor-(?:0[1-9]|10)$/), choice(null)]),
        finalClear: choice(true, false),
      }),
    }),
  ),
  relics: array(
    object({
      id: id(/^relic-(?:0[1-9]|10)-0[1-5]$/),
      floorId: id(/^floor-(?:0[1-9]|10)$/),
      sourceEnemyId: id(/^guardian-(?:0[1-9]|10)-0[1-5]$/),
      maxOwned: choice(1),
    }),
  ),
});
/** 固定報酬の意味を比較する。項目順や配列の並び順には依存しない。
 * @param actual 検証する報酬。
 * @param expected 正規IDから決まる報酬。
 */
export function sameReward(
  actual: BattleReward,
  expected: BattleReward,
): boolean {
  return (
    actual.skillPointsPerCharacter === expected.skillPointsPerCharacter &&
    actual.unlockFloorId === expected.unlockFloorId &&
    actual.finalClear === expected.finalClear &&
    actual.equipment.length === expected.equipment.length &&
    actual.equipment.every(
      (e, i) =>
        e.id === expected.equipment[i]!.id &&
        e.quantity === expected.equipment[i]!.quantity,
    )
  );
}
/** 全10階層・60敵・50遺物の網羅性・重複・所属・固定報酬を検証する。
 * @param input 未知JSONまたは読み込み候補。部分メタデータは許可しない。
 */
export function validateCampaignMetadata(input: unknown): DataIssue[] {
  const issues: DataIssue[] = [];
  schema(input, 'campaign', issues);
  if (issues.length) return issues;
  const actual = input as CampaignMetadata;
  const expected = createCampaignMetadata();
  for (const key of ['floors', 'enemies', 'relics'] as const) {
    const items = actual[key];
    const ids = new Set<string>();
    for (const item of items) {
      if (ids.has(item.id))
        fail(issues, `campaign.${key}.${item.id}`, 'IDが重複しています');
      ids.add(item.id);
    }
    for (const item of expected[key])
      if (!ids.has(item.id))
        fail(issues, `campaign.${key}`, `必須IDが欠落しています: ${item.id}`);
  }
  for (const item of actual.enemies) {
    const spec = expected.enemies.find((e) => e.id === item.id)!;
    if (item.floorId !== spec.floorId || !sameReward(item.reward, spec.reward))
      fail(
        issues,
        `campaign.enemies.${item.id}`,
        '所属階層または固定報酬が不正です',
      );
  }
  for (const item of actual.relics) {
    const spec = expected.relics.find((e) => e.id === item.id)!;
    if (
      item.floorId !== spec.floorId ||
      item.sourceEnemyId !== spec.sourceEnemyId
    )
      fail(
        issues,
        `campaign.relics.${item.id}`,
        '所属階層または入手元が不正です',
      );
  }
  return issues;
}
/** 全編メタデータを検証して独立コピーを返す。
 * @param input 未知の読み込み候補。不正ならパス付き例外を投げる。
 */
export function parseCampaignMetadata(input: unknown): CampaignMetadata {
  const issues = validateCampaignMetadata(input);
  if (issues.length)
    throw new Error(issues.map((i) => `${i.path}: ${i.message}`).join('\n'));
  return structuredClone(input) as CampaignMetadata;
}
/** 階層または敵の収録状態を照会する。実際の移動には3.6の解放・隣接判定も必要。
 * @param campaign 検証済み全編メタデータ。
 * @param scope 検証済み収録範囲。
 * @param contentId 照会するID。未知文字列も許可する。
 */
export function getContentAvailability(
  campaign: CampaignMetadata,
  scope: ReleaseScope,
  contentId: string,
): ContentAvailability {
  const floor =
    campaign.floors.find((f) => f.id === contentId)?.id ??
    campaign.enemies.find((e) => e.id === contentId)?.floorId;
  return !floor
    ? 'unknown'
    : scope.playableFloorIds.includes(floor)
      ? 'playable'
      : 'unavailable';
}
