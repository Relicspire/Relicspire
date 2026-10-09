import { describe, expect, it } from 'vitest';
import { fixture, skill } from '../battle/fixtures.test-support';
import { createBattle } from '../battle';
import { createInitialFormation } from '../party';
import {
  createCampaignMetadata,
  getContentAvailability,
  parseCampaignMetadata,
  validateCampaignMetadata,
} from './campaign';
import {
  ELEMENT_IDS,
  STATUS_IDS,
  TARGET_IDS,
  STARTER_IDS,
  parseGameRelease,
  validateGameRelease,
  validateReleasedContent,
  validatePresentationCatalog,
  validateReleaseScope,
  parsePresentationCatalog,
} from './release';
import type { GameRelease, ReleasePresentation } from './release-model';
import type { NodeId, EquipmentSlots } from './model';
import { parseGameContent, validateGameContent } from './validation';

/** 指定階層数の合成リリース。正式な戦闘性能・文言の制作とは区別する。
 * @param count 第1階層から連続して収録する階層数。
 */
function releaseFixture(count = 1): GameRelease {
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
/** 検証された問題を結合する。
 * @param release 検証するリリース候補。
 */
const messages = (release: unknown) =>
  validateGameRelease(release)
    .map((i) => `${i.path}: ${i.message}`)
    .join('\n');

describe('全編進行メタデータと収録範囲', () => {
  it('全10階層・60敵・50遺物の固定報酬を能力値なしで生成する', () => {
    const meta = createCampaignMetadata();
    expect(validateCampaignMetadata(meta)).toEqual([]);
    expect([
      meta.floors.length,
      meta.enemies.length,
      meta.relics.length,
    ]).toEqual([10, 60, 50]);
    expect(meta.enemies.find((e) => e.id === 'boss-09')!.reward).toEqual({
      skillPointsPerCharacter: 1,
      equipment: [],
      unlockFloorId: 'floor-10',
      finalClear: false,
    });
    expect(meta.enemies.find((e) => e.id === 'boss-10')!.reward).toEqual({
      skillPointsPerCharacter: 0,
      equipment: [],
      unlockFloorId: null,
      finalClear: true,
    });
    const clone = parseCampaignMetadata(meta);
    clone.enemies[0]!.reward.finalClear = true;
    expect(meta.enemies[0]!.reward.finalClear).toBe(false);
  });
  it.each(['floors', 'enemies', 'relics'] as const)(
    '%sの欠落・重複を拒否する',
    (key) => {
      const missing = createCampaignMetadata();
      missing[key].pop();
      expect(validateCampaignMetadata(missing).length).toBeGreaterThan(0);
      const duplicate = createCampaignMetadata();
      duplicate[key].push(duplicate[key][0]! as never);
      expect(validateCampaignMetadata(duplicate).length).toBeGreaterThan(0);
    },
  );
  it('誤った所属・報酬・遺物入手元を拒否する', () => {
    const meta = createCampaignMetadata();
    meta.enemies[0]!.reward.skillPointsPerCharacter = 2;
    meta.enemies[1]!.floorId = 'floor-02';
    meta.relics[0]!.sourceEnemyId = 'guardian-01-02';
    expect(validateCampaignMetadata(meta)).toHaveLength(3);
    expect(() => parseCampaignMetadata(meta)).toThrow();
  });
  it.each([
    null,
    {},
    { ...createCampaignMetadata(), extra: true },
    { ...createCampaignMetadata(), enemies: [null] },
  ])('未知JSONの不正構造を例外なく検出する', (input) => {
    expect(validateCampaignMetadata(input).length).toBeGreaterThan(0);
  });
  it('MVPでも全編のIDを保持し、未知と既知未収録を区別する', () => {
    const r = parseGameRelease(releaseFixture());
    expect(r.content.floors).toHaveLength(1);
    expect(r.campaign.floors).toHaveLength(10);
    expect(r.content.enemies[0]!.reward.unlockFloorId).toBe('floor-02');
    expect(getContentAvailability(r.campaign, r.scope, 'floor-01')).toBe(
      'playable',
    );
    expect(getContentAvailability(r.campaign, r.scope, 'boss-01')).toBe(
      'playable',
    );
    expect(getContentAvailability(r.campaign, r.scope, 'floor-02')).toBe(
      'unavailable',
    );
    expect(getContentAvailability(r.campaign, r.scope, 'guardian-10-05')).toBe(
      'unavailable',
    );
    expect(getContentAvailability(r.campaign, r.scope, 'floor-11')).toBe(
      'unknown',
    );
    const full = parseGameRelease(releaseFixture(10));
    expect(full.campaign).toEqual(r.campaign);
    expect(full.content.enemies).toHaveLength(60);
    expect(
      full.content.equipment.filter((e) => e.kind === 'relic'),
    ).toHaveLength(50);
  });
  it('MVP実戦データはメタデータ付きで検証し、実際の戦闘も開始できる', () => {
    const r = releaseFixture();
    expect(validateGameContent(r.content).length).toBeGreaterThan(0);
    expect(validateGameContent(r.content, r.campaign)).toEqual([]);
    expect(parseGameContent(r.content, r.campaign)).toEqual(r.content);
    const initial = createInitialFormation(r.content, {
      defeatedEnemyIds: [],
      inBattle: false,
    });
    if (!initial.ok) throw new Error('初期編成が不正です');
    const s = createBattle(r.content, {
      party: initial.value.party,
      enemyId: 'boss-01',
      campaign: r.campaign,
    });
    expect(s.state.result).toBe('ongoing');
    expect(s.content.floors).toHaveLength(1);
    expect(() =>
      createBattle(r.content, {
        party: initial.value.party,
        enemyId: 'boss-02',
        campaign: r.campaign,
      }),
    ).toThrow();
  });
  it.each([
    null,
    {},
    { playableFloorIds: [] },
    { playableFloorIds: ['floor-01', 'floor-01'] },
    { playableFloorIds: ['floor-02'] },
    { playableFloorIds: ['floor-01', 'floor-03'] },
  ])('不正な収録範囲を拒否する', (scope) => {
    expect(validateReleaseScope(scope).length).toBeGreaterThan(0);
  });
});

describe('正式リリースの網羅性・配置・表示検証', () => {
  it('部分カタログを受け入れる既存入口と正式入口を分ける', () => {
    const partial = fixture().content;
    expect(validateGameContent(partial)).toEqual([]);
    const r = releaseFixture();
    expect(
      validateReleasedContent(partial, r.campaign, r.scope).length,
    ).toBeGreaterThan(0);
  });
  it.each(['characters', 'jobs', 'equipment', 'enemies', 'floors'] as const)(
    '収録必須の%sが欠落したリリースを拒否する',
    (key) => {
      const r = releaseFixture();
      r.content[key].pop();
      expect(validateGameRelease(r).length).toBeGreaterThan(0);
    },
  );
  it('全48ノード・所定の前提・初期編成予算を検証する', () => {
    const r = releaseFixture();
    r.content.jobs[0]!.routes.a.pop();
    expect(validateGameRelease(r).length).toBeGreaterThan(0);
    const prerequisites = releaseFixture();
    prerequisites.content.jobs[0]!.routes.a[1]!.prerequisites = [];
    expect(messages(prerequisites)).toContain('収録IDが欠落');
    const budget = releaseFixture();
    budget.content.characters[0]!.initialSkills.push('knight-a3');
    expect(messages(budget)).toContain('上限3');
  });
  it('実戦報酬が全編メタデータと食い違う場合は拒否する', () => {
    const r = releaseFixture();
    r.content.enemies[0]!.reward.unlockFloorId = 'floor-03';
    expect(messages(r)).toContain('Battle reward differs');
  });
  it('双方向参照が正しくても入口から到達不能な部屋を拒否する', () => {
    const r = releaseFixture();
    const nodes = r.content.floors[0]!.nodes;
    nodes.forEach((n) => {
      n.links = n.links.filter((id) => !id.endsWith('alcove-1'));
    });
    nodes.find((n) => n.id.endsWith('alcove-1'))!.links = [];
    expect(messages(r)).toContain('到達できない');
  });
  it('守護者経由でボスに到達できても主経路欠落を拒否する', () => {
    const r = releaseFixture();
    const nodes = r.content.floors[0]!.nodes;
    const a = nodes.find((n) => n.id.endsWith('hall-2'))!;
    const b = nodes.find((n) => n.id.endsWith('hall-3'))!;
    const guardian = nodes.find((n) => n.id.endsWith('alcove-3'))!;
    a.links = a.links.filter((id) => id !== b.id);
    b.links = b.links.filter((id) => id !== a.id);
    guardian.links.push(b.id);
    b.links.push(guardian.id);
    expect(messages(r)).toContain('主経路');
  });
  it('同階層内でも守護者とボスの部屋配置を入れ替えたら拒否する', () => {
    const r = releaseFixture();
    const nodes = r.content.floors[0]!.nodes;
    const a = nodes.find((n) => n.id.endsWith('boss'))!;
    const b = nodes.find((n) => n.id.endsWith('alcove-1'))!;
    [a.enemies, b.enemies] = [b.enemies, a.enemies];
    expect(messages(r)).toContain('収録ID');
  });
  it.each(['elements', 'statuses', 'targets'] as const)(
    '%sの表示対応の欠落と空文字を拒否する',
    (key) => {
      const r = releaseFixture();
      const labels = r.presentation[key] as Record<string, string>;
      delete labels[Object.keys(labels)[0]!];
      expect(messages(r)).toContain('表示文言');
      const empty = releaseFixture();
      (empty.presentation[key] as Record<string, string>)[
        Object.keys(empty.presentation[key])[0]!
      ] = '  ';
      expect(messages(empty)).toContain('表示文言');
    },
  );
  it('収録IDの名称・説明・入口文・ヒント欠落と未知表示IDを拒否する', () => {
    const r = releaseFixture();
    delete r.presentation.entries['wait'];
    r.presentation.entries['unknown'] = { name: '不明', description: '説明' };
    delete r.presentation.floors['floor-01'];
    const issues = validatePresentationCatalog(
      r.presentation,
      r.content,
      r.campaign,
      r.scope,
    );
    expect(issues).toHaveLength(3);
    const empty = releaseFixture();
    empty.presentation.floors['floor-01']!.hints = [];
    expect(messages(empty)).toContain('hints');
  });
  it('MVPは結末未収録を許可し、最終階層の収録時は結末本文を必須とする', () => {
    expect(validateGameRelease(releaseFixture())).toEqual([]);
    const full = releaseFixture(10);
    full.presentation.ending = [];
    expect(messages(full)).toContain('結末');
  });
  it('版・未知キー・不正構造を拒否し、解析結果を入力と独立させる', () => {
    const r = releaseFixture();
    const parsed = parseGameRelease(r);
    parsed.content.enemies[0]!.stats.atk = 999;
    expect(r.content.enemies[0]!.stats.atk).not.toBe(999);
    const p = parsePresentationCatalog(
      r.presentation,
      r.content,
      r.campaign,
      r.scope,
    );
    p.entries['wait']!.name = '変更';
    expect(r.presentation.entries['wait']!.name).not.toBe('変更');
    for (const raw of [
      null,
      {},
      { ...r, contentVersion: 0 },
      { ...r, extra: true },
      { ...r, presentation: null },
    ]) {
      expect(validateGameRelease(raw).length).toBeGreaterThan(0);
      expect(() => parseGameRelease(raw)).toThrow();
    }
  });
});
