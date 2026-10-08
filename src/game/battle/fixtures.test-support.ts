/** テスト専用の合成カタログ。正式コンテンツは後続タスクで用意する。 */
import {
  JOB_IDS,
  type AttackPayload,
  type EnemyDefinition,
  type GameContent,
  type JobId,
  type SkillDefinition,
  type SkillId,
  type SkillNode,
  type SkillNodeId,
  type Stats,
} from '../data/model';
import { createBattle } from './index';
import type { BattleSession, BattleSetup } from './types';
/** 戦闘テスト用の共通基礎能力。正式コンテンツの値ではない。 */
export const STATS: Stats = {
  maxHp: 300,
  atk: 40,
  mag: 40,
  def: 10,
  mdef: 10,
  spd: 100,
};
/**
 * テスト用の有効な1ヒット攻撃性能を生成する。
 *
 * @param overrides 既定のテストデータから上書きする項目。
 */
export function attackPayload(
  overrides: Partial<AttackPayload> = {},
): AttackPayload {
  return {
    damageType: 'physical',
    element: 'none',
    power: 100,
    breakDamage: 5,
    hits: 1,
    actorReference: 'before-activation',
    targetReference: 'before-effect',
    ...overrides,
  };
}
/**
 * テスト用スキルを生成する。共有CDはランク1・2、敵スキルはCD0とする。
 *
 * @param id 生成するテストスキルID。
 * @param overrides 既定のテストデータから上書きする項目。
 */
export function skill(
  id: SkillId,
  overrides: Partial<SkillDefinition> = {},
): SkillDefinition {
  return {
    id,
    target: 'self',
    castTime: 0,
    delay: 90,
    cooldown: id.startsWith('boss') ? 0 : 120,
    cooldownId:
      !id.startsWith('boss') && (id.endsWith('1') || id.endsWith('2'))
        ? (id.slice(0, -1) as SkillDefinition['cooldownId'])
        : id,
    actorSnapshot: 'before-activation',
    targetSnapshot: 'before-activation',
    elementChoices: [],
    effects: [],
    ...overrides,
  };
}
/**
 * 合成コンテンツと確定編成からテスト用戦闘を開始する。正式コンテンツの代用にはしない。
 *
 * @param options ジョブ3枠・スキル・敵性能・味方基礎能力などの上書き設定。
 */
export function fixture(
  options: {
    jobs?: [JobId, JobId, JobId];
    skills?: SkillDefinition[];
    enemy?: Partial<EnemyDefinition>;
    partyStats?: Partial<Stats>;
    enemyStats?: Partial<Stats>;
  } = {},
): BattleSession {
  const jobs = options.jobs ?? ['knight', 'wizard', 'cleric'];
  const definitions: GameContent['jobs'] = JOB_IDS.map((id) => {
    /**
     * テスト用ジョブの3ノード直列ルートを生成する。
     *
     * @param r 生成するテスト用スキルルート（aまたはb）。
     */
    const route = (r: 'a' | 'b'): SkillNode[] =>
      ([1, 2, 3] as const).map((rank) => {
        const nodeId: SkillNodeId = `${id}-${r}${rank}`;
        return {
          id: nodeId,
          skillId: nodeId,
          cost: rank,
          rank,
          prerequisites: rank === 1 ? [] : [`${id}-${r}${rank === 2 ? 1 : 2}`],
          replacementGroup: rank === 3 ? nodeId : `${id}-${r}`,
        };
      });
    return { id, routes: { a: route('a'), b: route('b') } };
  });
  const skills = definitions.flatMap((j) =>
    [...j.routes.a, ...j.routes.b].map((n) => skill(n.id)),
  );
  skills.push(
    skill('boss-01-s1', {
      target: 'enemy-single',
      delay: 100,
      cooldownId: 'boss-01-s1',
      effects: [
        {
          ...attackPayload(),
          kind: 'attack',
          target: 'selected',
          attached: [],
        },
      ],
    }),
  );
  for (const s of options.skills ?? []) {
    const index = skills.findIndex((old) => old.id === s.id);
    if (index === -1) skills.push(s);
    else skills[index] = s;
  }
  const characters: GameContent['characters'] = ([1, 2, 3] as const).map(
    (n) => ({
      id: `party-${n}`,
      baseStats: { ...STATS, ...options.partyStats },
      initialJob: jobs[n - 1]!,
      initialSkills: [],
      initialEquipment: [null, null, null, null, null, null],
    }),
  );
  const content: GameContent = {
    characters,
    jobs: definitions,
    skills,
    equipment: [],
    floors: [],
    enemies: [
      {
        id: 'boss-01',
        stats: { ...STATS, maxHp: 10000, spd: 80, ...options.enemyStats },
        maxBreakGauge: 500,
        weakness: 'lightning',
        resistance: 'fire',
        breakResistance: 0,
        knockbackResistance: 0,
        cancelImmune: false,
        timeStopImmune: false,
        phases: [
          {
            id: 'phase-1',
            hpThreshold: 10000,
            actions: [{ skillId: 'boss-01-s1', selection: 'lowest-hp' }],
          },
        ],
        reward: {
          skillPointsPerCharacter: 0,
          equipment: [],
          unlockFloorId: null,
          finalClear: false,
        },
        ...options.enemy,
      },
    ],
  };
  const setup: BattleSetup = {
    party: characters.map((c, index) => {
      const j = definitions.find((j) => j.id === jobs[index])!;
      return {
        id: c.id,
        jobId: j.id,
        learnedSkills: [...j.routes.a, ...j.routes.b].map((n) => n.id),
        equipment: c.initialEquipment,
      };
    }) as BattleSetup['party'],
    enemyId: 'boss-01',
    context: {
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
      ],
      inBattle: false,
    },
  };
  return createBattle(content, setup);
}
