import type { CampaignMetadata } from '../data/release-model';
import {
  getCampaignSkillPointLimit,
  getCampaignInventory,
} from '../data/campaign';
import {
  JOB_IDS,
  type EquipmentId,
  type GameContent,
  type SkillId,
  type SkillNode,
} from '../data/model';
import type { FormationContext, FormationIssue, PartyBuild } from './types';
/** 新規開始時の1人分予算。ポイントは人物間で共有しない。 */
export const INITIAL_SKILL_POINTS = 3;
/** 保存できるプリセットの上限。 */
export const MAX_PRESETS = 20;
/** NFC正規化後の名称に許可するUnicodeコードポイント数。 */
export const MAX_PRESET_NAME_LENGTH = 24;
/** 取得済みボス集合から各人のポイント上限を導出する。重複と最終ボスは加算しない。
 * @param context 討伐済みIDを保持する進行コンテキスト。
 * @param campaign 全編メタデータ。指定時は進行APIと同じ報酬から予算を導出する。
 */
export function getSkillPointLimit(
  context: FormationContext,
  campaign?: CampaignMetadata,
): number {
  if (campaign)
    return getCampaignSkillPointLimit(campaign, context.defeatedEnemyIds);
  return (
    INITIAL_SKILL_POINTS +
    new Set(context.defeatedEnemyIds.filter((id) => /^boss-0[1-9]$/.test(id)))
      .size
  );
}
/** 初期品と討伐済み守護者から所持数を導出する。保存された所持数は信用しない。
 * @param content 検証済みの装備カタログ。
 * @param context 討伐済みIDの集合。
 * @param campaign 全編メタデータ。指定時は未収録品も含む全編所持数を返す。
 */
export function getInventory(
  content: GameContent,
  context: FormationContext,
  campaign?: CampaignMetadata,
): Map<EquipmentId, number> {
  if (campaign) return getCampaignInventory(campaign, context.defeatedEnemyIds);
  const defeated = new Set(context.defeatedEnemyIds);
  return new Map(
    content.equipment.map((item) => [
      item.id,
      item.kind === 'starter'
        ? item.maxOwned
        : defeated.has(item.sourceEnemyId)
          ? 1
          : 0,
    ]),
  );
}
/** 指定ジョブのノードをA→Bの順に取得する。
 * @param content 検証済みのジョブカタログ。
 * @param jobId 参照するジョブID。不明なら空配列。
 */
export function getJobNodes(content: GameContent, jobId: string): SkillNode[] {
  const job = content.jobs.find((j) => j.id === jobId);
  return job ? [...job.routes.a, ...job.routes.b] : [];
}
/** 習得費用を重複加算せず集計する。未知ノードはvalidateFormationで別途拒否する。
 * @param content ジョブカタログ。
 * @param build 費用を計算する1人の編成。
 */
export function getSpentSkillPoints(
  content: GameContent,
  build: PartyBuild,
): number {
  const learned = new Set(build.learnedSkills);
  return getJobNodes(content, build.jobId)
    .filter((n) => learned.has(n.id))
    .reduce((sum, n) => sum + n.cost, 0);
}
/** 残り予算を現在の討伐情報から計算する。入力編成は事前に検証する。
 * @param content ジョブカタログ。
 * @param build 対象の編成。
 * @param context 現在の進行。
 */
export function getRemainingSkillPoints(
  content: GameContent,
  build: PartyBuild,
  context: FormationContext,
): number {
  return getSkillPointLimit(context) - getSpentSkillPoints(content, build);
}
/** 習得記録を残したまま、同系統の最上位だけを使用コマンドにする。
 * @param content 置換グループとランクを持つカタログ。
 * @param build 現在の習得済み編成。
 */
export function getActiveSkillIds(
  content: GameContent,
  build: PartyBuild,
): SkillId[] {
  const learned = getJobNodes(content, build.jobId).filter((n) =>
    build.learnedSkills.includes(n.id),
  );
  return [
    'basic-attack',
    'wait',
    ...learned
      .filter(
        (n) =>
          !learned.some(
            (other) =>
              other.replacementGroup === n.replacementGroup &&
              other.rank > n.rank,
          ),
      )
      .map((n) => n.skillId),
  ];
}
/** 未知データの3人・職・習得・予算・6枠・所持数・遺物重複を一括検証する。
 * @param content 検証済みのコンテンツ。
 * @param input 読み込みまたは編集候補の編成。
 * @param context 討伐情報と現在の戦闘状態。照会検証は戦闘中も可能。
 * @returns 問題の一覧。空配列なら有効。
 */
export function validateFormation(
  content: GameContent,
  input: unknown,
  context: FormationContext,
): FormationIssue[] {
  const issues: FormationIssue[] = [];
  const fail = (path: string, code: string, message: string) =>
    issues.push({ path, code, message });
  if (!Array.isArray(input) || input.length !== 3) {
    fail('party', 'party-size', '編成は固定順の3人である必要があります');
    return issues;
  }
  const used = new Map<string, number>();
  const inventory = getInventory(content, context);
  input.forEach((raw: unknown, i) => {
    const path = `party[${i}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      fail(path, 'shape', '人物の編成が不正です');
      return;
    }
    const b = raw as Record<string, unknown>;
    if (
      Object.keys(b).some(
        (k) => !['id', 'jobId', 'learnedSkills', 'equipment'].includes(k),
      )
    )
      fail(path, 'shape', '編成以外の項目は保存できません');
    if (
      b.id !== `party-${i + 1}` ||
      !content.characters.some((c) => c.id === b.id)
    )
      fail(`${path}.id`, 'character', '人物IDまたはスロット順が不正です');
    if (typeof b.jobId !== 'string')
      fail(`${path}.jobId`, 'shape', 'ジョブIDは文字列です');
    const validJob =
      JOB_IDS.some((j) => j === b.jobId) &&
      content.jobs.some((j) => j.id === b.jobId);
    if (!validJob) fail(`${path}.jobId`, 'job', 'ジョブが存在しません');
    const nodes = getJobNodes(
      content,
      typeof b.jobId === 'string' ? b.jobId : '',
    );
    if (
      !Array.isArray(b.learnedSkills) ||
      b.learnedSkills.some((id) => typeof id !== 'string')
    )
      fail(`${path}.learnedSkills`, 'shape', '習得ノード一覧が不正です');
    else {
      const learned = new Set(b.learnedSkills);
      if (learned.size !== b.learnedSkills.length)
        fail(
          `${path}.learnedSkills`,
          'duplicate-skill',
          '同じノードは一度だけ習得できます',
        );
      let cost = 0;
      for (const id of learned) {
        const node = nodes.find((n) => n.id === id);
        if (!node)
          fail(
            `${path}.learnedSkills`,
            'skill',
            `現在のジョブに存在しないノードです: ${String(id)}`,
          );
        else {
          cost += node.cost;
          for (const pre of node.prerequisites)
            if (!learned.has(pre))
              fail(
                `${path}.learnedSkills`,
                'prerequisite',
                `必要な前提が未習得です: ${pre}`,
              );
        }
      }
      if (cost > getSkillPointLimit(context))
        fail(
          `${path}.learnedSkills`,
          'budget',
          `必要ポイント${cost}が上限${getSkillPointLimit(context)}を超えています`,
        );
    }
    if (!Array.isArray(b.equipment) || b.equipment.length !== 6) {
      fail(`${path}.equipment`, 'slots', '装備は空欄を含めて6枠必要です');
      return;
    }
    b.equipment.forEach((id: unknown, slot: number) => {
      if (id === null) return;
      if (typeof id !== 'string') {
        fail(
          `${path}.equipment[${slot}]`,
          'shape',
          '装備IDは文字列または空欄です',
        );
        return;
      }
      const p = `${path}.equipment[${slot}]`;
      const item = content.equipment.find((e) => e.id === id);
      if (!item) {
        fail(p, 'equipment', `存在しない装備です: ${String(id)}`);
        return;
      }
      const count = (used.get(item.id) ?? 0) + 1;
      used.set(item.id, count);
      if (item.kind === 'relic' && count > 1)
        fail(p, 'unique', '同じユニーク遺物は全パーティで1枠までです');
      if (count > (inventory.get(item.id) ?? 0))
        fail(p, 'inventory', `所持数を超えた装備です: ${item.id}`);
    });
  });
  return issues;
}
