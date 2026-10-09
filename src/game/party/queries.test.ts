import { describe, expect, it } from 'vitest';
import {
  createBattle,
  checkCommand,
  effectiveStats,
  submitCommand,
} from '../battle';
import { attackPayload, fixture, skill } from '../battle/fixtures.test-support';
import { previewCommand } from '../battle/queries';
import { getBuildStats, getGuildBuildDetails, learnSkill } from './index';
import type { FormationContext, PartyFormation } from './types';
import type { GameContent } from '../data/model';

/** 初期の空欄装備・未習得編成を生成する。
 * @param content 人物の初期ジョブを持つカタログ。
 */
function party(content: GameContent): PartyFormation {
  return content.characters.map((c) => ({
    id: c.id,
    jobId: c.initialJob,
    learnedSkills: [],
    equipment: structuredClone(c.initialEquipment),
  })) as unknown as PartyFormation;
}
/** 非変更契約の検証用に配下を含めて凍結する。
 * @param value 照会元のデータ。
 */
function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}
/** 初期予算・戦闘外の照会条件。 */
const context: FormationContext = { defeatedEnemyIds: [], inBattle: false };

describe('拠点の能力値とスキル性能照会', () => {
  it('指定対象への単独攻撃の参考値とディレイが実行結果に一致する', () => {
    const content = fixture({
      skills: [
        skill('knight-a1', {
          target: 'enemy-single',
          delay: 91,
          effects: [
            {
              kind: 'attack',
              target: 'selected',
              attached: [],
              ...attackPayload(),
            },
          ],
        }),
      ],
    }).content;
    const builds = party(content);
    builds[0].learnedSkills = ['knight-a1'];
    content.characters[0]!.baseStats.spd = 175;
    const session = createBattle(content, {
      party: builds,
      enemyId: 'boss-01',
      context,
    });
    const enemy = session.state.participants.find((p) => p.side === 'enemy')!;
    const details = getGuildBuildDetails(content, builds[0], context, {
      targets: { selected: { participant: enemy, enemy: content.enemies[0]! } },
    }).skills[0]!;
    const result = submitCommand(
      session,
      {
        actorId: 'party-1',
        skillId: 'knight-a1',
        selectedTargetId: enemy.id,
        chosenElement: null,
      },
      { advance: false },
    );
    expect(result.ok).toBe(true);
    const after = result.session.state.participants.find(
      (p) => p.side === 'enemy',
    )!;
    expect(enemy.hp - after.hp).toBe(details.effects[0]!.hpAmount);
    expect(enemy.breakGauge! - after.breakGauge!).toBe(
      details.effects[0]!.breakAmount,
    );
    expect(result.session.state.participants[0]!.action).toEqual({
      kind: 'waiting',
      ready: {
        kind: 'running',
        at: session.state.now + details.delayReference,
      },
    });
  });

  it('自己対象には本人の防御を使い罠は発動時を仮定した攻撃性能として返す', () => {
    const session = fixture({
      skills: [
        skill('knight-a1', {
          effects: [
            {
              kind: 'attack',
              target: 'self',
              attached: [],
              ...attackPayload(),
            },
          ],
        }),
        skill('knight-b1', {
          target: 'enemy-single',
          effects: [
            {
              kind: 'trap',
              target: 'selected',
              duration: 200,
              attack: attackPayload(),
              attached: [],
              snapshot: 'on-trigger',
            },
          ],
        }),
      ],
    });
    const build = party(session.content)[0];
    const enemy = session.state.participants.find((p) => p.side === 'enemy')!;
    const details = getGuildBuildDetails(session.content, build, context, {
      targets: {
        selected: { participant: enemy, enemy: session.content.enemies[0]! },
      },
    });
    expect(details.skills[0]!.effects[0]!.hpAmount).toBe(30);
    expect(details.skills[3]!.effects[0]).toMatchObject({
      kind: 'trap',
      hpAmount: 30,
      breakAmount: 5,
    });
    expect(details.reference).toBe(
      'independent-effects-without-actor-statuses',
    );
  });

  it('空欄と装備集中の集計が戦闘開始の能力値と待機TUに一致する', () => {
    const content = fixture().content;
    content.equipment.push({
      id: 'starter-boots',
      kind: 'starter',
      stats: { spd: 25, atk: 10 },
      maxOwned: 3,
    });
    const builds = party(content);
    const before = getBuildStats(content, builds[0]);
    builds[0].equipment.splice(
      0,
      3,
      'starter-boots',
      'starter-boots',
      'starter-boots',
    );
    const after = getBuildStats(content, builds[0]);
    expect(before.equipmentStats.spd).toBe(100);
    expect(after.equipmentStats.spd).toBe(175);
    expect(after.effectiveStats.atk).toBe(70);
    const session = createBattle(content, {
      party: builds,
      enemyId: 'boss-01',
      context,
    });
    for (const build of builds) {
      const stats = getBuildStats(content, build);
      const participant = session.state.participants.find(
        (p) => p.id === build.id,
      )!;
      expect(effectiveStats(participant)).toEqual(stats.effectiveStats);
      expect(
        participant.action.kind === 'ready'
          ? session.state.now
          : participant.action.kind === 'waiting' &&
              participant.action.ready.kind === 'running'
            ? participant.action.ready.at
            : null,
      ).toBe(stats.initialWait);
    }
  });

  it('能力値の下限と上限を装備加算後に適用し戦闘と共有する', () => {
    const content = fixture().content;
    content.equipment.push({
      id: 'starter-ring',
      kind: 'starter',
      stats: { mag: 20000 },
      maxOwned: 3,
    });
    content.characters[0]!.baseStats = {
      maxHp: 1,
      atk: 1,
      mag: 1,
      def: 0,
      mdef: 0,
      spd: 1,
    };
    const builds = party(content);
    builds[0].equipment[0] = 'starter-ring';
    const stats = getBuildStats(content, builds[0]);
    expect(stats.equipmentStats.spd).toBe(1);
    expect(stats.effectiveStats).toMatchObject({
      maxHp: 1,
      atk: 1,
      mag: 9999,
      def: 0,
      spd: 25,
    });
    const session = createBattle(content, {
      party: builds,
      enemyId: 'boss-01',
      context,
    });
    expect(effectiveStats(session.state.participants[0]!)).toEqual(
      stats.effectiveStats,
    );
  });

  it('未習得の上位ノードも閲覧できるが前提と予算の制約を緩めない', () => {
    const content = fixture().content;
    const builds = party(content);
    builds[0].learnedSkills = ['knight-a1', 'knight-a2'];
    const details = getGuildBuildDetails(content, builds[0], context);
    expect(details.skills).toHaveLength(6);
    expect(details.skills.find((s) => s.node.id === 'knight-a1')).toMatchObject(
      { learned: true, activeCommand: false, replacedBy: 'knight-a2' },
    );
    expect(details.skills.find((s) => s.node.id === 'knight-a3')).toMatchObject(
      {
        learned: false,
        canLearn: false,
        remainingPoints: 0,
        missingPrerequisites: [],
        node: { cost: 3 },
      },
    );
    expect(
      details.skills.find((s) => s.node.id === 'knight-b2')!
        .missingPrerequisites,
    ).toEqual(['knight-b1']);
    expect(
      learnSkill(
        content,
        { party: builds, presets: [] },
        'party-1',
        'knight-a3',
        context,
      ).ok,
    ).toBe(false);
    const session = createBattle(content, {
      party: builds,
      enemyId: 'boss-01',
      context,
    });
    expect(
      checkCommand(session, {
        actorId: 'party-1',
        skillId: 'knight-a3',
        selectedTargetId: null,
        chosenElement: null,
      }).ok,
    ).toBe(false);
    expect(
      previewCommand(session, {
        actorId: 'party-1',
        skillId: 'knight-a3',
        selectedTargetId: null,
        chosenElement: null,
      }).ok,
    ).toBe(false);
  });

  it('前提と予算が揃った候補でも戦闘中は習得可能として表示しない', () => {
    const content = fixture().content;
    const build = party(content)[0];
    expect(
      getGuildBuildDetails(content, build, context).skills[0]!.canLearn,
    ).toBe(true);
    expect(
      getGuildBuildDetails(content, build, { ...context, inBattle: true })
        .skills[0]!.canLearn,
    ).toBe(false);
  });

  it('対象・属性・背水HPを未指定なら数値を確定せず必要条件を返す', () => {
    const session = fixture({
      skills: [
        skill('knight-a3', {
          target: 'enemy-single',
          elementChoices: ['fire', 'lightning'],
          effects: [
            {
              kind: 'attack',
              target: 'selected',
              attached: [],
              ...attackPayload({
                element: 'chosen',
                power: {
                  kind: 'low-hp',
                  normal: 100,
                  lowHp: 200,
                  snapshot: 'before-activation',
                },
              }),
            },
          ],
        }),
      ],
    });
    const build = party(session.content)[0];
    const missing = getGuildBuildDetails(session.content, build, context)
      .skills[2]!.effects[0]!;
    expect(missing).toMatchObject({
      hpAmount: null,
      breakAmount: null,
      missing: ['target', 'element', 'actor-hp'],
    });
    const target = {
      participant: session.state.participants.find((p) => p.side === 'enemy')!,
      enemy: session.content.enemies[0]!,
    };
    const options = {
      chosenElement: 'lightning' as const,
      actorHp: 150,
      targets: { selected: target },
    };
    const low = getGuildBuildDetails(session.content, build, context, options)
      .skills[2]!.effects[0]!;
    expect(low).toMatchObject({ hpAmount: 105, breakAmount: 10, missing: [] });
    expect(
      getGuildBuildDetails(session.content, build, context, {
        ...options,
        actorHp: 151,
      }).skills[2]!.effects[0]!.hpAmount,
    ).toBe(45);
    target.enemy.immuneElements = ['lightning'];
    expect(
      getGuildBuildDetails(session.content, build, context, options).skills[2]!
        .effects[0],
    ).toMatchObject({ hpAmount: 0, breakAmount: 0 });
  });

  it('回復は不足HP適用前の量を返し蘇生は対象最大HPを指定した場合だけ返す', () => {
    const session = fixture({
      jobs: ['cleric', 'wizard', 'knight'],
      skills: [
        skill('cleric-a1', {
          target: 'ally-single',
          effects: [
            {
              kind: 'heal',
              target: 'selected',
              power: 150,
              actorReference: 'before-activation',
              targetReference: 'before-effect',
            },
          ],
        }),
        skill('cleric-a3', {
          target: 'dead-ally-other',
          effects: [{ kind: 'revive', target: 'selected', hpRatio: 3000 }],
        }),
      ],
    });
    const build = party(session.content)[0];
    const details = getGuildBuildDetails(session.content, build, context);
    expect(details.skills[0]!.effects[0]!.hpAmount).toBe(60);
    expect(details.skills[2]!.effects[0]).toMatchObject({
      hpAmount: null,
      missing: ['target'],
    });
    const target = { participant: session.state.participants[1]!, enemy: null };
    expect(
      getGuildBuildDetails(session.content, build, context, {
        targets: { selected: target },
      }).skills[2]!.effects[0]!.hpAmount,
    ).toBe(90);
  });

  it('入力を凍結しても照会でき返却した定義や条件の編集が原本へ波及しない', () => {
    const content = fixture().content;
    const build = party(content)[0];
    const options = { actorHp: 300 };
    const original = structuredClone({ content, build, context, options });
    freeze(content);
    freeze(build);
    freeze(context);
    freeze(options);
    const details = getGuildBuildDetails(content, build, context, options);
    details.stats.effectiveStats.atk = 0;
    details.skills[0]!.node.prerequisites.push('knight-b1');
    details.skills[0]!.skill.effects.push({
      kind: 'cancel-cast',
      target: 'self',
    });
    details.conditions.actorHp = 0;
    expect({ content, build, context, options }).toEqual(original);
    expect(() =>
      getGuildBuildDetails(content, build, context, { actorHp: 301 }),
    ).toThrow();
  });
});
