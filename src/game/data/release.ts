import { JOB_IDS, type GameContent, type NodeId } from './model';
import type {
  GameRelease,
  ReleasePresentation,
  ReleaseScope,
  CampaignMetadata,
} from './release-model';
import { validateGameContent, type DataIssue } from './validation';
import { validateCampaignMetadata, sameReward } from './campaign';
import { array, fail, id, integer, object, type Check } from './schema';
import { validateFormation } from '../party/validation';
/** 正式収録で必要な初期装備ID。性能値は正式コンテンツ側が定義する。 */
export const STARTER_IDS = [
  'starter-sword',
  'starter-staff',
  'starter-armor',
  'starter-charm',
  'starter-boots',
  'starter-ring',
] as const;
/** 表示対応を必須にする全属性。 */
export const ELEMENT_IDS = [
  'none',
  'fire',
  'ice',
  'lightning',
  'light',
  'dark',
] as const;
/** 表示対応を必須にする現行状態系統。 */
export const STATUS_IDS = [
  'atk-up',
  'atk-down',
  'mag-up',
  'mag-down',
  'spd-up',
  'spd-down',
  'physical-guard',
  'magic-guard',
  'taunt',
  'cover',
  'time-stop',
  'reflect',
  'counter',
  'follow',
  'poison',
  'self-revive',
] as const;
/** 表示対応を必須にする対象規則。 */
export const TARGET_IDS = [
  'enemy-single',
  'enemy-all',
  'ally-single',
  'ally-other',
  'ally-all',
  'self',
  'dead-ally-other',
  'waiting-ally-other',
] as const;
/** 空白だけの文字列を拒否する表示本文検証。
 * @param value 本文候補。
 * @param path 表示項目のパス。
 * @param issues 問題の追加先。
 */
const text: Check = (value, path, issues) => {
  if (typeof value !== 'string' || !value.trim())
    fail(issues, path, '空でない表示文言が必要です');
};
/** 任意キーの辞書の各値を検証する。
 * @param check 値ごとの検証。未知キーの参照照合は呼び出し側が行う。
 */
const dictionary =
  (check: Check): Check =>
  (value, path, issues) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return fail(issues, path, '表示辞書が必要です');
    for (const [key, item] of Object.entries(value))
      check(item, `${path}.${key}`, issues);
  };
/** 固定キーすべてに表示名を要求し、未知キーを拒否する。
 * @param keys 対応が必要なロジック識別子。
 */
const labels = (keys: readonly string[]) =>
  object(Object.fromEntries(keys.map((key) => [key, text])));
/** 表示データの厳密な構造。 */
const presentationSchema = object({
  entries: dictionary(object({ name: text, description: text })),
  floors: dictionary(
    object({ theme: text, entryText: text, hints: array(text, 1) }),
  ),
  ending: array(text),
  elements: labels(ELEMENT_IDS),
  statuses: labels(STATUS_IDS),
  targets: labels(TARGET_IDS),
});
/** リリースで参照できる表示IDを収集する。
 * @param content 収録実戦データ。
 * @param campaign 未収録も含む全編ID。
 */
function presentationIds(
  content: GameContent,
  campaign: CampaignMetadata,
): Set<string> {
  return new Set([
    ...content.characters.map((x) => x.id),
    ...JOB_IDS,
    ...content.skills.map((x) => x.id),
    ...content.equipment.map((x) => x.id),
    ...STARTER_IDS,
    ...campaign.floors.map((x) => x.id),
    ...campaign.enemies.map((x) => x.id),
    ...campaign.relics.map((x) => x.id),
    ...content.floors.flatMap((f) => f.nodes.map((n) => n.id)),
    'basic-attack',
    'wait',
  ]);
}
/** 表示本文と収録ロジックIDの対応を検証する。
 * @param input 未知の表示データ。
 * @param content 検証済み収録コンテンツ。
 * @param campaign 検証済み全編メタデータ。
 * @param scope 検証済み収録範囲。
 */
export function validatePresentationCatalog(
  input: unknown,
  content: GameContent,
  campaign: CampaignMetadata,
  scope: ReleaseScope,
): DataIssue[] {
  const issues: DataIssue[] = [];
  presentationSchema(input, 'presentation', issues);
  if (issues.length) return issues;
  const p = input as ReleasePresentation;
  const allowed = presentationIds(content, campaign);
  for (const key of Object.keys(p.entries))
    if (!allowed.has(key))
      fail(issues, `presentation.entries.${key}`, 'ロジックIDが存在しません');
  const required = [
    ...content.characters,
    ...content.jobs,
    ...content.skills,
    ...content.equipment,
    ...content.enemies,
    ...content.floors,
    ...content.floors.flatMap((f) => f.nodes),
  ].map((x) => x.id);
  for (const key of [...required, 'basic-attack', 'wait'])
    if (!Object.hasOwn(p.entries, key))
      fail(
        issues,
        `presentation.entries.${key}`,
        '収録IDの名称・説明が欠落しています',
      );
  for (const floor of Object.keys(p.floors))
    if (!campaign.floors.some((f) => f.id === floor))
      fail(issues, `presentation.floors.${floor}`, '未知の階層です');
  for (const floor of scope.playableFloorIds)
    if (!Object.hasOwn(p.floors, floor))
      fail(
        issues,
        `presentation.floors.${floor}`,
        '収録階層の入口文・テーマ・ヒントが欠落しています',
      );
  if (scope.playableFloorIds.includes('floor-10') && !p.ending.length)
    fail(issues, 'presentation.ending', '最終階層収録時は結末本文が必要です');
  return issues;
}
/** 表示データを検証し独立コピーを返す。
 * @param input 未知の表示データ。
 * @param content 検証済み実戦コンテンツ。
 * @param campaign 検証済み全編メタデータ。
 * @param scope 検証済み収録範囲。
 */
export function parsePresentationCatalog(
  input: unknown,
  content: GameContent,
  campaign: CampaignMetadata,
  scope: ReleaseScope,
): ReleasePresentation {
  const issues = validatePresentationCatalog(input, content, campaign, scope);
  throwIssues(issues);
  return structuredClone(input) as ReleasePresentation;
}
/** 収録範囲の構造と重複を検証する。
 * @param input 未知の収録範囲。
 */
export function validateReleaseScope(input: unknown): DataIssue[] {
  const issues: DataIssue[] = [];
  object({ playableFloorIds: array(id(/^floor-(?:0[1-9]|10)$/), 1, 10) })(
    input,
    'scope',
    issues,
  );
  if (issues.length) return issues;
  const scope = input as ReleaseScope;
  if (new Set(scope.playableFloorIds).size !== scope.playableFloorIds.length)
    fail(issues, 'scope.playableFloorIds', '収録階層が重複しています');
  // 初期階層から順に収録し、途中の未収録階層による進行不能を防ぐ。
  const sorted = [...scope.playableFloorIds].sort();
  sorted.forEach((f, i) => {
    if (f !== `floor-${String(i + 1).padStart(2, '0')}`)
      fail(
        issues,
        'scope.playableFloorIds',
        '第1階層から連続して収録してください',
      );
  });
  return issues;
}
/** 収録集合の欠落・余分・重複を照合する。
 * @param actual 収録されたID一覧。
 * @param expected 収録範囲から要求するID一覧。
 * @param path 問題箇所。
 * @param issues 問題の追加先。
 */
function exactIds(
  actual: readonly string[],
  expected: readonly string[],
  path: string,
  issues: DataIssue[],
) {
  const ids = new Set(actual);
  if (ids.size !== actual.length) fail(issues, path, 'IDが重複しています');
  for (const id of expected)
    if (!ids.has(id)) fail(issues, path, `収録IDが欠落しています: ${id}`);
  for (const id of ids)
    if (!expected.includes(id)) fail(issues, path, `収録範囲外のIDです: ${id}`);
}
/** 固定ノードと遭遇配置・到達可能性・守護者回避を検証する。
 * @param content 参照整合性検証済みの探索データ。
 * @param issues 問題の追加先。
 */
function validateMaps(content: GameContent, issues: DataIssue[]) {
  for (const f of content.floors) {
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
    exactIds(
      f.nodes.map((n) => n.id),
      suffixes.map((s) => `${f.id}-${s}`),
      f.id,
      issues,
    );
    if (f.entryNodeId !== `${f.id}-entry`)
      fail(issues, f.id, '入口IDが不正です');
    const visited = new Set<NodeId>();
    const queue = [f.entryNodeId];
    while (queue.length) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      queue.push(...(f.nodes.find((n) => n.id === id)?.links ?? []));
    }
    if (f.nodes.some((n) => !visited.has(n.id)))
      fail(issues, f.id, '入口から到達できないノードがあります');
    const main = ['entry', 'hall-1', 'hall-2', 'hall-3', 'boss'].map(
      (s) => `${f.id}-${s}`,
    );
    main.slice(0, -1).forEach((id, i) => {
      if (
        !f.nodes.find((n) => n.id === id)?.links.includes(main[i + 1] as NodeId)
      )
        fail(issues, f.id, '守護者を回避できる主経路が欠落しています');
    });
    for (const n of f.nodes) {
      const number = f.id.slice(-2);
      const alcove = n.id.match(/-alcove-([1-5])$/)?.[1];
      const expected = n.id.endsWith('-boss')
        ? [`boss-${number}`]
        : alcove
          ? [`guardian-${number}-0${alcove}`]
          : [];
      exactIds(n.enemies, expected, n.id, issues);
      if (alcove) {
        const parent = `${f.id}-hall-${Number(alcove) <= 2 ? 1 : Number(alcove) <= 4 ? 2 : 3}`;
        if (n.links.length !== 1 || n.links[0] !== parent)
          fail(
            issues,
            n.id,
            '守護者の部屋は指定の親分岐だけへ接続してください',
          );
      }
    }
  }
}
/** 正式収録コンテンツの網羅性・全編メタデータとの一致を検証する。
 * @param input 型未確認の実戦データ。部分カタログ検証とは別の厳密な入口。
 * @param campaign 検証済み全編メタデータ。
 * @param scope 検証済み収録範囲。
 */
export function validateReleasedContent(
  input: unknown,
  campaign: CampaignMetadata,
  scope: ReleaseScope,
): DataIssue[] {
  const issues = [
    ...validateCampaignMetadata(campaign),
    ...validateReleaseScope(scope),
  ];
  if (issues.length) return issues;
  issues.push(...validateGameContent(input, campaign));
  if (issues.length) return issues;
  const c = input as GameContent;
  exactIds(
    c.characters.map((x) => x.id),
    ['party-1', 'party-2', 'party-3'],
    'characters',
    issues,
  );
  exactIds(
    c.jobs.map((x) => x.id),
    JOB_IDS,
    'jobs',
    issues,
  );
  for (const j of c.jobs)
    for (const route of ['a', 'b'] as const) {
      exactIds(
        j.routes[route].map((n) => n.id),
        [1, 2, 3].map((rank) => `${j.id}-${route}${rank}`),
        j.id,
        issues,
      );
      for (const n of j.routes[route])
        exactIds(
          n.prerequisites,
          n.rank === 1 ? [] : [`${j.id}-${route}${n.rank - 1}`],
          n.id,
          issues,
        );
    }
  exactIds(
    c.floors.map((x) => x.id),
    scope.playableFloorIds,
    'floors',
    issues,
  );
  const enemies = campaign.enemies.filter((e) =>
    scope.playableFloorIds.includes(e.floorId),
  );
  exactIds(
    c.enemies.map((x) => x.id),
    enemies.map((e) => e.id),
    'enemies',
    issues,
  );
  const relics = campaign.relics.filter((e) =>
    scope.playableFloorIds.includes(e.floorId),
  );
  exactIds(
    c.equipment.map((x) => x.id),
    [...STARTER_IDS, ...relics.map((e) => e.id)],
    'equipment',
    issues,
  );
  for (const enemy of c.enemies) {
    const meta = campaign.enemies.find((e) => e.id === enemy.id)!;
    if (!sameReward(enemy.reward, meta.reward))
      fail(issues, enemy.id, '実戦報酬が全編メタデータと一致しません');
  }
  for (const s of c.skills)
    if (s.id.startsWith('boss-') || s.id.startsWith('guardian-')) {
      if (!c.enemies.some((e) => s.id.startsWith(`${e.id}-s`)))
        fail(issues, s.id, '未収録の敵スキルです');
    }
  const initial = c.characters.map((x) => ({
    id: x.id,
    jobId: x.initialJob,
    learnedSkills: x.initialSkills,
    equipment: x.initialEquipment,
  }));
  issues.push(
    ...validateFormation(c, initial, { defeatedEnemyIds: [], inBattle: false }),
  );
  validateMaps(c, issues);
  return issues;
}
/** 問題一覧をパス付き例外として読み込み元へ通知する。
 * @param issues 検証で得た問題。
 */
function throwIssues(issues: DataIssue[]) {
  if (issues.length)
    throw new Error(issues.map((i) => `${i.path}: ${i.message}`).join('\n'));
}
/** リリースの構造・版・メタデータ・収録・表示をまとめて検証する。
 * @param input 未知のリリースJSON。
 */
export function validateGameRelease(input: unknown): DataIssue[] {
  const issues: DataIssue[] = [];
  object({
    contentVersion: integer(1),
    campaign: validateUnknownCampaign,
    scope: validateUnknownScope,
    content: choicePlaceholder,
    presentation: choicePlaceholder,
  })(input, 'release', issues);
  if (issues.length) return issues;
  const r = input as GameRelease;
  issues.push(...validateReleasedContent(r.content, r.campaign, r.scope));
  if (issues.length) return issues;
  issues.push(
    ...validatePresentationCatalog(
      r.presentation,
      r.content,
      r.campaign,
      r.scope,
    ),
  );
  return issues;
}
/** 外側では存在だけ確認し、下位の専用検証へ委ねる。 */
const choicePlaceholder: Check = (v, p, e) => {
  if (v === undefined) fail(e, p, '必須項目が欠落しています');
};
/** 全編メタデータの検証を外側スキーマへ接続する。 */
const validateUnknownCampaign: Check = (v, _p, e) =>
  e.push(...validateCampaignMetadata(v));
/** 収録範囲の検証を外側スキーマへ接続する。 */
const validateUnknownScope: Check = (v, _p, e) =>
  e.push(...validateReleaseScope(v));
/** リリースを検証して全体の独立コピーを返す。
 * @param input 未知のリリースJSON。不正ならパス付き例外。
 */
export function parseGameRelease(input: unknown): GameRelease {
  const issues = validateGameRelease(input);
  throwIssues(issues);
  return structuredClone(input) as GameRelease;
}

export type * from './release-model';
export {
  createCampaignMetadata,
  getContentAvailability,
  parseCampaignMetadata,
  validateCampaignMetadata,
} from './campaign';
