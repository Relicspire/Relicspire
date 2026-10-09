import type { GameContent } from '../data/model';
import type {
  FormationContext,
  FormationResult,
  PartyFormation,
  PresetIdMigration,
  PresetRepair,
  RepairChange,
} from './types';
import { getInventory, getJobNodes, validateFormation } from './validation';
/** 対応表自身に明示されたIDだけを変換する。継承プロパティは移行として扱わない。
 * @param table 明示対応表。省略時は変換なし。
 * @param id 旧IDまたは現在ID。
 */
function mappedId<T extends string>(
  table: Record<string, T> | undefined,
  id: T,
): T {
  return table && Object.hasOwn(table, id) ? table[id]! : id;
}
/** 旧IDの明示対応だけを適用する。削除・費用超過の修復はここではしない。
 * @param input 元編成。
 * @param migration 明示された旧ID→新ID対応表。
 */
export function migrateParty(
  input: PartyFormation,
  migration: PresetIdMigration,
): PartyFormation {
  const party = structuredClone(input);
  for (const b of party) {
    b.jobId = mappedId(migration.jobs, b.jobId);
    b.learnedSkills = b.learnedSkills.map((id) =>
      mappedId(migration.skills, id),
    );
    b.equipment = b.equipment.map((id) =>
      id === null ? null : mappedId(migration.equipment, id),
    ) as typeof b.equipment;
  }
  return party;
}
/** 装備空欄化・未知スキルと依存子孫除去をプレビューする。予算超過・未知職は残存問題として返す。
 * @param content 現在カタログ。
 * @param input 元の編成。未知JSONを構造検証してから扱う。
 * @param context 現在の進行。
 * @param migration 明示対応表。省略時はID変換なし。
 */
export function previewPartyRepair(
  content: GameContent,
  input: unknown,
  context: FormationContext,
  migration: PresetIdMigration = {},
): FormationResult<PresetRepair> {
  // 枠数や人物順の破損は自動で解釈しない。参照・前提・所持制約だけを修復する。
  const structural = validateFormation(
    content,
    input as PartyFormation,
    context,
  ).filter((i) =>
    ['party-size', 'shape', 'character', 'slots'].includes(i.code),
  );
  if (structural.length) return { ok: false, issues: structural };
  const originalParty = input as PartyFormation;
  const party = migrateParty(originalParty, migration);
  const inventory = getInventory(content, context);
  const used = new Map<string, number>();
  for (let i = 0; i < party.length; i++) {
    const b = party[i]!;
    const nodes = getJobNodes(content, b.jobId);
    if (content.jobs.some((j) => j.id === b.jobId)) {
      let kept = b.learnedSkills.filter((id) => nodes.some((n) => n.id === id));
      let changed = true;
      while (changed) {
        const valid = kept.filter((id) =>
          nodes
            .find((n) => n.id === id)!
            .prerequisites.every((p) => kept.includes(p)),
        );
        changed = valid.length !== kept.length;
        kept = valid;
      }
      b.learnedSkills = kept;
    }
    for (let slot = 0; slot < 6; slot++) {
      const id = b.equipment[slot];
      if (id === null) continue;
      const item = content.equipment.find((e) => e.id === id);
      const count = used.get(id!) ?? 0;
      const allowed = item
        ? Math.min(
            inventory.get(item.id) ?? 0,
            item.kind === 'relic' ? 1 : item.maxOwned,
          )
        : 0;
      if (count >= allowed) b.equipment[slot] = null;
      else used.set(id!, count + 1);
    }
  }

  return {
    ok: true,
    value: {
      party,
      changes: getRepairChanges(originalParty, party, migration),
      issues: validateFormation(content, party, context),
    },
  };
}

/** 編成候補の人物・ノード・枠ごとの差分を生成する。
 * @param originalParty 構造検証済みの元編成。
 * @param party 修復後の候補。
 * @param migration 使用した明示ID対応表。
 */
export function getRepairChanges(
  originalParty: PartyFormation,
  party: PartyFormation,
  migration: PresetIdMigration = {},
): RepairChange[] {
  const changes: RepairChange[] = [];
  for (let i = 0; i < party.length; i++) {
    const b = party[i]!;
    const original = originalParty[i]!;
    if (original.jobId !== b.jobId)
      changes.push({
        path: `party[${i}].jobId`,
        before: original.jobId,
        after: b.jobId,
        reason: '明示されたジョブID移行',
      });
    original.learnedSkills.forEach((id) => {
      const mapped = mappedId(migration.skills, id);
      if (!b.learnedSkills.includes(mapped) || mapped !== id)
        changes.push({
          path: `party[${i}].learnedSkills`,
          before: id,
          after: b.learnedSkills.includes(mapped) ? mapped : null,
          reason: 'ID移行または未知ノード・前提欠落の除去',
        });
    });
    original.equipment.forEach((id, slot) => {
      if (id !== b.equipment[slot])
        changes.push({
          path: `party[${i}].equipment[${slot}]`,
          before: id ?? '',
          after: b.equipment[slot] ?? null,
          reason: 'ID移行または未取得・削除・所持数超過の空欄化',
        });
    });

    for (const id of b.learnedSkills)
      if (
        !originalParty[i]!.learnedSkills.includes(id) &&
        !originalParty[i]!.learnedSkills.some(
          (old) => mappedId(migration.skills, old) === id,
        )
      )
        changes.push({
          path: `party[${i}].learnedSkills`,
          before: '',
          after: id,
          reason: '初期習得ノードへの復帰',
        });
  }
  return changes;
}
