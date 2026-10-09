import { describe, expect, it } from 'vitest';
import { releaseFixture } from '../data/release.fixtures.test-support';
import {
  createInitialFormation,
  createPreset,
  previewCurrentPartyRecovery,
  previewInitialPartyRecovery,
  inspectPresetCollection,
  previewPresetRepair,
  recallPreset,
  getInventory,
  type FormationResult,
} from './index';
import type {
  JobId as ModelJobId,
  SkillNodeId,
  EquipmentId,
} from '../data/model';
/** 成功候補を取得し、不正ならテストを失敗させる。
 * @param result テスト対象の結果。
 */
function value<T>(result: FormationResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}
/** 初期状態と保存済みプリセットを用意する。 */
function source() {
  const content = releaseFixture().content;
  const context = { defeatedEnemyIds: [], inBattle: false };
  const initial = value(createInitialFormation(content, context));
  const state = value(
    createPreset(
      content,
      initial,
      { id: 'preset-one', name: '初期', now: 1, contentVersion: 1 },
      context,
    ),
  );
  return { content, context, state };
}

describe('現在編成の復旧候補と旧プリセット修復の区別', () => {
  it('予算超過は本人の全習得を解除し、他人・進行・プリセットを変更しない', () => {
    const { content, context, state } = source();
    const party = structuredClone(state.party);
    party[0].learnedSkills.push('knight-a3');
    const original = structuredClone({ party, context, state });
    const result = value(previewCurrentPartyRecovery(content, party, context));
    expect(result.kind).toBe('repair');
    expect(result.party[0].learnedSkills).toEqual([]);
    expect(result.party.slice(1)).toEqual(party.slice(1));
    expect(result.issues).toEqual([]);
    expect(result.changes.some((c) => c.reason.includes('全解除'))).toBe(true);
    expect({ party, context, state }).toEqual(original);
    const preset = { ...state.presets[0]!, party };
    expect(
      value(previewPresetRepair(content, preset, context)).issues.some(
        (i) => i.code === 'budget',
      ),
    ).toBe(true);
    expect(
      recallPreset(
        content,
        { ...state, presets: [preset] },
        preset.id,
        context,
        { repair: true },
      ).ok,
    ).toBe(false);
  });
  it('未知ジョブは3人の初期編成への候補を提示し、旧プリセットには残存問題を返す', () => {
    const { content, context, state } = source();
    const party = structuredClone(state.party);
    party[0].jobId = 'removed-job' as ModelJobId;
    party[1].jobId = 'knight';
    party[1].learnedSkills = [];
    const result = value(previewCurrentPartyRecovery(content, party, context));
    expect(result.kind).toBe('initial-party');
    expect(result.party).toEqual(state.party);
    expect(result.issues).toEqual([]);
    expect(result.changes.some((c) => c.path === 'party[0].jobId')).toBe(true);
    expect(result.changes.some((c) => c.after === 'wizard-a1')).toBe(true);
    expect(
      value(
        previewPresetRepair(content, { ...state.presets[0]!, party }, context),
      ).issues.some((i) => i.code === 'job'),
    ).toBe(true);
    expect(party[0].jobId).toBe('removed-job');
  });
  it('未知・他職のスキルと前提を失う依存子孫を除去し、予算超過は選別しない', () => {
    const { content, context, state } = source();
    const party = structuredClone(state.party);
    party[0].learnedSkills = [
      'removed-skill' as SkillNodeId,
      'wizard-a1',
      'knight-a2',
      'knight-a3',
    ];
    const result = value(previewCurrentPartyRecovery(content, party, context));
    expect(result.party[0].learnedSkills).toEqual([]);
    expect(result.issues).toEqual([]);
    const missing = structuredClone(state.party);
    missing[0].learnedSkills = ['knight-a2'];
    expect(
      value(previewCurrentPartyRecovery(content, missing, context)).party[0]
        .learnedSkills,
    ).toEqual([]);
  });
  it('装備超過は人物・枠順に空欄化し、未所持・削除品も外す', () => {
    const { content, context, state } = source();
    const party = structuredClone(state.party);
    party[0].equipment = [
      'starter-armor',
      'starter-armor',
      'starter-armor',
      'relic-01-01',
      'removed-item' as EquipmentId,
      null,
    ];
    const current = value(previewCurrentPartyRecovery(content, party, context));
    const preset = value(
      previewPresetRepair(content, { ...state.presets[0]!, party }, context),
    );
    expect(current.party).toEqual(preset.party);
    expect(current.party[0].equipment).toEqual([
      'starter-armor',
      'starter-armor',
      'starter-armor',
      null,
      null,
      null,
    ]);
    expect(current.party[1].equipment[2]).toBeNull();
    expect(current.party[2].equipment[2]).toBeNull();
    expect(current.issues).toEqual([]);
  });
  it('明示ID移行を修復前に適用し、初期化を不要にする', () => {
    const { content, context, state } = source();
    const party = structuredClone(state.party);
    party[0].jobId = 'old-knight' as ModelJobId;
    party[0].learnedSkills = ['old-a1' as SkillNodeId, 'old-a2' as SkillNodeId];
    party[0].equipment[0] = 'old-sword' as EquipmentId;
    const migration = {
      jobs: { 'old-knight': 'knight' as const },
      skills: {
        'old-a1': 'knight-a1' as const,
        'old-a2': 'knight-a2' as const,
      },
      equipment: { 'old-sword': 'starter-sword' as const },
    };
    const result = value(
      previewCurrentPartyRecovery(content, party, context, migration),
    );
    expect(result.kind).toBe('repair');
    expect(result.party).toEqual(state.party);
    expect(result.changes).toHaveLength(4);
    expect(
      value(
        previewPresetRepair(
          content,
          { ...state.presets[0]!, party },
          context,
          migration,
        ),
      ).party,
    ).toEqual(result.party);
  });
  it('対応表から継承したIDは明示移行として扱わない', () => {
    const { content, context, state } = source();
    const party = structuredClone(state.party);
    party[0].jobId = 'old-knight' as ModelJobId;
    const migration = {
      jobs: Object.create({ 'old-knight': 'knight' }) as Record<
        string,
        ModelJobId
      >,
    };
    expect(
      value(
        previewPresetRepair(
          content,
          { ...state.presets[0]!, party },
          context,
          migration,
        ),
      ).issues.some((i) => i.code === 'job'),
    ).toBe(true);
  });
  it('初期編成への戻しは所持数を変えず、現在の予算の余りを保持する', () => {
    const { content, state } = source();
    const context = {
      defeatedEnemyIds: ['boss-01' as const, 'guardian-01-01' as const],
      inBattle: false,
    };
    const inventory = getInventory(content, context);
    const party = structuredClone(state.party);
    party[0].learnedSkills = [];
    party[0].equipment[0] = 'relic-01-01';
    const result = value(previewInitialPartyRecovery(content, party, context));
    expect(result.party).toEqual(state.party);
    expect(getInventory(content, context)).toEqual(inventory);
    expect(context.defeatedEnemyIds).toHaveLength(2);
    expect(result.issues).toEqual([]);
  });
  it.each([null, [], [null, null, null], [{ id: 'party-1' }]])(
    '枠数・人物構造の破損は解釈せず拒否する',
    (raw) => {
      const { content, context } = source();
      expect(previewCurrentPartyRecovery(content, raw, context).ok).toBe(false);
      expect(previewInitialPartyRecovery(content, raw, context).ok).toBe(false);
    },
  );
  it('未定義の重複習得は残存問題とし、候補の成功を適用可能と混同しない', () => {
    const { content, context, state } = source();
    const party = structuredClone(state.party);
    party[0].learnedSkills.push('knight-a1');
    const result = value(previewCurrentPartyRecovery(content, party, context));
    expect(result.issues.some((i) => i.code === 'duplicate-skill')).toBe(true);
  });
});

describe('プリセット集合の読み込み診断', () => {
  it('無効な旧編成だけなら管理情報は有効とし、原本を保持して個別に呼出不可にする', () => {
    const { content, context, state } = source();
    const invalid = structuredClone(state.presets[0]!);
    invalid.id = 'preset-old';
    invalid.party[0].equipment[0] = 'removed-item' as EquipmentId;
    const input = [state.presets[0]!, invalid];
    const before = structuredClone(input);
    const result = inspectPresetCollection(content, input, context);
    expect(result.metadataValid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.entries.map((e) => e.callable)).toEqual([true, false]);
    expect(result.entries[1]!.partyIssues[0]!.code).toBe('equipment');
    expect(result.entries[1]!.original).toEqual(invalid);
    (result.entries[1]!.original as typeof invalid).name = '変更';
    expect(input).toEqual(before);
  });
  it('重複IDと21件目を集合の問題とし、黙って削除しない', () => {
    const { content, context, state } = source();
    const list = Array.from({ length: 21 }, (_, i) => ({
      ...structuredClone(state.presets[0]!),
      id: `preset-${i}`,
    }));
    list[1]!.id = list[0]!.id;
    const result = inspectPresetCollection(content, list, context);
    expect(result.metadataValid).toBe(false);
    expect(result.issues.map((i) => i.code)).toEqual([
      'preset-limit',
      'duplicate-preset-id',
    ]);
    expect(result.entries).toHaveLength(21);
    expect(result.entries[0]!.callable).toBe(false);
    expect(result.entries[1]!.callable).toBe(false);
  });
  it('不正な管理情報と編成構造を別々に診断する', () => {
    const { content, context, state } = source();
    const malformed = { ...state.presets[0]!, party: [null, null, null] };
    const result = inspectPresetCollection(
      content,
      [null, { ...state.presets[0]!, name: '' }, malformed],
      context,
    );
    expect(result.metadataValid).toBe(false);
    expect(result.entries[2]!.metadataIssues).toEqual([]);
    expect(result.entries[2]!.partyIssues).toHaveLength(3);
    expect(result.entries.every((e) => !e.callable)).toBe(true);
    expect(inspectPresetCollection(content, {}, context).metadataValid).toBe(
      false,
    );
  });
  it('明示移行で呼出可否を再判定しても保存済み原本を変えない', () => {
    const { content, context, state } = source();
    const old = structuredClone(state.presets[0]!);
    old.party[0].equipment[0] = 'old-sword' as EquipmentId;
    const result = inspectPresetCollection(content, [old], context, {
      equipment: { 'old-sword': 'starter-sword' },
    });
    expect(result.entries[0]!.callable).toBe(true);
    expect(
      (result.entries[0]!.original as typeof old).party[0].equipment[0],
    ).toBe('old-sword');
  });
});
