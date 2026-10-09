import type { GameContent } from '../data/model';
import type {
  FormationContext,
  FormationIssue,
  FormationResult,
  PartyFormation,
  PresetIdMigration,
  PresetRepair,
  BuildPreset,
} from './types';
import {
  getSkillPointLimit,
  getSpentSkillPoints,
  validateFormation,
  MAX_PRESETS,
} from './validation';
import { validatePresetMetadata } from './presets';
import { migrateParty, previewPartyRepair, getRepairChanges } from './repair';
/** 現在編成の復旧候補。未知職は3人の初期編成へ戻す候補を明示する。 */
export interface CurrentPartyRecovery extends PresetRepair {
  kind: 'repair' | 'initial-party';
}
/** プリセット1件の診断。原本を独立コピーで保持し、無効な内容も削除しない。 */
export interface PresetInspection {
  index: number;
  original: unknown;
  metadataIssues: FormationIssue[];
  partyIssues: FormationIssue[];
  callable: boolean;
}
/** 集合・管理情報の致命的問題と、各編成の無効判定を分離する。 */
export interface PresetCollectionInspection {
  /** 件数・一意ID・管理情報の問題。保存層で復旧方針を決める。 */
  issues: FormationIssue[];
  entries: PresetInspection[];
  /** 無効な旧編成だけならtrue。現在進行のロードを一律に止めない。 */
  metadataValid: boolean;
}
/** 初期編成を現在の所持数で再配置する候補。品物や進行は追加配布しない。
 * @param content 検証済み初期定義を含むカタログ。
 * @param context 現在の検証済み進行。
 * @param migration 初期IDにも必要なら適用する明示対応表。
 */
function initialParty(
  content: GameContent,
  context: FormationContext,
  migration: PresetIdMigration,
): FormationResult<PresetRepair> {
  const party = ['party-1', 'party-2', 'party-3'].map((id) => {
    const c = content.characters.find((c) => c.id === id);
    return c
      ? {
          id: c.id,
          jobId: c.initialJob,
          learnedSkills: [...c.initialSkills],
          equipment: structuredClone(c.initialEquipment),
        }
      : null;
  });
  return previewPartyRepair(content, party, context, migration);
}
/** 初期編成への復帰を明示した候補を生成する。
 * @param content 検証済みカタログ。
 * @param input 保存された現在編成。原本を変更しない。
 * @param context 現在の検証済み進行。
 * @param migration 保存層で選択した明示ID対応表。
 */
export function previewInitialPartyRecovery(
  content: GameContent,
  input: unknown,
  context: FormationContext,
  migration: PresetIdMigration = {},
): FormationResult<CurrentPartyRecovery> {
  const check = previewPartyRepair(content, input, context, migration);
  if (!check.ok) return check;
  const initial = initialParty(content, context, migration);
  if (!initial.ok) return initial;
  return {
    ok: true,
    value: {
      kind: 'initial-party',
      party: initial.value.party,
      changes: getRepairChanges(
        input as PartyFormation,
        initial.value.party,
        migration,
      ).map((change) => ({ ...change, reason: '初期編成への復帰候補' })),
      issues: validateFormation(content, initial.value.party, context),
    },
  };
}
/** 現在編成の修復候補を生成する。予算超過は本人の習得を全解除し、未知職は初期復帰候補を返す。
 * @param content 検証済みの現在カタログ。
 * @param input 未知JSONの現在編成。枠数・人物順の破損は解釈しない。
 * @param context 現在の検証済み進行。生成だけでは保存・適用しない。
 * @param migration 保存層が選択した明示ID対応表。
 */
export function previewCurrentPartyRecovery(
  content: GameContent,
  input: unknown,
  context: FormationContext,
  migration: PresetIdMigration = {},
): FormationResult<CurrentPartyRecovery> {
  const common = previewPartyRepair(content, input, context, migration);
  if (!common.ok) return common;
  const migrated = migrateParty(input as PartyFormation, migration);
  if (migrated.some((b) => !content.jobs.some((j) => j.id === b.jobId)))
    return previewInitialPartyRecovery(content, input, context, migration);
  const party = common.value.party;
  const overBudget = new Set<number>();
  migrated.forEach((build, i) => {
    if (getSpentSkillPoints(content, build) > getSkillPointLimit(context)) {
      party[i]!.learnedSkills = [];
      overBudget.add(i);
    }
  });
  const changes = getRepairChanges(
    input as PartyFormation,
    party,
    migration,
  ).map((change) => ({
    ...change,
    reason:
      overBudget.has(Number(change.path.match(/^party\[(\d+)\]/)?.[1])) &&
      change.path.endsWith('.learnedSkills')
        ? '個人予算超過のため習得を全解除'
        : change.reason,
  }));
  return {
    ok: true,
    value: {
      kind: 'repair',
      party,
      changes,
      issues: validateFormation(content, party, context),
    },
  };
}
/** 保存されたプリセット集合を読み込み診断する。移行後候補の検証も原本と分離する。
 * @param content 現在の検証済みカタログ。
 * @param input 未知JSONのプリセット一覧。
 * @param context 現在の検証済み進行。
 * @param migration 保存層が選択した明示ID対応表。ここでは修復・保存しない。
 */
export function inspectPresetCollection(
  content: GameContent,
  input: unknown,
  context: FormationContext,
  migration: PresetIdMigration = {},
): PresetCollectionInspection {
  if (!Array.isArray(input))
    return {
      issues: [
        { path: 'presets', code: 'shape', message: 'プリセット一覧は配列です' },
      ],
      entries: [],
      metadataValid: false,
    };
  const issues: FormationIssue[] = [];
  const ids = new Set<string>();
  if (input.length > MAX_PRESETS)
    issues.push({
      path: 'presets',
      code: 'preset-limit',
      message: 'プリセットは最大20件です',
    });
  const entries = input.map((raw: unknown, index) => {
    const metadataIssues = validatePresetMetadata(raw).map((i) => ({
      ...i,
      path: `presets[${index}].${i.path}`,
    }));
    issues.push(...metadataIssues);
    if (
      raw &&
      typeof raw === 'object' &&
      'id' in raw &&
      typeof raw.id === 'string'
    ) {
      if (ids.has(raw.id))
        issues.push({
          path: `presets[${index}].id`,
          code: 'duplicate-preset-id',
          message: 'プリセットIDが重複しています',
        });
      ids.add(raw.id);
    }
    let partyIssues: FormationIssue[] = [];
    if (!metadataIssues.length) {
      const preset = raw as BuildPreset;
      const structural = validateFormation(
        content,
        preset.party,
        context,
      ).filter((i) =>
        ['party-size', 'shape', 'character', 'slots'].includes(i.code),
      );
      partyIssues = structural.length
        ? structural
        : validateFormation(
            content,
            migrateParty(preset.party, migration),
            context,
          );
    }
    return {
      index,
      original: structuredClone(raw),
      metadataIssues,
      partyIssues,
      callable: !metadataIssues.length && !partyIssues.length,
    };
  });
  // 重複IDはfindによる呼出を曖昧にするため該当する全件を呼出不可にする。
  for (const entry of entries) {
    const raw = entry.original as BuildPreset | null;
    if (
      raw &&
      typeof raw.id === 'string' &&
      input.filter((p) => p && typeof p === 'object' && p.id === raw.id)
        .length > 1
    )
      entry.callable = false;
  }
  return { issues, entries, metadataValid: !issues.length };
}
