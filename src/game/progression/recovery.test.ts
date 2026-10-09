import { describe, expect, it } from 'vitest';
import { releaseFixture } from '../data/release.fixtures.test-support';
import { createBattle } from '../battle';
import {
  createInitialFormation,
  previewCurrentPartyRecovery,
  validateFormation,
  getInventory,
  getSkillPointLimit,
} from '../party';
import {
  createInitialProgression,
  migrateProgression,
  previewProgressionRecovery,
  validateProgression,
  warpToFloor,
  type ProgressionResult,
} from './index';

/** 成功した構造検証の値を取り出す。適用可否は個別に検証する。
 * @param result 移行／復旧の結果。
 */
function value<T>(result: ProgressionResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}
/** 入力を再帰的に凍結する。
 * @param input 照会元のカタログ・進行・対応表。
 */
function freeze(input: unknown): void {
  if (input && typeof input === 'object') {
    Object.values(input).forEach(freeze);
    Object.freeze(input);
  }
}

describe('保存進行のID移行と復旧候補', () => {
  it('旧形式IDを構造検証で拒否せず明示表だけで現在IDへ一段移行する', () => {
    const release = releaseFixture(2);
    const raw = {
      defeatedEnemyIds: ['old-boss', 'old-guardian'],
      visitedFloorIds: ['old-floor'],
      endingHandled: false,
      location: { kind: 'floor', floorId: 'old-floor', nodeId: 'old-hall' },
    };
    const result = value(
      migrateProgression(release.campaign, raw, {
        enemies: { 'old-boss': 'boss-01', 'old-guardian': 'guardian-02-01' },
        floors: { 'old-floor': 'floor-02' },
        nodes: { 'old-hall': 'floor-02-hall-1' },
      }),
    );
    expect(result.canApply).toBe(true);
    expect(result.canResume).toBeNull();
    expect(result.progression).toEqual({
      defeatedEnemyIds: ['boss-01', 'guardian-02-01'],
      visitedFloorIds: ['floor-02'],
      endingHandled: false,
      location: {
        kind: 'floor',
        floorId: 'floor-02',
        nodeId: 'floor-02-hall-1',
      },
    });
    expect(result.changes.map((c) => c.reason)).toEqual([
      'id-migration',
      'id-migration',
      'id-migration',
    ]);
    expect(validateProgression(release.campaign, result.progression)).toEqual(
      [],
    );
    expect(raw.defeatedEnemyIds).toEqual(['old-boss', 'old-guardian']);
  });

  it('ID移行で生じた重複は復旧段階で正規化し報酬を重複加算しない', () => {
    const release = releaseFixture();
    const raw = {
      ...createInitialProgression(),
      defeatedEnemyIds: [
        'old-boss',
        'boss-01',
        'old-guardian',
        'guardian-01-01',
      ],
      visitedFloorIds: ['old-floor', 'floor-01'],
    };
    const migration = {
      enemies: {
        'old-boss': 'boss-01' as const,
        'old-guardian': 'guardian-01-01' as const,
      },
      floors: { 'old-floor': 'floor-01' as const },
    };
    expect(
      value(migrateProgression(release.campaign, raw, migration)).canApply,
    ).toBe(false);
    const result = value(previewProgressionRecovery(release, raw, migration));
    expect(result.canApply).toBe(true);
    expect(result.progression.defeatedEnemyIds).toEqual([
      'boss-01',
      'guardian-01-01',
    ]);
    expect(result.progression.visitedFloorIds).toEqual(['floor-01']);
    expect(result.derived!.skillPointLimit).toBe(4);
    expect(result.derived!.inventory.get('relic-01-01')).toBe(1);
    expect(result.changes.filter((c) => c.reason === 'duplicate')).toHaveLength(
      2,
    );
  });

  it.each(['deleted-boss', 'boss-11', 'guardian-01-06'])(
    '対応表のない討伐ID %s を削除せず適用を停止する',
    (id) => {
      const raw = { ...createInitialProgression(), defeatedEnemyIds: [id] };
      const result = value(previewProgressionRecovery(releaseFixture(), raw));
      expect(result.canApply).toBe(false);
      expect(result.canResume).toBe(false);
      expect(result.derived).toBeNull();
      expect(result.progression.defeatedEnemyIds).toEqual([id]);
      expect(result.issues).toContainEqual(
        expect.objectContaining({ path: id, code: 'unknown-defeat' }),
      );
    },
  );

  it.each(['boss-03', 'guardian-02-01'] as const)(
    '進行の穴 %s は討伐や報酬の補完で修復しない',
    (id) => {
      const raw = {
        ...createInitialProgression(),
        defeatedEnemyIds: [id],
        endingHandled: true,
      };
      const result = value(previewProgressionRecovery(releaseFixture(), raw));
      expect(result.canApply).toBe(false);
      expect(result.derived).toBeNull();
      expect(result.progression.defeatedEnemyIds).toEqual([id]);
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.progression.endingHandled).toBe(true);
    },
  );

  it.each([
    { kind: 'floor', floorId: 'floor-01', nodeId: 'floor-01-boss' },
    { kind: 'floor', floorId: 'floor-02', nodeId: 'floor-02-entry' },
    { kind: 'floor', floorId: 'floor-01', nodeId: 'floor-02-hall-1' },
    { kind: 'floor', floorId: 'deleted-floor', nodeId: 'deleted-room' },
  ])(
    '意味が不正な復帰先 %j はguildへの候補にして通常検証を通す',
    (location) => {
      const release = releaseFixture();
      const raw = {
        ...createInitialProgression(),
        location,
        visitedFloorIds: ['floor-01', 'floor-01', 'floor-02', 'deleted-floor'],
        endingHandled: true,
      };
      expect(validateProgression(release.campaign, raw).length).toBeGreaterThan(
        0,
      );
      const result = value(previewProgressionRecovery(release, raw));
      expect(result.canApply).toBe(true);
      expect(result.progression.location).toEqual({ kind: 'guild' });
      expect(result.progression.visitedFloorIds).toEqual(['floor-01']);
      expect(result.progression.endingHandled).toBe(false);
      expect(result.changes.map((c) => c.reason)).toEqual([
        'duplicate',
        'invalid-visit',
        'ending-before-clear',
        'invalid-location',
      ]);
      expect(result.changes.at(-1)!.before).toEqual(location);
      expect(validateProgression(release.campaign, result.progression)).toEqual(
        [],
      );
    },
  );

  it.each([
    null,
    {},
    { ...createInitialProgression(), defeatedEnemyIds: [1] },
    { ...createInitialProgression(), endingHandled: 'true' },
    { ...createInitialProgression(), location: null },
    {
      ...createInitialProgression(),
      location: { kind: 'floor', floorId: 'floor-01' },
    },
    { ...createInitialProgression(), extra: 1 },
  ])('解釈できない構造破損 %j は候補を生成せず拒否する', (raw) => {
    expect(previewProgressionRecovery(releaseFixture(), raw).ok).toBe(false);
    expect(migrateProgression(releaseFixture().campaign, raw).ok).toBe(false);
  });

  it('既知の未収録進行と訪問と復帰先を保持し収録不足だけを提示する', () => {
    const release = releaseFixture();
    const raw = {
      ...createInitialProgression(),
      defeatedEnemyIds: ['boss-01', 'guardian-02-01'],
      visitedFloorIds: ['floor-02'],
      location: {
        kind: 'floor',
        floorId: 'floor-02',
        nodeId: 'floor-02-alcove-1',
      },
    };
    const result = value(previewProgressionRecovery(release, raw));
    expect(result.canApply).toBe(true);
    expect(result.canResume).toBe(false);
    expect(result.unavailableLocation).toBe('floor-02');
    expect(result.progression).toEqual(raw);
    expect(result.changes).toEqual([]);
    expect(result.derived!.inventory.get('relic-02-01')).toBe(1);
    expect(
      value(previewProgressionRecovery(releaseFixture(2), raw)).canResume,
    ).toBe(true);
  });

  it('全編クリアの結末処理を保持し最終ボスで予算を増やさない', () => {
    const raw = {
      ...createInitialProgression(),
      defeatedEnemyIds: Array.from(
        { length: 10 },
        (_, i) => `boss-${String(i + 1).padStart(2, '0')}`,
      ),
      endingHandled: true,
    };
    const result = value(previewProgressionRecovery(releaseFixture(), raw));
    expect(result.canApply).toBe(true);
    expect(result.progression.endingHandled).toBe(true);
    expect(result.derived).toMatchObject({
      finalClear: true,
      skillPointLimit: 12,
    });
    expect(result.changes).toEqual([]);
  });

  it('継承キーをID対応と扱わず対応先をさらに連鎖移行しない', () => {
    const release = releaseFixture();
    const enemies = Object.create({ deleted: 'boss-01' }) as Record<
      string,
      'boss-01'
    >;
    expect(
      value(
        previewProgressionRecovery(
          release,
          { ...createInitialProgression(), defeatedEnemyIds: ['deleted'] },
          { enemies },
        ),
      ).canApply,
    ).toBe(false);
    const result = value(
      previewProgressionRecovery(
        release,
        { ...createInitialProgression(), defeatedEnemyIds: ['old'] },
        { enemies: { old: 'boss-01', 'boss-01': 'boss-02' } },
      ),
    );
    expect(result.progression.defeatedEnemyIds).toEqual(['boss-01']);
    expect(result.canApply).toBe(true);
  });

  it('復旧した討伐集合から編成の予算と所持数を導出し編成復旧と戦闘へ接続できる', () => {
    const release = releaseFixture();
    const initial = createInitialFormation(release.content, {
      defeatedEnemyIds: [],
      inBattle: false,
    });
    if (!initial.ok) throw new Error('初期編成が不正');
    const party = structuredClone(initial.value.party);
    party[0].learnedSkills = ['knight-a1', 'knight-a2', 'knight-a3'];
    party[0].equipment[0] = 'relic-01-01';
    const progress = value(
      previewProgressionRecovery(
        release,
        {
          ...createInitialProgression(),
          defeatedEnemyIds: ['old-guardian'],
          endingHandled: true,
        },
        { enemies: { 'old-guardian': 'guardian-01-01' } },
      ),
    );
    expect(progress.canApply).toBe(true);
    const context = {
      defeatedEnemyIds: progress.progression.defeatedEnemyIds,
      inBattle: false,
    };
    const repaired = previewCurrentPartyRecovery(
      release.content,
      party,
      context,
    );
    if (!repaired.ok) throw new Error('編成構造が不正');
    expect(repaired.value.issues).toEqual([]);
    expect(repaired.value.party[0].learnedSkills).toEqual([]);
    expect(repaired.value.party[0].equipment[0]).toBe('relic-01-01');
    expect(getSkillPointLimit(context, release.campaign)).toBe(
      progress.derived!.skillPointLimit,
    );
    expect(getInventory(release.content, context, release.campaign)).toEqual(
      progress.derived!.inventory,
    );
    expect(
      validateFormation(release.content, repaired.value.party, context),
    ).toEqual([]);
    expect(warpToFloor(release, progress.progression, 'floor-01').ok).toBe(
      true,
    );
    expect(
      createBattle(release.content, {
        party: repaired.value.party,
        enemyId: 'boss-01',
        context,
        campaign: release.campaign,
      }).state.result,
    ).toBe('ongoing');
    expect(party[0].learnedSkills).toHaveLength(3);
  });

  it('凍結入力でも候補を作れ返却した原本と差分と候補は互いに独立する', () => {
    const release = releaseFixture();
    const raw = {
      ...createInitialProgression(),
      defeatedEnemyIds: ['old', 'boss-01'],
    };
    const migration = { enemies: { old: 'boss-01' as const } };
    const original = structuredClone(raw);
    freeze(release);
    freeze(raw);
    freeze(migration);
    const result = value(previewProgressionRecovery(release, raw, migration));
    expect(result.canApply).toBe(true);
    expect(
      value(previewProgressionRecovery(release, result.progression)).changes,
    ).toEqual([]);
    (result.original as { defeatedEnemyIds: string[] }).defeatedEnemyIds.push(
      'changed',
    );
    (result.changes[0]!.after as string[]).push('changed');
    result.derived!.inventory.clear();
    expect(result.progression.defeatedEnemyIds).toEqual(['boss-01']);
    expect(raw).toEqual(original);
    result.progression.defeatedEnemyIds.push('boss-02');
    expect(raw).toEqual(original);
  });
});
