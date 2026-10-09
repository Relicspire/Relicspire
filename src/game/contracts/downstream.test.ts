import { describe, expect, it } from 'vitest';
import { releaseFixture } from '../data/release.fixtures.test-support';
import { parseGameRelease, validateGameRelease } from '../data/release';
import {
  createInitialProgression,
  warpToFloor,
  selectNode,
  createVictoryCandidate,
  returnToGuild,
  moveToNextFloor,
  validateProgression,
  getFloorAccess,
  deriveProgression,
  leaveEncounter,
  type Progression,
  type ProgressionResult,
} from '../progression';
import {
  createInitialFormation,
  getSkillPointLimit,
  getInventory,
  previewCurrentPartyRecovery,
  previewPresetRepair,
  createPreset,
  inspectPresetCollection,
  validateFormation,
  type FormationResult,
} from '../party';
import {
  createBattle,
  getInputActor,
  getBattleOutcome,
  previewCommand,
  submitCommand,
  getBattleDelta,
  getBattleEvents,
  getDisplayLog,
  getBattleDisplay,
  advanceBattle,
} from '../battle';
import { fixture, skill, attackPayload } from '../battle/fixtures.test-support';
import { Engine } from '../battle/engine';
import type { NodeId } from '../data/model';
import type { PlayerCommand } from '../battle/types';
/** 成功した候補を取得し、失敗なら契約テストを停止する。
 * @param result 純粋APIの結果。
 */
function value<T>(result: ProgressionResult<T> | FormationResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}
/** 読み込み元を再帰的に凍結し、コピー前の書き込みを検出する。
 * @param input APIへ渡す確定状態。
 */
function freeze<T>(input: T): T {
  if (input && typeof input === 'object') {
    for (const child of Object.values(input)) freeze(child);
    Object.freeze(input);
  }
  return input;
}
/** 指定した階層の入口から守護者を避けてボス直前まで進む。
 * @param release 検証済み合成リリース。
 * @param p 入口にいる確定進行。
 */
function approachBoss(
  release: ReturnType<typeof parseGameRelease>,
  p: Progression,
) {
  if (p.location.kind !== 'floor') throw new Error('入口ではありません');
  const floor = p.location.floorId;
  for (const suffix of ['hall-1', 'hall-2', 'hall-3'])
    p = value(
      selectNode(release, p, `${floor}-${suffix}` as NodeId),
    ).progression;
  return {
    p,
    encounter: value(selectNode(release, p, `${floor}-boss`)).encounter!,
  };
}
/** 指定の候補入力を作る。
 * @param skillId 使用するスキル。
 */
const command = (
  skillId: PlayerCommand['skillId'] = 'basic-attack',
): PlayerCommand => ({
  actorId: 'party-1',
  skillId,
  selectedTargetId: 'boss-01',
  chosenElement: null,
});

describe('リリース・探索・戦闘・保存候補の接続契約', () => {
  it('MVPの実戦勝利から解放候補を作り、保存失敗の破棄と再試行でも開始前進行を維持する', () => {
    const raw = releaseFixture();
    raw.content.enemies[0]!.stats.maxHp = 1;
    const release = freeze(parseGameRelease(raw));
    const initial = createInitialProgression();
    const entered = value(warpToFloor(release, initial, 'floor-01'));
    const { p, encounter } = approachBoss(release, entered.progression);
    const committed = freeze(p);
    const before = structuredClone(committed);
    const party = value(
      createInitialFormation(release.content, {
        defeatedEnemyIds: committed.defeatedEnemyIds,
        inBattle: false,
      }),
    ).party;
    const session = freeze(
      createBattle(
        release.content,
        {
          party,
          enemyId: encounter.enemyId,
          campaign: release.campaign,
          context: {
            defeatedEnemyIds: committed.defeatedEnemyIds,
            inBattle: false,
          },
        },
        committed,
      ),
    );
    expect(getInputActor(session)).toBe('party-1');
    const preview = previewCommand(session, command());
    if (!preview.ok) throw new Error('予測不可');
    const result = submitCommand(session, command(), { advance: false });
    if (!result.ok) throw new Error(result.reason);
    expect(preview.committed).toEqual(getBattleDelta(session, result.session));
    const outcome = getBattleOutcome(result.session);
    expect(outcome.result).toBe('victory');
    expect(outcome.preBattle).toEqual(before);
    const failedCandidate = value(
      createVictoryCandidate(
        release,
        outcome.preBattle,
        encounter,
        encounter.enemyId,
      ),
    );
    failedCandidate.progression.defeatedEnemyIds.push('guardian-01-01');
    expect(committed).toEqual(before);
    expect(value(leaveEncounter(release, committed, encounter))).toEqual(
      before,
    );
    const retry = value(
      createVictoryCandidate(release, committed, encounter, encounter.enemyId),
    );
    expect(retry.progression.defeatedEnemyIds).toEqual(['boss-01']);
    expect(retry.reward).toEqual(outcome.reward);
    const guild = value(returnToGuild(release, retry.progression)).progression;
    expect(getFloorAccess(release, guild)[1]).toMatchObject({
      unlocked: true,
      playable: false,
      canWarp: false,
    });
    expect(warpToFloor(release, guild, 'floor-02').ok).toBe(false);
    expect(validateProgression(release.campaign, retry.progression)).toEqual(
      [],
    );
    expect(
      createVictoryCandidate(
        release,
        retry.progression,
        encounter,
        encounter.enemyId,
      ).ok,
    ).toBe(false);
  });
  it('MVPで保持したfloor-02解放をフル版へ引き継ぎ、守護者なしで最終ボスまで純粋APIで接続する', () => {
    const raw = releaseFixture(10);
    raw.content.enemies.forEach((e) => {
      e.stats.maxHp = 1;
    });
    const full = freeze(parseGameRelease(raw));
    let p = value(
      warpToFloor(full, createInitialProgression(), 'floor-01'),
    ).progression;
    for (let floor = 1; floor <= 10; floor++) {
      const approached = approachBoss(full, p);
      p = approached.p;
      const before = structuredClone(p);
      const context = { defeatedEnemyIds: p.defeatedEnemyIds, inBattle: false };
      const party = value(createInitialFormation(full.content, context)).party;
      const battle = createBattle(
        full.content,
        {
          party,
          enemyId: approached.encounter.enemyId,
          context,
          campaign: full.campaign,
        },
        p,
      );
      const actor = getInputActor(battle)!;
      const result = submitCommand(
        battle,
        {
          ...command(),
          actorId: actor,
          selectedTargetId: approached.encounter.enemyId,
        },
        { advance: false },
      );
      if (!result.ok) throw new Error(result.reason);
      expect(getBattleOutcome(result.session).result).toBe('victory');
      const candidate = value(
        createVictoryCandidate(
          full,
          p,
          approached.encounter,
          approached.encounter.enemyId,
        ),
      );
      expect(p).toEqual(before);
      p = candidate.progression;
      expect(validateProgression(full.campaign, p)).toEqual([]);
      expect(
        getSkillPointLimit(
          { defeatedEnemyIds: p.defeatedEnemyIds, inBattle: false },
          full.campaign,
        ),
      ).toBe(candidate.derived.skillPointLimit);
      if (floor === 1) {
        const mvp = parseGameRelease(releaseFixture());
        expect(validateProgression(mvp.campaign, p)).toEqual([]);
        expect(moveToNextFloor(mvp, p).ok).toBe(false);
      }
      if (floor < 10) p = value(moveToNextFloor(full, p)).progression;
    }
    expect(p.defeatedEnemyIds).toHaveLength(10);
    expect(p.defeatedEnemyIds.every((id) => id.startsWith('boss-'))).toBe(true);
    expect(p.location).toEqual({ kind: 'guild' });
    expect(p.endingHandled).toBe(false);
    expect(deriveProgression(full.campaign, p)).toMatchObject({
      finalClear: true,
      skillPointLimit: 12,
    });
    const inventory = getInventory(
      full.content,
      { defeatedEnemyIds: p.defeatedEnemyIds, inBattle: false },
      full.campaign,
    );
    expect(
      [...inventory].filter(
        ([id, count]) => id.startsWith('relic-') && count > 0,
      ),
    ).toEqual([]);
  });
  it('破損した正式データと未知・順序の穴の進行は後続の戦闘・移動前に拒否する', () => {
    const release = releaseFixture();
    const broken = structuredClone(release);
    broken.campaign.enemies[0]!.reward.skillPointsPerCharacter = 7;
    expect(validateGameRelease(broken).length).toBeGreaterThan(0);
    const disconnected = structuredClone(release);
    disconnected.content.floors[0]!.nodes.forEach((n) => {
      n.links = n.links.filter((id) => !id.endsWith('alcove-1'));
      if (n.id.endsWith('alcove-1')) n.links = [];
    });
    expect(
      validateGameRelease(disconnected).some((i) => i.message.includes('到達')),
    ).toBe(true);
    const missing = structuredClone(release);
    missing.content.jobs.pop();
    expect(() => parseGameRelease(missing)).toThrow();
    for (const ids of [
      ['boss-03'],
      ['guardian-02-01'],
      ['unknown'],
    ] as unknown as Progression['defeatedEnemyIds'][]) {
      const bad = { ...createInitialProgression(), defeatedEnemyIds: ids };
      expect(validateProgression(release.campaign, bad).length).toBeGreaterThan(
        0,
      );
      expect(warpToFloor(release, bad, 'floor-01').ok).toBe(false);
    }
  });
});

describe('予測・演出差分・保存復旧の接続契約', () => {
  it('詠唱参考値は将来確定値ではなく、失効後の実発動との差を表示できる', () => {
    const s = fixture({
      jobs: ['wizard', 'knight', 'cleric'],
      skills: [
        skill('wizard-a3', {
          target: 'enemy-single',
          castTime: 60,
          effects: [
            {
              ...attackPayload(),
              kind: 'attack',
              target: 'selected',
              attached: [],
            },
          ],
        }),
      ],
    });
    const e = new Engine(s.content, s.state, s.log);
    e.applyStatus(
      s.state.participants[0],
      s.state.participants[0],
      { familyId: 'atk-up', magnitude: 2000 },
      20,
      true,
    );
    for (let i = 1; i < 4; i++)
      s.state.participants[i]!.action = {
        kind: 'waiting',
        ready: { kind: 'running', at: 500 },
      };
    e.syncTimeline();
    const before = structuredClone(s);
    const preview = previewCommand(freeze(s), command('wizard-a3'));
    if (!preview.ok) throw new Error('予測不可');
    expect(preview.expiringStatuses).toHaveLength(1);
    expect(preview.reference!.participants[3]!.hpChange).toBe(-38);
    expect(s).toEqual(before);
    const result = submitCommand(s, command('wizard-a3'), { advance: false });
    if (!result.ok) throw new Error(result.reason);
    const activated = advanceBattle(result.session, { stopAfterUnit: true });
    expect(activated.state.now).toBe(160);
    expect(
      activated.state.participants[3].hp -
        result.session.state.participants[3].hp,
    ).toBe(-30);
    const cursor = result.session.log.at(-1)!.sequence;
    expect(getBattleEvents(activated, cursor)).toEqual(
      getBattleDelta(result.session, activated).events,
    );
    expect(
      getBattleEvents(activated, cursor).some(
        (event) => event.kind === 'expire',
      ),
    ).toBe(true);
  });
  it('表示コピーと予測を破棄しても戦闘状態・全ログ・演出カーソルを変更しない', () => {
    const s = fixture();
    const e = new Engine(s.content, s.state, s.log);
    for (let i = 0; i < 240; i++) e.record('heal', 'party-1', 'party-1', i);
    const before = structuredClone(s);
    const cursor = s.log.at(-1)!.sequence;
    const view = getBattleDisplay(freeze(s));
    const log = getDisplayLog(s);
    const p = previewCommand(s, command());
    if (!p.ok) throw new Error('予測不可');
    view.participants[0]!.participant.hp = 0;
    log.pop();
    p.committed.after.participants[0].hp = 0;
    expect(s).toEqual(before);
    expect(getDisplayLog(s)).toHaveLength(200);
    expect(getBattleEvents(s, cursor)).toEqual([]);
    const actual = submitCommand(s, command(), { advance: false });
    if (!actual.ok) throw new Error(actual.reason);
    expect(getBattleEvents(actual.session, cursor)).toEqual(
      getBattleDelta(s, actual.session).events,
    );
    expect(actual.session.log.length).toBeGreaterThan(200);
  });
  it('復旧候補を再検証して戦闘開始へ渡せるが、同じ旧プリセットは自動で有効にしない', () => {
    const release = parseGameRelease(releaseFixture());
    const progression = createInitialProgression();
    const context = {
      defeatedEnemyIds: progression.defeatedEnemyIds,
      inBattle: false,
    };
    const state = value(
      createPreset(
        release.content,
        value(createInitialFormation(release.content, context)),
        { id: 'preset-old', name: '旧編成', now: 1, contentVersion: 1 },
        context,
      ),
    );
    const saved = structuredClone(state);
    saved.party[0].learnedSkills.push('knight-a3');
    saved.presets[0]!.party = structuredClone(saved.party);
    const original = structuredClone({ saved, progression });
    const recovered = value(
      previewCurrentPartyRecovery(
        release.content,
        freeze(saved.party),
        context,
      ),
    );
    expect(recovered.party[0].learnedSkills).toEqual([]);
    expect(recovered.issues).toEqual([]);
    expect(
      validateFormation(release.content, recovered.party, context),
    ).toEqual([]);
    expect(
      createBattle(
        release.content,
        {
          party: recovered.party,
          enemyId: 'boss-01',
          context,
          campaign: release.campaign,
        },
        progression,
      ).state.result,
    ).toBe('ongoing');
    expect(
      value(
        previewPresetRepair(release.content, saved.presets[0]!, context),
      ).issues.some((i) => i.code === 'budget'),
    ).toBe(true);
    const collection = inspectPresetCollection(
      release.content,
      saved.presets,
      context,
    );
    expect(collection.metadataValid).toBe(true);
    expect(collection.entries[0]!.callable).toBe(false);
    recovered.party[1].learnedSkills = [];
    expect({ saved, progression }).toEqual(original);
  });
});
