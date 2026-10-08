import type { GameContent } from '../data/model';
import type {
  BuildPreset,
  FormationContext,
  FormationIssue,
  FormationResult,
  FormationState,
  PartyFormation,
  PresetId,
  PresetIdMigration,
  PresetMetadata,
  PresetRepair,
  RepairChange,
} from './types';
import {
  getInventory,
  getJobNodes,
  MAX_PRESET_NAME_LENGTH,
  MAX_PRESETS,
  validateFormation,
} from './validation';
/** 名称の空白除去・NFC正規化と制御文字・コードポイント数の検証。
 * @param input 入力されたプリセット名称。
 */
export function normalizePresetName(input: string): FormationResult<string> {
  if (typeof input !== 'string' || /\p{Cc}/u.test(input))
    return {
      ok: false,
      issues: [
        {
          path: 'name',
          code: 'name',
          message: '名称には制御文字を含められません',
        },
      ],
    };
  const name = input.trim().normalize('NFC');
  return [...name].length >= 1 && [...name].length <= MAX_PRESET_NAME_LENGTH
    ? { ok: true, value: name }
    : {
        ok: false,
        issues: [
          {
            path: 'name',
            code: 'name',
            message: '名称は正規化後1〜24文字です',
          },
        ],
      };
}
/** プリセットの管理項目だけを検証する。編成が旧版でも勝手に削除しない。
 * @param input 読み込みまたは操作対象のプリセット。
 */
function metadataIssues(input: unknown): FormationIssue[] {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return [
      { path: 'preset', code: 'shape', message: 'プリセットの構造が不正です' },
    ];
  const p = input as Record<string, unknown>;
  const issues: FormationIssue[] = [];
  if (
    Object.keys(p).some(
      (k) =>
        ![
          'id',
          'name',
          'createdAt',
          'updatedAt',
          'contentVersion',
          'party',
        ].includes(k),
    )
  )
    issues.push({
      path: 'preset',
      code: 'shape',
      message: 'プリセット以外の項目は保存できません',
    });
  if (typeof p.id !== 'string' || !/^preset-[A-Za-z0-9_-]{1,64}$/.test(p.id))
    issues.push({
      path: 'id',
      code: 'preset-id',
      message: 'プリセットIDが不正です',
    });
  const name = normalizePresetName(p.name as string);
  if (!name.ok) issues.push(...name.issues);
  else if (name.value !== p.name)
    issues.push({
      path: 'name',
      code: 'name',
      message: '保存名称は空白除去・NFC正規化済みである必要があります',
    });
  for (const field of ['createdAt', 'updatedAt', 'contentVersion'])
    if (
      typeof p[field] !== 'number' ||
      !Number.isSafeInteger(p[field]) ||
      (p[field] as number) < 0
    )
      issues.push({
        path: field,
        code: 'metadata',
        message: `${field}は非負の安全な整数です`,
      });
  if (
    typeof p.createdAt === 'number' &&
    typeof p.updatedAt === 'number' &&
    p.updatedAt < p.createdAt
  )
    issues.push({
      path: 'updatedAt',
      code: 'metadata',
      message: '更新日時は作成日時以降である必要があります',
    });
  return issues;
}
/** 保存済みプリセットを現在予算・所持数で再検証する。
 * @param content 現在のカタログ。
 * @param input 保存済みプリセット。未知JSONも受け入れる。
 * @param context 現在の進行。
 */
export function validatePreset(
  content: GameContent,
  input: unknown,
  context: FormationContext,
): FormationIssue[] {
  const issues = metadataIssues(input);
  if (issues.length) return issues;
  return validateFormation(content, (input as BuildPreset).party, context);
}
/** 更新日時降順、同時刻ならASCII管理IDの辞書順に独立コピーを並べる。
 * @param presets 保存済みプリセット一覧。
 */
export function sortPresets(presets: BuildPreset[]): BuildPreset[] {
  return structuredClone(presets).sort(
    (a, b) =>
      b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}
/** 更新日時を検証する。過去の更新へ巻き戻さない。
 * @param now 呼び出し元が取得したUnixミリ秒。
 * @param preset 対象の保存済みプリセット。
 */
function timeIssues(now: number, preset: BuildPreset): FormationIssue[] {
  return !Number.isSafeInteger(now) || now < preset.updatedAt
    ? [
        {
          path: 'now',
          code: 'metadata',
          message: '更新日時は直前の更新以降の整数です',
        },
      ]
    : [];
}
/** 有効な現在編成を新規保存する。ID・日時は呼び出し元が渡す。
 * @param content 現在カタログ。
 * @param state 元の編成・一覧。
 * @param metadata 名称・新ID・現在日時・コンテンツ版。
 * @param context 現在の進行。
 */
export function createPreset(
  content: GameContent,
  state: FormationState,
  metadata: PresetMetadata,
  context: FormationContext,
): FormationResult<FormationState> {
  if (
    state.presets.length >= MAX_PRESETS ||
    state.presets.some((p) => p.id === metadata.id)
  )
    return {
      ok: false,
      issues: [
        {
          path: 'presets',
          code: 'preset-limit',
          message: '最大20件、IDは一意である必要があります',
        },
      ],
    };
  const name = normalizePresetName(metadata.name);
  if (!name.ok) return name;
  const preset: BuildPreset = {
    id: metadata.id,
    name: name.value,
    createdAt: metadata.now,
    updatedAt: metadata.now,
    contentVersion: metadata.contentVersion,
    party: structuredClone(state.party),
  };
  const issues = validatePreset(content, preset, context);
  if (issues.length) return { ok: false, issues };
  return {
    ok: true,
    value: {
      party: structuredClone(state.party),
      presets: sortPresets([...state.presets, preset]),
    },
  };
}
/** 改名だけを行う。旧編成が無効でも内容や版を変更しない。
 * @param state 元の編成・一覧。
 * @param id 改名対象の管理ID。
 * @param name 新名称。
 * @param now 更新日時。
 */
export function renamePreset(
  state: FormationState,
  id: PresetId,
  name: string,
  now: number,
): FormationResult<FormationState> {
  const preset = state.presets.find((p) => p.id === id);
  if (!preset) return missingPreset();
  const normalized = normalizePresetName(name);
  if (!normalized.ok) return normalized;
  const issues = timeIssues(now, preset);
  if (issues.length) return { ok: false, issues };
  const next = structuredClone(state);
  const target = next.presets.find((p) => p.id === id)!;
  target.name = normalized.value;
  target.updatedAt = now;
  next.presets = sortPresets(next.presets);
  return { ok: true, value: next };
}
/** 現在の有効編成で上書きする。ID・作成日時は保持する。
 * @param content 現在カタログ。
 * @param state 元の状態。
 * @param metadata 対象ID、新名称、更新日時、新コンテンツ版。
 * @param context 現在の進行。
 */
export function overwritePreset(
  content: GameContent,
  state: FormationState,
  metadata: PresetMetadata,
  context: FormationContext,
): FormationResult<FormationState> {
  const old = state.presets.find((p) => p.id === metadata.id);
  if (!old) return missingPreset();
  const name = normalizePresetName(metadata.name);
  if (!name.ok) return name;
  const preset: BuildPreset = {
    ...structuredClone(old),
    name: name.value,
    updatedAt: metadata.now,
    contentVersion: metadata.contentVersion,
    party: structuredClone(state.party),
  };
  const issues = [
    ...timeIssues(metadata.now, old),
    ...validatePreset(content, preset, context),
  ];
  if (issues.length) return { ok: false, issues };
  return {
    ok: true,
    value: {
      party: structuredClone(state.party),
      presets: sortPresets(
        state.presets.map((p) => (p.id === old.id ? preset : p)),
      ),
    },
  };
}
/** 指定IDだけを削除する。現在編成へ影響させない。
 * @param state 元の状態。
 * @param id 削除するプリセットID。
 */
export function deletePreset(
  state: FormationState,
  id: PresetId,
): FormationResult<FormationState> {
  if (!state.presets.some((p) => p.id === id)) return missingPreset();
  const next = structuredClone(state);
  next.presets = next.presets.filter((p) => p.id !== id);
  return { ok: true, value: next };
}
/** 不明な管理IDの共通拒否結果を作る。 */
function missingPreset(): FormationResult<FormationState> {
  return {
    ok: false,
    issues: [
      {
        path: 'preset.id',
        code: 'preset-id',
        message: '指定プリセットが存在しません',
      },
    ],
  };
}
/** 旧IDの明示対応だけを適用する。削除・費用超過の修復はここではしない。
 * @param preset 元プリセット。
 * @param migration 明示された旧ID→新ID対応表。
 */
function migratedParty(
  preset: BuildPreset,
  migration: PresetIdMigration,
): PartyFormation {
  const party = structuredClone(preset.party);
  for (const b of party) {
    b.jobId = migration.jobs?.[b.jobId] ?? b.jobId;
    b.learnedSkills = b.learnedSkills.map((id) => migration.skills?.[id] ?? id);
    b.equipment = b.equipment.map((id) =>
      id === null ? null : (migration.equipment?.[id] ?? id),
    ) as typeof b.equipment;
  }
  return party;
}
/** 装備空欄化・未知スキルと依存子孫除去をプレビューする。予算超過・未知職は残存問題として返す。
 * @param content 現在カタログ。
 * @param preset 元の保存済みプリセット。変更しない。
 * @param context 現在の進行。
 * @param migration 明示対応表。省略時はID変換なし。
 */
export function previewPresetRepair(
  content: GameContent,
  preset: BuildPreset,
  context: FormationContext,
  migration: PresetIdMigration = {},
): FormationResult<PresetRepair> {
  const meta = metadataIssues(preset);
  if (meta.length) return { ok: false, issues: meta };
  // 枠数や人物順の破損は自動で解釈しない。参照・前提・所持制約だけを修復する。
  const structural = validateFormation(content, preset.party, context).filter(
    (i) => ['party-size', 'shape', 'character', 'slots'].includes(i.code),
  );
  if (structural.length) return { ok: false, issues: structural };
  const party = migratedParty(preset, migration);
  const changes: RepairChange[] = [];
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
    const original = preset.party[i]!;
    if (original.jobId !== b.jobId)
      changes.push({
        path: `party[${i}].jobId`,
        before: original.jobId,
        after: b.jobId,
        reason: '明示されたジョブID移行',
      });
    original.learnedSkills.forEach((id) => {
      const mapped = migration.skills?.[id] ?? id;
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
  }
  return {
    ok: true,
    value: {
      party,
      changes,
      issues: validateFormation(content, party, context),
    },
  };
}
/** 通常呼出は不整合を拒否する。repair指定はUIで差分確認・確定した場合だけ渡す。
 * @param content 現在カタログ。
 * @param state 元の状態。
 * @param id 呼び出す管理ID。
 * @param context 現在の進行と戦闘状態。
 * @param options 明示修復の適用有無と旧ID対応表。元プリセットは保持する。
 */
export function recallPreset(
  content: GameContent,
  state: FormationState,
  id: PresetId,
  context: FormationContext,
  options: { repair?: boolean; migration?: PresetIdMigration } = {},
): FormationResult<FormationState> {
  if (context.inBattle)
    return {
      ok: false,
      issues: [
        {
          path: 'party',
          code: 'in-battle',
          message: '戦闘中はプリセットを呼び出せません',
        },
      ],
    };
  const preset = state.presets.find((p) => p.id === id);
  if (!preset) return missingPreset();
  const meta = metadataIssues(preset);
  if (meta.length) return { ok: false, issues: meta };
  const structural = validateFormation(content, preset.party, context).filter(
    (i) => ['party-size', 'shape', 'character', 'slots'].includes(i.code),
  );
  if (structural.length) return { ok: false, issues: structural };
  let party: PartyFormation;
  if (options.repair) {
    const preview = previewPresetRepair(
      content,
      preset,
      context,
      options.migration,
    );
    if (!preview.ok) return preview;
    if (preview.value.issues.length)
      return { ok: false, issues: preview.value.issues };
    party = preview.value.party;
  } else {
    party = migratedParty(preset, options.migration ?? {});
    const issues = validateFormation(content, party, context);
    if (issues.length) return { ok: false, issues };
  }
  return {
    ok: true,
    value: { party, presets: structuredClone(state.presets) },
  };
}
