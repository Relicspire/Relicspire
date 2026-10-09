import type { ActorSnapshot, BattleParticipant } from '../data/battle';
import type {
  Element,
  EnemyDefinition,
  GameContent,
  SkillDefinition,
  SkillNode,
  SkillNodeId,
  TargetBinding,
  Stats,
} from '../data/model';
import {
  breakAmount,
  damageAmount,
  delayTU,
  healAmount,
  reviveHp,
} from '../battle/calculations';
import { getBuildStats, type BuildStats } from './stats';
import type { FormationContext, PartyBuild } from './types';
import {
  getActiveSkillIds,
  getJobNodes,
  getRemainingSkillPoints,
} from './validation';

/** 1効果の参考対象。全体対象の場合も1人分の性能として照会する。耐性なしならenemyはnull。 */
export interface SkillReferenceTarget {
  participant: Pick<BattleParticipant, 'stats' | 'statuses' | 'action'>;
  enemy: EnemyDefinition | null;
}
/** 参考値に明示的に与える条件。状態なしの現在編成を行動者とし、効果ごとの対象を指定する。 */
export interface SkillReferenceOptions {
  actorHp?: number;
  chosenElement?: Element;
  targets?: Partial<
    Record<Exclude<TargetBinding, 'self'>, SkillReferenceTarget>
  >;
}
/** 未指定条件はnullと要求条件で表し、0ダメージや確定予測と混同しない。 */
export interface SkillEffectReference {
  effectIndex: number;
  kind: SkillDefinition['effects'][number]['kind'];
  hpAmount: number | null;
  breakAmount: number | null;
  missing: ('target' | 'element' | 'actor-hp')[];
}
/** 全ノードの閲覧結果。定義を含め、対象・属性・詠唱・CD・付随効果も参照できる。 */
export interface GuildSkillDetails {
  node: SkillNode;
  skill: SkillDefinition;
  learned: boolean;
  activeCommand: boolean;
  replacedBy: SkillNodeId | null;
  missingPrerequisites: SkillNodeId[];
  remainingPoints: number;
  canLearn: boolean;
  delayReference: number;
  effects: SkillEffectReference[];
}
/** 拠点の能力とスキル性能。条件と対象をコピーして参考値の前提を保持する。 */
export interface GuildBuildDetails {
  stats: BuildStats;
  conditions: SkillReferenceOptions;
  skills: GuildSkillDetails[];
  reference: 'independent-effects-without-actor-statuses';
}

/** 対象やHP条件を仮定せず、独立した1効果の数値を共通計算式から導出する。
 * @param skill 閲覧するスキル定義。
 * @param actor 装備反映後の行動者参考能力。
 * @param options 対象・属性・背水条件。前後の効果や反応はシミュレートしない。
 */
function getEffectReferences(
  skill: SkillDefinition,
  actor: ActorSnapshot,
  stats: Stats,
  options: SkillReferenceOptions,
): SkillEffectReference[] {
  return skill.effects.map((effect, effectIndex) => {
    const result: SkillEffectReference = {
      effectIndex,
      kind: effect.kind,
      hpAmount: null,
      breakAmount: null,
      missing: [],
    };
    const target: SkillReferenceTarget | undefined =
      effect.target === 'self'
        ? {
            participant: {
              stats: { ...stats },
              statuses: [],
              action: { kind: 'ready' },
            },
            enemy: null,
          }
        : options.targets?.[effect.target];
    if (effect.kind === 'heal')
      result.hpAmount = healAmount(effect.power, actor);
    else if (effect.kind === 'revive') {
      if (!target) result.missing.push('target');
      else
        result.hpAmount = reviveHp(
          target.participant.stats.maxHp,
          effect.hpRatio,
        );
    } else if (effect.kind === 'attack' || effect.kind === 'trap') {
      const attack = effect.kind === 'trap' ? effect.attack : effect;
      const element =
        attack.element === 'chosen'
          ? options.chosenElement &&
            skill.elementChoices.includes(options.chosenElement)
            ? options.chosenElement
            : undefined
          : attack.element;
      if (!target) result.missing.push('target');
      if (!element) result.missing.push('element');
      if (typeof attack.power !== 'number' && options.actorHp === undefined)
        result.missing.push('actor-hp');
      if (!result.missing.length && target && element) {
        result.hpAmount = damageAmount(
          attack,
          actor,
          target.participant,
          element,
          target.enemy,
        );
        result.breakAmount = target.enemy
          ? result.hpAmount === 0
            ? 0
            : breakAmount(attack.breakDamage, element, target.enemy)
          : null;
      }
    }
    return result;
  });
}

/** 戦闘を開始せず、選択ジョブの全ノードを現在装備の条件で閲覧する。
 * @param content 検証済みカタログ。
 * @param build 照会する編成。習得・所持数の確定検証は通常の編成APIで行う。
 * @param context 現在の予算と戦闘状態。戦闘中の習得候補は許可しない。
 * @param options 参考対象・属性・背水HP。省略した条件を推測しない。
 */
export function getGuildBuildDetails(
  content: GameContent,
  build: PartyBuild,
  context: FormationContext,
  options: SkillReferenceOptions = {},
): GuildBuildDetails {
  const job = content.jobs.find((j) => j.id === build.jobId);
  if (!job) throw new Error(`Unknown job: ${build.jobId}`);
  const stats = getBuildStats(content, build);
  const values = stats.effectiveStats;
  if (
    options.actorHp !== undefined &&
    (!Number.isSafeInteger(options.actorHp) ||
      options.actorHp < 0 ||
      options.actorHp > values.maxHp)
  )
    throw new Error('Reference HP must be within maximum HP');
  const actor: ActorSnapshot = {
    reference: 'before-activation',
    actorId: build.id,
    atk: values.atk,
    mag: values.mag,
    spd: values.spd,
    hp: options.actorHp ?? values.maxHp,
    maxHp: values.maxHp,
    damageModifier: 10000,
    healingModifier: 10000,
  };
  const nodes = getJobNodes(content, build.jobId);
  const active = getActiveSkillIds(content, build);
  const remainingPoints = getRemainingSkillPoints(content, build, context);
  return {
    stats,
    conditions: structuredClone(options),
    reference: 'independent-effects-without-actor-statuses',
    skills: nodes.map((node) => {
      const skill = content.skills.find((s) => s.id === node.skillId);
      if (!skill) throw new Error(`Unknown skill: ${node.skillId}`);
      const learned = build.learnedSkills.includes(node.id);
      const missingPrerequisites = node.prerequisites.filter(
        (id) => !build.learnedSkills.includes(id),
      );
      const replacement = nodes
        .filter(
          (other) =>
            other.replacementGroup === node.replacementGroup &&
            other.rank > node.rank &&
            build.learnedSkills.includes(other.id),
        )
        .sort((a, b) => b.rank - a.rank)[0];
      return {
        node: structuredClone(node),
        skill: structuredClone(skill),
        learned,
        activeCommand: active.includes(node.skillId),
        replacedBy: replacement?.id ?? null,
        missingPrerequisites,
        remainingPoints,
        canLearn:
          !context.inBattle &&
          !learned &&
          !missingPrerequisites.length &&
          remainingPoints >= node.cost,
        delayReference: delayTU(skill.delay, values.spd),
        effects: getEffectReferences(skill, actor, values, options),
      };
    }),
  };
}
