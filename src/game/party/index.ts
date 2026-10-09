import type {
  CharacterId,
  EquipmentId,
  GameContent,
  JobId,
  SkillNodeId,
} from '../data/model';
import type {
  EquipmentLocation,
  FormationContext,
  FormationResult,
  FormationState,
  PartyFormation,
  SkillRefund,
} from './types';
import { getJobNodes, validateFormation } from './validation';
export * from './presets';
export type * from './types';
export {
  getActiveSkillIds,
  getInventory,
  getRemainingSkillPoints,
  getSkillPointLimit,
  getSpentSkillPoints,
  MAX_PRESET_NAME_LENGTH,
  MAX_PRESETS,
  validateFormation,
} from './validation';
/** 入力候補を全体検証し、成功時だけ独立コピーを返す。
 * @param content 検証済みカタログ。
 * @param state 元の編成・プリセット。変更しない。
 * @param party 確定候補。受け渡しなど複数枠の編集をまとめて渡す。
 * @param context 現在の討伐情報と戦闘状態。
 */
export function replaceParty(
  content: GameContent,
  state: FormationState,
  party: unknown,
  context: FormationContext,
): FormationResult<FormationState> {
  if (context.inBattle)
    return {
      ok: false,
      issues: [
        {
          path: 'party',
          code: 'in-battle',
          message: '戦闘中は編成を変更できません',
        },
      ],
    };
  const issues = validateFormation(content, party, context);
  return issues.length
    ? { ok: false, issues }
    : {
        ok: true,
        value: {
          party: structuredClone(party) as PartyFormation,
          presets: structuredClone(state.presets),
        },
      };
}
/** キャラクター編集の共通処理。更新元を検証してから候補だけを操作する。
 * @param content 検証済みカタログ。
 * @param state 元の状態。
 * @param id 編集する人物ID。
 * @param context 進行・戦闘状態。
 * @param edit コピーした1人の編成へ適用する操作。
 */
function editCharacter(
  content: GameContent,
  state: FormationState,
  id: CharacterId,
  context: FormationContext,
  edit: (build: PartyFormation[number]) => void,
): FormationResult<FormationState> {
  const issues = validateFormation(content, state.party, context);
  if (issues.length) return { ok: false, issues };
  const party = structuredClone(state.party);
  const build = party.find((p) => p.id === id);
  if (!build)
    return {
      ok: false,
      issues: [
        { path: 'party', code: 'character', message: '人物が存在しません' },
      ],
    };
  edit(build);
  return replaceParty(content, state, party, context);
}
/** ジョブ変更時に習得を全解除する。同職を再選択した場合は習得を維持する。
 * @param content ジョブカタログ。
 * @param state 元の状態。
 * @param id 対象人物。
 * @param jobId 新しいジョブ。同職3人も許可する。
 * @param context 現在の進行と戦闘状態。
 */
export function changeJob(
  content: GameContent,
  state: FormationState,
  id: CharacterId,
  jobId: JobId,
  context: FormationContext,
) {
  return editCharacter(content, state, id, context, (build) => {
    if (build.jobId !== jobId) {
      build.jobId = jobId;
      build.learnedSkills = [];
    }
  });
}
/** 前提・独立予算を満たす場合だけノードを追加する。重複購入は拒否する。
 * @param content スキルツリー。
 * @param state 元の状態。
 * @param id 対象人物。
 * @param skillId 購入するノードID。
 * @param context 現在の進行と戦闘状態。
 */
export function learnSkill(
  content: GameContent,
  state: FormationState,
  id: CharacterId,
  skillId: SkillNodeId,
  context: FormationContext,
) {
  return editCharacter(content, state, id, context, (build) => {
    build.learnedSkills.push(skillId);
  });
}
/** 指定ノードと前提を失う子孫を求め、返却費用を計算する。
 * @param content スキルツリー。
 * @param build 対象の確定編成。
 * @param skillId 解除する習得済みノード。
 */
export function getSkillRefund(
  content: GameContent,
  build: PartyFormation[number],
  skillId: SkillNodeId,
): SkillRefund {
  const nodes = getJobNodes(content, build.jobId);
  const removed = new Set<SkillNodeId>();
  if (build.learnedSkills.includes(skillId)) removed.add(skillId);
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of nodes)
      if (
        build.learnedSkills.includes(n.id) &&
        !removed.has(n.id) &&
        n.prerequisites.some((p) => removed.has(p))
      ) {
        removed.add(n.id);
        changed = true;
      }
  }
  const affected = nodes.filter((n) => removed.has(n.id));
  return {
    removedSkillIds: affected.map((n) => n.id),
    refundedPoints: affected.reduce((sum, n) => sum + n.cost, 0),
  };
}
/** 依存子孫も含めて一括解除する。返却ポイントは残り予算として再導出する。
 * @param content スキルツリー。
 * @param state 元の状態。
 * @param id 対象人物。
 * @param skillId 解除するノード。
 * @param context 現在の進行と戦闘状態。
 */
export function removeSkill(
  content: GameContent,
  state: FormationState,
  id: CharacterId,
  skillId: SkillNodeId,
  context: FormationContext,
) {
  return editCharacter(content, state, id, context, (build) => {
    const refund = getSkillRefund(content, build, skillId);
    build.learnedSkills = build.learnedSkills.filter(
      (s) => !refund.removedSkillIds.includes(s),
    );
  });
}
/** 対象人物のスキルを全解除する。ジョブ・装備・進行は維持する。
 * @param content カタログ。
 * @param state 元の状態。
 * @param id 対象人物。
 * @param context 現在の進行と戦闘状態。
 */
export function resetSkills(
  content: GameContent,
  state: FormationState,
  id: CharacterId,
  context: FormationContext,
) {
  return editCharacter(content, state, id, context, (build) => {
    build.learnedSkills = [];
  });
}
/** 1枠を変更し、全18枠の所持数・ユニーク制限を確認する。
 * @param content 装備カタログ。
 * @param state 元の状態。
 * @param location 対象人物と0〜5の枠。
 * @param equipmentId 装備ID。空欄にする場合はnull。
 * @param context 現在の進行と戦闘状態。
 */
export function setEquipment(
  content: GameContent,
  state: FormationState,
  location: EquipmentLocation,
  equipmentId: EquipmentId | null,
  context: FormationContext,
): FormationResult<FormationState> {
  if (
    !Number.isInteger(location.slot) ||
    location.slot < 0 ||
    location.slot > 5
  )
    return {
      ok: false,
      issues: [
        { path: 'slot', code: 'slots', message: '枠番号は0〜5の整数です' },
      ],
    };
  return editCharacter(
    content,
    state,
    location.characterId,
    context,
    (build) => {
      build.equipment[location.slot] = equipmentId;
    },
  );
}
/** 移動元・先を1候補で更新する。moveは旧枠を空にし、swapは相互交換する。
 * @param content 装備カタログ。
 * @param state 元の状態。
 * @param from 移動元枠。
 * @param to 移動先枠。
 * @param context 現在の進行と戦闘状態。
 * @param mode 移動または相互交換。置換された品は所持品へ戻り、破棄しない。
 */
export function transferEquipment(
  content: GameContent,
  state: FormationState,
  from: EquipmentLocation,
  to: EquipmentLocation,
  context: FormationContext,
  mode: 'move' | 'swap' = 'move',
): FormationResult<FormationState> {
  const issues = validateFormation(content, state.party, context);
  if (issues.length) return { ok: false, issues };
  const party = structuredClone(state.party);
  const a = party.find((p) => p.id === from.characterId);
  const b = party.find((p) => p.id === to.characterId);
  if (
    !a ||
    !b ||
    ![from.slot, to.slot].every((s) => Number.isInteger(s) && s >= 0 && s <= 5)
  )
    return {
      ok: false,
      issues: [
        {
          path: 'equipment',
          code: 'slots',
          message: '受け渡し元または先が不正です',
        },
      ],
    };
  if (from.characterId !== to.characterId || from.slot !== to.slot) {
    const old = a.equipment[from.slot]!;
    a.equipment[from.slot] = mode === 'swap' ? b.equipment[to.slot]! : null;
    b.equipment[to.slot] = old;
  }
  return replaceParty(content, state, party, context);
}

/** カタログの初期ジョブ・A1/A2・装備から新規編成候補を作る。所持品を追加配布しない。
 * @param content 新規開始用の検証済みカタログ。
 * @param context 初期進行または再初期化時の進行。
 */
export function createInitialFormation(
  content: GameContent,
  context: FormationContext,
): FormationResult<FormationState> {
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
  return replaceParty(
    content,
    { party: [] as unknown as PartyFormation, presets: [] },
    party,
    context,
  );
}

export * from './recovery';
