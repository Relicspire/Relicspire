import { describe, expect, it } from 'vitest';
import { createBattle } from '../battle';
import { fixture } from '../battle/fixtures.test-support';
import type { GameContent, SkillNodeId } from '../data/model';
import {
  changeJob,
  createInitialFormation,
  createPreset,
  deletePreset,
  getActiveSkillIds,
  getInventory,
  getRemainingSkillPoints,
  getSkillPointLimit,
  getSkillRefund,
  learnSkill,
  normalizePresetName,
  overwritePreset,
  previewPresetRepair,
  recallPreset,
  removeSkill,
  renamePreset,
  replaceParty,
  resetSkills,
  setEquipment,
  sortPresets,
  transferEquipment,
  validateFormation,
  validatePreset,
} from './index';
import type {
  BuildPreset,
  FormationContext,
  FormationResult,
  FormationState,
  PresetMetadata,
} from './types';
/** 原子的操作の成功値をテストへ取り出す。不正結果なら理由付きで失敗させる。
 * @param result 検証する純粋操作結果。
 */
function value<T>(result: FormationResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}
/** 全職と初期装備を持つ合成カタログを作る。正式コンテンツは後続タスクで用意する。 */
function data(): GameContent {
  const c = fixture().content;
  c.equipment = [
    { id: 'starter-sword', kind: 'starter', stats: { atk: 10 }, maxOwned: 3 },
    { id: 'starter-staff', kind: 'starter', stats: { mag: 10 }, maxOwned: 3 },
    { id: 'starter-armor', kind: 'starter', stats: { def: 5 }, maxOwned: 3 },
    { id: 'starter-charm', kind: 'starter', stats: { mdef: 5 }, maxOwned: 3 },
    { id: 'starter-boots', kind: 'starter', stats: { spd: 5 }, maxOwned: 3 },
    { id: 'starter-ring', kind: 'starter', stats: { maxHp: 50 }, maxOwned: 3 },
    {
      id: 'relic-01-01',
      kind: 'relic',
      stats: { atk: 12 },
      maxOwned: 1,
      sourceEnemyId: 'guardian-01-01',
    },
  ];
  const enemySkill = structuredClone(
    c.skills.find((s) => s.id === 'boss-01-s1')!,
  );
  enemySkill.id = 'guardian-01-01-s1';
  enemySkill.cooldownId = 'guardian-01-01-s1';
  c.skills.push(enemySkill);
  c.enemies.push({
    ...structuredClone(c.enemies[0]!),
    id: 'guardian-01-01',
    phases: [
      {
        id: 'phase-1',
        hpThreshold: 10000,
        actions: [{ skillId: 'guardian-01-01-s1', selection: 'lowest-hp' }],
      },
    ],
    reward: {
      skillPointsPerCharacter: 0,
      equipment: [{ id: 'relic-01-01', quantity: 1 }],
      unlockFloorId: null,
      finalClear: false,
    },
  });
  c.characters.forEach((ch) => {
    ch.initialSkills = [`${ch.initialJob}-a1`, `${ch.initialJob}-a2`];
    ch.initialEquipment = [
      'starter-sword',
      'starter-staff',
      'starter-armor',
      'starter-charm',
      'starter-boots',
      'starter-ring',
    ];
  });
  return c;
}
/** 新規開始時の正規進行。戦闘外なので編成を編集できる。 */
const context: FormationContext = { defeatedEnemyIds: [], inBattle: false };
/** 最終到達時の1人12ポイントの進行。重複報酬は加算しない。 */
const full: FormationContext = {
  defeatedEnemyIds: [
    'boss-01',
    'boss-02',
    'boss-03',
    'boss-04',
    'boss-05',
    'boss-06',
    'boss-07',
    'boss-08',
    'boss-09',
    'boss-10',
  ],
  inBattle: false,
};
/** プリセット保存の再現可能なメタデータ。時計・乱数はテスト外へ出さない。 */
const metadata: PresetMetadata = {
  id: 'preset-one',
  name: '編成',
  now: 1000,
  contentVersion: 1,
};
/** 初期編成を生成するテストヘルパー。
 * @param c 使用する合成カタログ。
 */
const initial = (c = data()) => value(createInitialFormation(c, context));
/** 無効な旧参照を検証するために保存済みプリセットをコピーする。
 * @param c 使用する合成カタログ。
 */
function saved(c = data()): FormationState {
  return value(createPreset(c, initial(c), metadata, context));
}

describe('編成と各人物の独立したスキル予算', () => {
  it('初期習得A1・A2の費用を3とし、習得を保持したままコマンドを上位置換する', () => {
    const c = data();
    const s = initial(c);
    expect(validateFormation(c, s.party, context)).toEqual([]);
    expect(getActiveSkillIds(c, s.party[0])).toEqual([
      'basic-attack',
      'wait',
      'knight-a2',
    ]);
    expect(s.party[0].learnedSkills).toEqual(['knight-a1', 'knight-a2']);
    expect(getRemainingSkillPoints(c, s.party[0], context)).toBe(0);
  });
  it('ボス01〜09の討伐から予算3〜12を、守護者の討伐から所持品を導出する', () => {
    const c = data();
    expect(getSkillPointLimit(context)).toBe(3);
    expect(getSkillPointLimit(full)).toBe(12);
    expect(
      getSkillPointLimit({
        ...context,
        defeatedEnemyIds: ['boss-01', 'boss-01', 'boss-10', 'guardian-01-01'],
      }),
    ).toBe(4);
    expect(getInventory(c, context).get('starter-armor')).toBe(3);
    expect(getInventory(c, context).get('relic-01-01')).toBe(0);
    expect(
      getInventory(c, { ...context, defeatedEnemyIds: ['guardian-01-01'] }).get(
        'relic-01-01',
      ),
    ).toBe(1);
  });
  it('同職3人を許可し、ジョブを変更した人物の習得だけを解除する', () => {
    const c = data();
    const s = initial(c);
    const one = value(changeJob(c, s, 'party-2', 'knight', context));
    const next = value(changeJob(c, one, 'party-3', 'knight', context));
    expect(next.party.map((p) => p.jobId)).toEqual([
      'knight',
      'knight',
      'knight',
    ]);
    expect(next.party[0].learnedSkills).toEqual(s.party[0].learnedSkills);
    expect(next.party[1].learnedSkills).toEqual([]);
    expect(next.party[1].equipment).toEqual(s.party[1].equipment);
    expect(s).toEqual(initial(c));
    expect(value(changeJob(c, s, 'party-1', 'knight', context))).toEqual(s);
  });
  it('前提不足・重複習得・他職スキル・他人の予算使用を拒否する', () => {
    const c = data();
    const s = value(resetSkills(c, initial(c), 'party-1', context));
    expect(learnSkill(c, s, 'party-1', 'knight-a3', context).ok).toBe(false);
    const next = value(learnSkill(c, s, 'party-1', 'knight-a1', context));
    expect(learnSkill(c, next, 'party-1', 'knight-a1', context).ok).toBe(false);
    expect(learnSkill(c, next, 'party-1', 'wizard-a1', context).ok).toBe(false);
    const noBudget = initial(c);
    noBudget.party[1].learnedSkills = [];
    noBudget.party[2].learnedSkills = [];
    expect(learnSkill(c, noBudget, 'party-1', 'knight-a3', context).ok).toBe(
      false,
    );
  });
  it('予算12で両ルートを習得し、ランク2・3を表示して依存ノードを一括返却する', () => {
    const c = data();
    let s = initial(c);
    for (const id of [
      'knight-a3',
      'knight-b1',
      'knight-b2',
      'knight-b3',
    ] as SkillNodeId[])
      s = value(learnSkill(c, s, 'party-1', id, full));
    expect(getRemainingSkillPoints(c, s.party[0], full)).toBe(0);
    expect(getActiveSkillIds(c, s.party[0])).toEqual([
      'basic-attack',
      'wait',
      'knight-a2',
      'knight-a3',
      'knight-b2',
      'knight-b3',
    ]);
    expect(getSkillRefund(c, s.party[0], 'knight-a1')).toEqual({
      removedSkillIds: ['knight-a1', 'knight-a2', 'knight-a3'],
      refundedPoints: 6,
    });
    const next = value(removeSkill(c, s, 'party-1', 'knight-a1', full));
    expect(next.party[0].learnedSkills).toEqual([
      'knight-b1',
      'knight-b2',
      'knight-b3',
    ]);
    expect(getRemainingSkillPoints(c, next.party[0], full)).toBe(6);
  });
  it('戦闘中のジョブ・スキル・装備変更・受け渡し・プリセット呼出を拒否する', () => {
    const c = data();
    const s = saved(c);
    const ctx = { ...context, inBattle: true };
    const before = structuredClone(s);
    expect(changeJob(c, s, 'party-1', 'wizard', ctx).ok).toBe(false);
    expect(resetSkills(c, s, 'party-1', ctx).ok).toBe(false);
    expect(
      setEquipment(c, s, { characterId: 'party-1', slot: 0 }, null, ctx).ok,
    ).toBe(false);
    expect(
      transferEquipment(
        c,
        s,
        { characterId: 'party-1', slot: 0 },
        { characterId: 'party-2', slot: 0 },
        ctx,
      ).ok,
    ).toBe(false);
    expect(recallPreset(c, s, 'preset-one', ctx).ok).toBe(false);
    expect(s).toEqual(before);
  });
  it.each([null, [], [{ id: 'party-1' }], [null, null, null]])(
    '不正なJSONを例外を投げずに検証エラーとして返す',
    (raw) => {
      expect(validateFormation(data(), raw, context).length).toBeGreaterThan(0);
    },
  );
});

describe('6枠の自由装備と一括で確定する受け渡し', () => {
  it('所持数を変えずに同じ防具3個を1人へ集中装備できる', () => {
    const c = data();
    const s = initial(c);
    const party = structuredClone(s.party);
    party.forEach((p) => {
      p.equipment = [null, null, null, null, null, null];
    });
    party[0].equipment = [
      'starter-armor',
      'starter-armor',
      'starter-armor',
      null,
      null,
      null,
    ];
    const next = value(replaceParty(c, s, party, context));
    expect(validateFormation(c, next.party, context)).toEqual([]);
    expect(getInventory(c, context).get('starter-armor')).toBe(3);
    expect(s.party[0].equipment[0]).toBe('starter-sword');
    party[1].equipment[0] = 'starter-armor';
    expect(replaceParty(c, s, party, context).ok).toBe(false);
  });
  it('装備中の遺物を一括で移動し、重複使用と未所持品を拒否する', () => {
    const c = data();
    const ctx = {
      ...context,
      defeatedEnemyIds: [
        'guardian-01-01',
      ] as FormationContext['defeatedEnemyIds'],
    };
    const s = value(
      setEquipment(
        c,
        initial(c),
        { characterId: 'party-1', slot: 0 },
        'relic-01-01',
        ctx,
      ),
    );
    expect(
      setEquipment(
        c,
        s,
        { characterId: 'party-2', slot: 0 },
        'relic-01-01',
        ctx,
      ).ok,
    ).toBe(false);
    const moved = value(
      transferEquipment(
        c,
        s,
        { characterId: 'party-1', slot: 0 },
        { characterId: 'party-2', slot: 0 },
        ctx,
      ),
    );
    expect(moved.party[0].equipment[0]).toBeNull();
    expect(moved.party[1].equipment[0]).toBe('relic-01-01');
    expect(s.party[0].equipment[0]).toBe('relic-01-01');
    expect(
      setEquipment(
        c,
        initial(c),
        { characterId: 'party-1', slot: 0 },
        'relic-01-01',
        context,
      ).ok,
    ).toBe(false);
  });
  it('装備済みの枠を交換し、小数と範囲外の枠番号を拒否する', () => {
    const c = data();
    const s = initial(c);
    const next = value(
      transferEquipment(
        c,
        s,
        { characterId: 'party-1', slot: 0 },
        { characterId: 'party-2', slot: 1 },
        context,
        'swap',
      ),
    );
    expect(next.party[0].equipment[0]).toBe('starter-staff');
    expect(next.party[1].equipment[1]).toBe('starter-sword');
    for (const slot of [-1, 6, 0.5, NaN])
      expect(
        setEquipment(c, s, { characterId: 'party-1', slot }, null, context).ok,
      ).toBe(false);
  });
});

describe('プリセット管理と明示的な修復', () => {
  it('Unicodeを正規化し、絵文字を1コードポイントとして数える', () => {
    expect(value(normalizePresetName('  e\u0301  '))).toBe('é');
    expect(normalizePresetName('😀'.repeat(24)).ok).toBe(true);
    expect(normalizePresetName('😀'.repeat(25)).ok).toBe(false);
    for (const n of ['', '  ', 'a\nb', '\ta', 'a\u0000'])
      expect(normalizePresetName(n).ok).toBe(false);
  });
  it('入力状態を変更せずにプリセットを作成・改名・上書き・呼出・削除する', () => {
    const c = data();
    const s = saved(c);
    const renamed = value(renamePreset(s, 'preset-one', ' 新名称 ', 2000));
    expect(renamed.presets[0]).toMatchObject({
      createdAt: 1000,
      updatedAt: 2000,
      name: '新名称',
      contentVersion: 1,
    });
    expect(renamed.presets[0]!.party).toEqual(s.party);
    const changed = value(changeJob(c, renamed, 'party-1', 'ranger', context));
    const overwritten = value(
      overwritePreset(
        c,
        changed,
        { ...metadata, name: '別構成', now: 3000, contentVersion: 2 },
        context,
      ),
    );
    expect(overwritten.presets[0]).toMatchObject({
      id: 'preset-one',
      createdAt: 1000,
      updatedAt: 3000,
      contentVersion: 2,
    });
    const recalled = value(recallPreset(c, changed, 'preset-one', context));
    expect(recalled.party[0].jobId).toBe('knight');
    expect(recalled.presets).toEqual(changed.presets);
    expect(value(deletePreset(recalled, 'preset-one')).party).toEqual(
      recalled.party,
    );
    expect(s.presets[0]!.name).toBe('編成');
  });
  it('同名を許可し、重複IDと21件目を拒否して同時刻をID順に並べる', () => {
    const c = data();
    let s = initial(c);
    for (let i = 0; i < 20; i++)
      s = value(
        createPreset(
          c,
          s,
          { ...metadata, id: `preset-${String(i).padStart(2, '0')}` },
          context,
        ),
      );
    expect(
      createPreset(c, s, { ...metadata, id: 'preset-new' }, context).ok,
    ).toBe(false);
    expect(
      overwritePreset(
        c,
        s,
        { ...metadata, id: 'preset-00', now: 2000 },
        context,
      ).ok,
    ).toBe(true);
    expect(s.presets.map((p) => p.id)).toEqual(
      [...s.presets.map((p) => p.id)].sort(),
    );
    expect(sortPresets(s.presets)).toEqual(s.presets);
    expect(createPreset(c, saved(c), metadata, context).ok).toBe(false);
  });
  it('不整合の旧プリセットを保持し、明示的な修復呼出時だけ削除済み装備を外す', () => {
    const c = data();
    const s = saved(c);
    s.presets[0]!.party[0].equipment[0] = 'relic-01-01';
    const before = structuredClone(s);
    expect(recallPreset(c, s, 'preset-one', context).ok).toBe(false);
    const preview = value(previewPresetRepair(c, s.presets[0]!, context));
    expect(preview.issues).toEqual([]);
    expect(preview.changes).toHaveLength(1);
    expect(s).toEqual(before);
    const repaired = value(
      recallPreset(c, s, 'preset-one', context, { repair: true }),
    );
    expect(repaired.party[0].equipment[0]).toBeNull();
    expect(repaired.presets).toEqual(before.presets);
  });
  it('人物順・枠順に所持数まで装備を保持する', () => {
    const c = data();
    const s = saved(c);
    s.presets[0]!.party.forEach((p) => {
      p.equipment = ['starter-armor', 'starter-armor', null, null, null, null];
    });
    const result = value(previewPresetRepair(c, s.presets[0]!, context));
    expect(result.party.map((p) => p.equipment.slice(0, 2))).toEqual([
      ['starter-armor', 'starter-armor'],
      ['starter-armor', null],
      [null, null],
    ]);
    expect(result.issues).toEqual([]);
  });
  it('未知・他職のスキルと前提を失った全ノードを除去する', () => {
    const c = data();
    const s = saved(c);
    s.presets[0]!.party[0].learnedSkills = [
      'wizard-a1',
      'knight-a2',
      'knight-a3',
    ];
    const result = value(previewPresetRepair(c, s.presets[0]!, context));
    expect(result.party[0].learnedSkills).toEqual([]);
    expect(result.changes).toHaveLength(3);
    expect(s.presets[0]!.party[0].learnedSkills).toHaveLength(3);
  });
  it('未知のジョブとポイント超過を自動修復しない', () => {
    const c = data();
    const s = saved(c);
    s.presets[0]!.party[0].learnedSkills.push('knight-a3');
    expect(recallPreset(c, s, 'preset-one', context, { repair: true }).ok).toBe(
      false,
    );
    const p = structuredClone(s.presets[0]!) as unknown as {
      party: { jobId: string }[];
    };
    p.party[0]!.jobId = 'removed-job';
    expect(
      value(
        previewPresetRepair(c, p as unknown as BuildPreset, full),
      ).issues.some((i) => i.code === 'job'),
    ).toBe(true);
  });
  it('明示的なID移行表を通常呼出前に適用し、保存済み原本を保持する', () => {
    const c = data();
    const s = saved(c);
    s.presets[0]!.party[0].equipment[0] = 'removed-item' as never;
    const next = value(
      recallPreset(c, s, 'preset-one', context, {
        migration: { equipment: { 'removed-item': 'starter-sword' } },
      }),
    );
    expect(next.party[0].equipment[0]).toBe('starter-sword');
    expect(next.presets[0]!.party[0].equipment[0]).toBe('removed-item');
  });
  it('不正な日時・管理情報・破損した構造・未知IDを拒否する', () => {
    const c = data();
    const s = saved(c);
    expect(renamePreset(s, 'preset-one', 'test', 999).ok).toBe(false);
    expect(deletePreset(s, 'preset-missing').ok).toBe(false);
    expect(
      overwritePreset(c, s, { ...metadata, contentVersion: -1 }, context).ok,
    ).toBe(false);
    expect(
      validatePreset(c, { ...s.presets[0], extra: 3 }, context).length,
    ).toBeGreaterThan(0);
    s.presets[0]!.party = null as never;
    expect(recallPreset(c, s, 'preset-one', context).ok).toBe(false);
    expect(previewPresetRepair(c, s.presets[0]!, context).ok).toBe(false);
  });
});

describe('戦闘開始時の共通編成検証', () => {
  it('有効な初期編成を全快HPと装備反映済みの能力値で開始する', () => {
    const c = data();
    const s = initial(c);
    const battle = createBattle(c, {
      party: s.party,
      enemyId: 'boss-01',
      context,
    });
    expect(battle.state.now).toBe(96);
    expect(battle.state.participants[0]).toMatchObject({
      hp: 350,
      stats: { maxHp: 350, atk: 50, mag: 50, def: 15, mdef: 15, spd: 105 },
    });
  });
  it('戦闘生成前に予算超過・所持数超過・未所持の遺物を拒否する', () => {
    const c = data();
    const s = initial(c);
    s.party[0].learnedSkills.push('knight-a3');
    expect(() =>
      createBattle(c, { party: s.party, enemyId: 'boss-01', context }),
    ).toThrow('budget');
    s.party[0].learnedSkills.pop();
    s.party[0].equipment[0] = 'relic-01-01';
    expect(() =>
      createBattle(c, { party: s.party, enemyId: 'boss-01', context }),
    ).toThrow('inventory');
    s.party[0].equipment[0] = 'starter-armor';
    expect(() =>
      createBattle(c, { party: s.party, enemyId: 'boss-01', context }),
    ).toThrow('inventory');
  });
});
