import { getSkillPointLimit, getInventory } from '../party';
import { describe, expect, it } from 'vitest';
import { releaseFixture } from '../data/release.fixtures.test-support';
import { createCampaignMetadata } from '../data/campaign';
import {
  createInitialProgression,
  deriveProgression,
  validateProgression,
  normalizeProgression,
  warpToFloor,
  selectNode,
  createVictoryCandidate,
  leaveEncounter,
  returnToGuild,
  moveToNextFloor,
  getFloorAccess,
  validateEncounter,
  type ProgressionResult,
  type Progression,
  type Encounter,
} from './index';
/** 成功値を取得し、不正なら理由付きでテストを失敗させる。
 * @param result 検証する結果。
 */
function value<T>(result: ProgressionResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}
/** ボス部屋直前まで通常移動する。
 * @param count 合成リリースの収録階層数。
 */
function atBoss(count = 1) {
  const release = releaseFixture(count);
  let p = value(
    warpToFloor(release, createInitialProgression(), 'floor-01'),
  ).progression;
  for (const n of ['hall-1', 'hall-2', 'hall-3'] as const)
    p = value(selectNode(release, p, `floor-01-${n}`)).progression;
  const encounter = value(selectNode(release, p, 'floor-01-boss')).encounter!;
  return { release, p, encounter };
}

describe('進行の正規集合と報酬導出', () => {
  it('初期予算3・初期品各3・第1階層だけを導出する', () => {
    const d = deriveProgression(
      createCampaignMetadata(),
      createInitialProgression(),
    );
    expect(d.skillPointLimit).toBe(3);
    expect(d.unlockedFloorIds).toEqual(['floor-01']);
    expect(d.finalClear).toBe(false);
    expect(d.inventory.get('starter-sword')).toBe(3);
    expect(d.inventory.get('relic-10-05')).toBe(0);
    const r = releaseFixture();
    const context = {
      defeatedEnemyIds: ['boss-01', 'guardian-01-01'] as const,
      inBattle: false,
    };
    const mutable = {
      ...context,
      defeatedEnemyIds: [...context.defeatedEnemyIds],
    };
    const progressed = deriveProgression(r.campaign, mutable);
    expect(getSkillPointLimit(mutable, r.campaign)).toBe(
      progressed.skillPointLimit,
    );
    expect(getInventory(r.content, mutable, r.campaign)).toEqual(
      progressed.inventory,
    );
  });
  it.each([
    null,
    {},
    { ...createInitialProgression(), location: null },
    { ...createInitialProgression(), defeatedEnemyIds: ['boss-11'] },
    { ...createInitialProgression(), extra: true },
  ])('不正な進行JSONを例外なく拒否する', (raw) => {
    expect(
      validateProgression(createCampaignMetadata(), raw).length,
    ).toBeGreaterThan(0);
  });
  it('重複を検出して明示正規化し、ボス順序の穴と未解放守護者は補わない', () => {
    const p = createInitialProgression();
    p.defeatedEnemyIds = ['boss-01', 'boss-01'];
    p.visitedFloorIds = ['floor-01', 'floor-01'];
    expect(validateProgression(createCampaignMetadata(), p)).toHaveLength(2);
    const normalized = value(normalizeProgression(createCampaignMetadata(), p));
    expect(normalized.defeatedEnemyIds).toEqual(['boss-01']);
    expect(p.defeatedEnemyIds).toHaveLength(2);
    for (const id of ['boss-03', 'guardian-02-01'] as const) {
      const bad = createInitialProgression();
      bad.defeatedEnemyIds = [id];
      expect(normalizeProgression(createCampaignMetadata(), bad).ok).toBe(
        false,
      );
    }
  });
  it('不正な復帰先・訪問・クリア前の結末処理を拒否する', () => {
    const p = createInitialProgression();
    p.location = {
      kind: 'floor',
      floorId: 'floor-01',
      nodeId: 'floor-02-entry',
    };
    p.visitedFloorIds = ['floor-02'];
    p.endingHandled = true;
    expect(validateProgression(createCampaignMetadata(), p)).toHaveLength(3);
    p.location = {
      kind: 'floor',
      floorId: 'floor-01',
      nodeId: 'floor-01-boss',
    };
    expect(
      validateProgression(createCampaignMetadata(), p).some((i) =>
        i.message.includes('生存敵'),
      ),
    ).toBe(true);
  });
});

describe('探索・遭遇・勝利候補の一括生成', () => {
  it('守護者を回避してボスへ進み、遭遇中は親分岐を保持する', () => {
    const { release, p, encounter } = atBoss();
    const original = structuredClone(p);
    expect(p.defeatedEnemyIds).toEqual([]);
    expect(p.location).toMatchObject({ nodeId: 'floor-01-hall-3' });
    expect(encounter.room.nodeId).toBe('floor-01-boss');
    expect(validateEncounter(release, p, encounter)).toEqual([]);
    expect(value(leaveEncounter(release, p, encounter))).toEqual(p);
    expect(p).toEqual(original);
    expect(selectNode(release, p, 'floor-01-entry').ok).toBe(false);
  });
  it('ボス勝利は討伐・予算・次階層・復帰をまとめて導出し、再付与しない', () => {
    const { release, p, encounter } = atBoss();
    const before = structuredClone(p);
    const win = value(createVictoryCandidate(release, p, encounter, 'boss-01'));
    expect(win.progression.location).toEqual(encounter.room);
    expect(win.derived.skillPointLimit).toBe(4);
    expect(win.derived.unlockedFloorIds).toEqual(['floor-01', 'floor-02']);
    expect(
      createVictoryCandidate(release, win.progression, encounter, 'boss-01').ok,
    ).toBe(false);
    expect(
      createVictoryCandidate(release, p, encounter, 'guardian-01-01').ok,
    ).toBe(false);
    expect(
      value(createVictoryCandidate(release, p, encounter, 'boss-01')),
    ).toEqual(win);
    expect(p).toEqual(before);
    expect(moveToNextFloor(release, win.progression)).toMatchObject({
      ok: false,
    });
    const guild = value(returnToGuild(release, win.progression)).progression;
    expect(warpToFloor(release, guild, 'floor-02')).toMatchObject({
      ok: false,
    });
    expect(getFloorAccess(release, guild)[1]).toMatchObject({
      unlocked: true,
      playable: false,
      canWarp: false,
      hintsAvailable: true,
    });
  });
  it('守護者勝利で遺物1個だけを取得し、再訪では遭遇を生成しない', () => {
    const release = releaseFixture();
    let p = value(
      warpToFloor(release, createInitialProgression(), 'floor-01'),
    ).progression;
    p = value(selectNode(release, p, 'floor-01-hall-1')).progression;
    const encounter = value(
      selectNode(release, p, 'floor-01-alcove-1'),
    ).encounter!;
    const win = value(
      createVictoryCandidate(release, p, encounter, 'guardian-01-01'),
    );
    expect(win.derived.inventory.get('relic-01-01')).toBe(1);
    expect(win.derived.skillPointLimit).toBe(3);
    p = value(
      selectNode(release, win.progression, 'floor-01-hall-1'),
    ).progression;
    const revisit = value(selectNode(release, p, 'floor-01-alcove-1'));
    expect(revisit.encounter).toBeNull();
    expect(revisit.progression.location).toMatchObject({
      nodeId: 'floor-01-alcove-1',
    });
    expect(validateEncounter(release, p, encounter).length).toBeGreaterThan(0);
  });
  it('初訪問候補だけで入口文を表示し、帰還・ワープ・再訪に消耗がない', () => {
    const r = releaseFixture();
    const original = createInitialProgression();
    const first = value(warpToFloor(r, original, 'floor-01'));
    expect(first.showEntryText).toBe(true);
    expect(original.visitedFloorIds).toEqual([]);
    const guild = value(returnToGuild(r, first.progression)).progression;
    expect(value(warpToFloor(r, guild, 'floor-01')).showEntryText).toBe(false);
    expect(warpToFloor(r, guild, 'floor-02').ok).toBe(false);
    expect(warpToFloor(r, first.progression, 'floor-01').ok).toBe(false);
  });
  it('遭遇の敵・部屋・親分岐の改ざんと跨階層移動を拒否する', () => {
    const { release, p, encounter } = atBoss(2);
    for (const altered of [
      { ...encounter, enemyId: 'guardian-01-01' },
      { ...encounter, room: { ...encounter.room, floorId: 'floor-02' } },
      {
        ...encounter,
        parent: { ...encounter.parent, nodeId: 'floor-01-hall-1' },
      },
    ] as Encounter[])
      expect(validateEncounter(release, p, altered).length).toBeGreaterThan(0);
    expect(selectNode(release, p, 'floor-02-entry').ok).toBe(false);
  });
  it('討伐済み出口から次階層へ進め、最終勝利はguildと結末未処理にする', () => {
    const { release, p, encounter } = atBoss(10);
    const win = value(createVictoryCandidate(release, p, encounter, 'boss-01'));
    expect(
      value(moveToNextFloor(release, win.progression)).progression.location,
    ).toMatchObject({ floorId: 'floor-02', nodeId: 'floor-02-entry' });
    const final: Progression = {
      ...createInitialProgression(),
      defeatedEnemyIds: release.campaign.enemies
        .filter((e) => e.id.startsWith('boss-') && e.id !== 'boss-10')
        .map((e) => e.id),
      location: {
        kind: 'floor',
        floorId: 'floor-10',
        nodeId: 'floor-10-hall-3',
      },
    };
    const finalEncounter = value(
      selectNode(release, final, 'floor-10-boss'),
    ).encounter!;
    const finalWin = value(
      createVictoryCandidate(release, final, finalEncounter, 'boss-10'),
    );
    expect(finalWin.derived.finalClear).toBe(true);
    expect(finalWin.derived.skillPointLimit).toBe(12);
    expect(finalWin.progression.location).toEqual({ kind: 'guild' });
    expect(finalWin.progression.endingHandled).toBe(false);
  });
});
