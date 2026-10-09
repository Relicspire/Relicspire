import { fixture, skill } from '../battle/fixtures.test-support';
import { createCampaignMetadata } from './campaign';
import { ELEMENT_IDS, STATUS_IDS, TARGET_IDS, STARTER_IDS } from './release';
import type { GameRelease, ReleasePresentation } from './release-model';
import type { NodeId, EquipmentSlots } from './model';
/** 指定階層数の合成リリース。正式な戦闘性能・文言の制作とは区別する。
 * @param count 第1階層から連続して収録する階層数。
 */
export function releaseFixture(count = 1): GameRelease {
  const content = fixture().content;
  const campaign = createCampaignMetadata();
  const scope = {
    playableFloorIds: campaign.floors.slice(0, count).map((f) => f.id),
  };
  content.equipment = STARTER_IDS.map((id) => ({
    id,
    kind: 'starter',
    maxOwned: 3,
    stats: {},
  }));
  const relics = campaign.relics.filter((r) =>
    scope.playableFloorIds.includes(r.floorId),
  );
  content.equipment.push(
    ...relics.map((r) => ({
      id: r.id,
      kind: 'relic' as const,
      maxOwned: r.maxOwned,
      sourceEnemyId: r.sourceEnemyId,
      stats: {},
    })),
  );
  content.characters.forEach((c) => {
    c.initialSkills = [`${c.initialJob}-a1`, `${c.initialJob}-a2`];
    c.initialEquipment = [...STARTER_IDS] as EquipmentSlots;
  });
  const template = content.enemies[0]!;
  content.skills = content.skills.filter((s) => !s.id.startsWith('boss-'));
  content.enemies = campaign.enemies
    .filter((e) => scope.playableFloorIds.includes(e.floorId))
    .map((e) => {
      const id = `${e.id}-s1` as const;
      content.skills.push(
        skill(id, { target: 'self', cooldown: 0, cooldownId: id }),
      );
      return {
        ...structuredClone(template),
        id: e.id,
        reward: structuredClone(e.reward),
        phases: [
          {
            id: 'phase-1',
            hpThreshold: 10000,
            actions: [{ skillId: id, selection: 'self' as const }],
          },
        ],
      };
    });
  content.floors = scope.playableFloorIds.map((id) => {
    const suffixes = [
      'entry',
      'hall-1',
      'hall-2',
      'hall-3',
      'boss',
      'alcove-1',
      'alcove-2',
      'alcove-3',
      'alcove-4',
      'alcove-5',
    ];
    const edges: [string, string][] = [
      ['entry', 'hall-1'],
      ['hall-1', 'hall-2'],
      ['hall-2', 'hall-3'],
      ['hall-3', 'boss'],
      ['hall-1', 'alcove-1'],
      ['hall-1', 'alcove-2'],
      ['hall-2', 'alcove-3'],
      ['hall-2', 'alcove-4'],
      ['hall-3', 'alcove-5'],
    ];
    return {
      id,
      entryNodeId: `${id}-entry`,
      nodes: suffixes.map((s) => ({
        id: `${id}-${s}` as NodeId,
        links: edges
          .filter((edge) => edge.includes(s))
          .map((edge) => `${id}-${edge.find((x) => x !== s)}` as NodeId),
        enemies:
          s === 'boss'
            ? [`boss-${id.slice(-2)}`]
            : s.startsWith('alcove-')
              ? [`guardian-${id.slice(-2)}-0${s.slice(-1)}`]
              : [],
      })),
    } as (typeof content.floors)[number];
  });
  const ids = [
    ...content.characters,
    ...content.jobs,
    ...content.skills,
    ...content.equipment,
    ...content.enemies,
    ...content.floors,
    ...content.floors.flatMap((f) => f.nodes),
  ].map((x) => x.id);
  const presentation: ReleasePresentation = {
    entries: Object.fromEntries(
      [...ids, 'basic-attack', 'wait'].map((id) => [
        id,
        { name: `名称 ${id}`, description: `説明 ${id}` },
      ]),
    ),
    floors: Object.fromEntries(
      scope.playableFloorIds.map((id) => [
        id,
        { theme: '合成階層', entryText: '入口文', hints: ['攻略ヒント'] },
      ]),
    ),
    ending: count === 10 ? ['結末本文'] : [],
    elements: Object.fromEntries(
      ELEMENT_IDS.map((id) => [id, '属性名']),
    ) as ReleasePresentation['elements'],
    statuses: Object.fromEntries(
      STATUS_IDS.map((id) => [id, '状態名']),
    ) as ReleasePresentation['statuses'],
    targets: Object.fromEntries(
      TARGET_IDS.map((id) => [id, '対象名']),
    ) as ReleasePresentation['targets'],
  };
  return { contentVersion: 1, campaign, scope, content, presentation };
}
