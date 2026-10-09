import type {
  BattleReward,
  EnemyId,
  EquipmentId,
  FloorId,
  NodeId,
} from '../data/model';
import type { CampaignMetadata, GameRelease } from '../data/release-model';
import {
  getContentAvailability,
  getCampaignSkillPointLimit,
  getCampaignInventory,
} from '../data/campaign';
import { array, choice, id, object } from '../data/schema';
import type { DataIssue } from '../data/validation';
/** 通常の現在地と、戦闘中に保存する探索復帰先。 */
export type ExplorationLocation =
  { kind: 'guild' } | { kind: 'floor'; floorId: FloorId; nodeId: NodeId };
/** 保存対象となる進行。所持数・予算・解放・クリアは重複保存しない。 */
export interface Progression {
  defeatedEnemyIds: EnemyId[];
  visitedFloorIds: FloorId[];
  endingHandled: boolean;
  location: ExplorationLocation;
}
/** 討伐集合から導出する恒久能力。未収録遺物も所持品へ含める。 */
export interface DerivedProgression {
  unlockedFloorIds: FloorId[];
  finalClear: boolean;
  skillPointLimit: number;
  inventory: Map<EquipmentId, number>;
}
/** 遭遇確認の一時情報。進行は親分岐のまま保持する。 */
export interface Encounter {
  enemyId: EnemyId;
  room: Extract<ExplorationLocation, { kind: 'floor' }>;
  parent: Extract<ExplorationLocation, { kind: 'floor' }>;
}
/** 検証・操作結果。不正入力では元の進行を変更しない。 */
export type ProgressionResult<T> =
  { ok: true; value: T } | { ok: false; issues: DataIssue[] };
/** 通常移動と遭遇確認を区別する。保存の確定は呼出元が担当する。 */
export interface ExplorationCandidate {
  progression: Progression;
  encounter: Encounter | null;
  showEntryText: boolean;
}
/** 勝利保存の候補。報酬の追加加算ではなく討伐集合から再導出する。 */
export interface VictoryCandidate {
  progression: Progression;
  derived: DerivedProgression;
  reward: BattleReward;
}
/** 正規の初期進行を生成する。 */
export function createInitialProgression(): Progression {
  return {
    defeatedEnemyIds: [],
    visitedFloorIds: [],
    endingHandled: false,
    location: { kind: 'guild' },
  };
}
/** 討伐集合から各報酬を導出する。事前に進行を検証する。
 * @param campaign 検証済み全編メタデータ。
 * @param progression 正規の討伐集合を含む進行。
 */
export function deriveProgression(
  campaign: CampaignMetadata,
  progression: Pick<Progression, 'defeatedEnemyIds'>,
): DerivedProgression {
  const defeated = new Set(progression.defeatedEnemyIds);
  const enemies = campaign.enemies.filter((e) => defeated.has(e.id));
  const unlocked = new Set<FloorId>(['floor-01']);
  enemies.forEach((e) => {
    if (e.reward.unlockFloorId) unlocked.add(e.reward.unlockFloorId);
  });
  return {
    unlockedFloorIds: campaign.floors
      .filter((f) => unlocked.has(f.id))
      .map((f) => f.id)
      .sort(),
    finalClear: enemies.some((e) => e.reward.finalClear),
    skillPointLimit: getCampaignSkillPointLimit(
      campaign,
      progression.defeatedEnemyIds,
    ),
    inventory: getCampaignInventory(campaign, progression.defeatedEnemyIds),
  };
}
/** 問題を返す共通拒否処理。
 * @param path 問題箇所。
 * @param message 拒否理由。
 */
function reject<T>(path: string, message: string): ProgressionResult<T> {
  return { ok: false, issues: [{ path, message }] };
}
/** 全編のノード接尾辞。未収録階層の保存位置もIDとして検証できる。 */
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
/** 現在地の構造を検証する。
 * @param input 未知の位置候補。
 */
function locationIssues(input: unknown): DataIssue[] {
  const issues: DataIssue[] = [];
  if (
    input &&
    typeof input === 'object' &&
    'kind' in input &&
    input.kind === 'guild'
  )
    object({ kind: choice('guild') })(input, 'location', issues);
  else
    object({
      kind: choice('floor'),
      floorId: id(/^floor-(?:0[1-9]|10)$/),
      nodeId: id(
        /^floor-(?:0[1-9]|10)-(?:entry|hall-[123]|boss|alcove-[1-5])$/,
      ),
    })(input, 'location', issues);
  return issues;
}
/** 保存対象の進行構造。意味検証と重複の正規化で共用する。 */
const progressionSchema = object({
  defeatedEnemyIds: array(
    id(/^(?:boss-(?:0[1-9]|10)|guardian-(?:0[1-9]|10)-0[1-5])$/),
  ),
  visitedFloorIds: array(id(/^floor-(?:0[1-9]|10)$/)),
  endingHandled: choice(true, false),
  location: (v, _p, e) => e.push(...locationIssues(v)),
});
/** 進行JSONの構造・集合・討伐順・復帰先を検証する。収録範囲と正規IDは区別する。
 * @param campaign 検証済み全編メタデータ。
 * @param input 未知の読み込み候補。
 */
export function validateProgression(
  campaign: CampaignMetadata,
  input: unknown,
): DataIssue[] {
  const issues: DataIssue[] = [];
  progressionSchema(input, 'progression', issues);
  if (issues.length) return issues;
  const p = input as Progression;
  const defeated = new Set(p.defeatedEnemyIds);
  const derived = deriveProgression(campaign, p);
  if (defeated.size !== p.defeatedEnemyIds.length)
    issues.push({
      path: 'defeatedEnemyIds',
      message: '討伐IDが重複しています',
    });
  if (new Set(p.visitedFloorIds).size !== p.visitedFloorIds.length)
    issues.push({
      path: 'visitedFloorIds',
      message: '初訪問IDが重複しています',
    });
  for (const enemyId of defeated) {
    const enemy = campaign.enemies.find((e) => e.id === enemyId);
    if (!enemy) {
      issues.push({ path: enemyId, message: '未知の討伐IDです' });
      continue;
    }
    const index = Number(enemy.floorId.slice(-2));
    for (let i = 1; i < index; i++)
      if (!defeated.has(`boss-${String(i).padStart(2, '0')}` as EnemyId)) {
        issues.push({
          path: enemyId,
          message: '先行ボスの討伐がなく、未解放階層の討伐です',
        });
        break;
      }
  }
  for (const floor of p.visitedFloorIds)
    if (!derived.unlockedFloorIds.includes(floor))
      issues.push({
        path: 'visitedFloorIds',
        message: '未知または未解放の初訪問階層です',
      });
  if (p.endingHandled && !derived.finalClear)
    issues.push({
      path: 'endingHandled',
      message: 'クリア前に結末を処理済みにはできません',
    });
  if (p.location.kind === 'floor') {
    const l = p.location;
    if (
      !derived.unlockedFloorIds.includes(l.floorId) ||
      !suffixes.some((s) => l.nodeId === `${l.floorId}-${s}`)
    )
      issues.push({
        path: 'location',
        message: '未解放または所属が不正な復帰先です',
      });
    const enemy = l.nodeId.endsWith('-boss')
      ? `boss-${l.floorId.slice(-2)}`
      : l.nodeId.includes('-alcove-')
        ? `guardian-${l.floorId.slice(-2)}-0${l.nodeId.slice(-1)}`
        : null;
    if (enemy && !defeated.has(enemy as EnemyId))
      issues.push({
        path: 'location',
        message: '生存敵の部屋は通常の復帰先にできません',
      });
  }
  return issues;
}
/** 重複だけを正規化した候補を返す。未知IDや進行の穴は補わない。
 * @param campaign 検証済み全編メタデータ。
 * @param input 読み込み候補。正常化の保存・差分確認は保存層へ委ねる。
 */
export function normalizeProgression(
  campaign: CampaignMetadata,
  input: unknown,
): ProgressionResult<Progression> {
  const structural: DataIssue[] = [];
  progressionSchema(input, 'progression', structural);
  if (structural.length) return { ok: false, issues: structural };
  const next = structuredClone(input) as Progression;
  next.defeatedEnemyIds = [...new Set(next.defeatedEnemyIds)];
  next.visitedFloorIds = [...new Set(next.visitedFloorIds)];
  const issues = validateProgression(campaign, next);
  return issues.length ? { ok: false, issues } : { ok: true, value: next };
}
/** 操作前の検証。未知・未収録の探索復帰先は通常操作では拒否する。
 * @param release 検証済みリリース。
 * @param progression 操作元の進行。
 */
function operationIssues(
  release: GameRelease,
  progression: Progression,
): DataIssue[] {
  const issues = validateProgression(release.campaign, progression);
  if (
    !issues.length &&
    progression.location.kind === 'floor' &&
    getContentAvailability(
      release.campaign,
      release.scope,
      progression.location.floorId,
    ) !== 'playable'
  )
    issues.push({ path: 'location', message: '復帰先がこの版では未収録です' });
  return issues;
}
/** 通常移動候補を生成し、入口の初訪問表示を導出する。
 * @param progression 操作元。
 * @param location 通常移動先。
 */
function candidate(
  progression: Progression,
  location: ExplorationLocation,
): ExplorationCandidate {
  const next = structuredClone(progression);
  next.location = structuredClone(location);
  const showEntryText =
    location.kind === 'floor' &&
    location.nodeId.endsWith('-entry') &&
    !next.visitedFloorIds.includes(location.floorId);
  if (showEntryText && location.kind === 'floor')
    next.visitedFloorIds.push(location.floorId);
  return { progression: next, encounter: null, showEntryText };
}
/** 隣接する部屋を選ぶ。生存敵なら親分岐のまま遭遇確認候補を返す。
 * @param release 検証済みリリース。
 * @param progression 確定済み進行。
 * @param nodeId 同階層の選択先。
 */
export function selectNode(
  release: GameRelease,
  progression: Progression,
  nodeId: NodeId,
): ProgressionResult<ExplorationCandidate> {
  const issues = operationIssues(release, progression);
  if (issues.length) return { ok: false, issues };
  if (progression.location.kind !== 'floor')
    return reject('location', '拠点からはワープしてください');
  const location = progression.location;
  const floor = release.content.floors.find((f) => f.id === location.floorId)!;
  const from = floor.nodes.find((n) => n.id === location.nodeId);
  const room = floor.nodes.find((n) => n.id === nodeId);
  if (!from?.links.includes(nodeId) || !room)
    return reject('nodeId', '同階層の隣接する部屋を選んでください');
  const to: Encounter['room'] = { kind: 'floor', floorId: floor.id, nodeId };
  const enemyId = room.enemies[0];
  if (enemyId && !progression.defeatedEnemyIds.includes(enemyId))
    return {
      ok: true,
      value: {
        progression: structuredClone(progression),
        encounter: { enemyId, room: to, parent: structuredClone(location) },
        showEntryText: false,
      },
    };
  return { ok: true, value: candidate(progression, to) };
}
/** 拠点へ帰還する候補を作る。
 * @param release 検証済みリリース。
 * @param progression 確定済み進行。
 */
export function returnToGuild(
  release: GameRelease,
  progression: Progression,
): ProgressionResult<ExplorationCandidate> {
  const issues = operationIssues(release, progression);
  return issues.length
    ? { ok: false, issues }
    : { ok: true, value: candidate(progression, { kind: 'guild' }) };
}
/** 拠点から解放・収録済み階層の入口へワープする。
 * @param release 検証済みリリース。
 * @param progression 確定済み進行。
 * @param floorId 移動先階層。
 */
export function warpToFloor(
  release: GameRelease,
  progression: Progression,
  floorId: FloorId,
): ProgressionResult<ExplorationCandidate> {
  const issues = operationIssues(release, progression);
  if (issues.length) return { ok: false, issues };
  if (progression.location.kind !== 'guild')
    return reject('location', 'ワープは拠点から行います');
  return enterFloor(release, progression, floorId);
}
/** 解放と収録範囲を検証して入口への候補を作る。
 * @param release 検証済みリリース。
 * @param progression 操作元。
 * @param floorId 入口への移動先。
 */
function enterFloor(
  release: GameRelease,
  progression: Progression,
  floorId: FloorId,
): ProgressionResult<ExplorationCandidate> {
  const availability = getContentAvailability(
    release.campaign,
    release.scope,
    floorId,
  );
  if (availability === 'unknown') return reject('floorId', '未知の階層です');
  if (
    !deriveProgression(release.campaign, progression).unlockedFloorIds.includes(
      floorId,
    )
  )
    return reject('floorId', '未解放の階層です');
  if (availability !== 'playable')
    return reject('floorId', '解放済みですがこの版では未収録です');
  const floor = release.content.floors.find((f) => f.id === floorId)!;
  return {
    ok: true,
    value: candidate(progression, {
      kind: 'floor',
      floorId,
      nodeId: floor.entryNodeId,
    }),
  };
}
/** 討伐済みボスの出口から次階層へ進む。
 * @param release 検証済みリリース。
 * @param progression 確定済み進行。
 */
export function moveToNextFloor(
  release: GameRelease,
  progression: Progression,
): ProgressionResult<ExplorationCandidate> {
  const issues = operationIssues(release, progression);
  if (issues.length) return { ok: false, issues };
  if (
    progression.location.kind !== 'floor' ||
    !progression.location.nodeId.endsWith('-boss')
  )
    return reject('location', '討伐済みボスの出口から進んでください');
  const enemy = release.campaign.enemies.find(
    (e) =>
      e.id ===
      `boss-${progression.location.kind === 'floor' ? progression.location.floorId.slice(-2) : ''}`,
  )!;
  if (!enemy.reward.unlockFloorId)
    return reject('floorId', '最終階層に次階層はありません');
  return enterFloor(release, progression, enemy.reward.unlockFloorId);
}
/** 遭遇候補を再検証する。親分岐・部屋・敵を照合し、改ざんした候補と再戦を拒否する。
 * @param release 検証済みリリース。
 * @param progression 戦闘開始前の確定進行。
 * @param encounter 遭遇確認の候補。
 */
export function validateEncounter(
  release: GameRelease,
  progression: Progression,
  encounter: Encounter,
): DataIssue[] {
  const issues = operationIssues(release, progression);
  if (issues.length) return issues;
  if (
    progression.location.kind !== 'floor' ||
    encounter.parent.kind !== 'floor' ||
    progression.location.floorId !== encounter.parent.floorId ||
    progression.location.nodeId !== encounter.parent.nodeId
  )
    return [
      { path: 'encounter.parent', message: '遭遇前の親分岐が一致しません' },
    ];
  const selected = selectNode(release, progression, encounter.room.nodeId);
  if (!selected.ok) return selected.issues;
  const expected = selected.value.encounter;
  if (
    !expected ||
    expected.enemyId !== encounter.enemyId ||
    expected.room.floorId !== encounter.room.floorId
  )
    return [
      { path: 'encounter', message: '生存敵・部屋・所属階層が一致しません' },
    ];
  return [];
}
/** 回避・敗北・逃走で開始前の親分岐をそのまま返す。
 * @param release 検証済みリリース。
 * @param progression 開始前の確定進行。
 * @param encounter 確認または戦闘中の遭遇情報。
 */
export function leaveEncounter(
  release: GameRelease,
  progression: Progression,
  encounter: Encounter,
): ProgressionResult<Progression> {
  const issues = validateEncounter(release, progression, encounter);
  return issues.length
    ? { ok: false, issues }
    : { ok: true, value: structuredClone(progression) };
}
/** 勝利した敵を照合し、報酬・討伐・復帰先の一括保存候補を生成する。
 * @param release 検証済みリリース。
 * @param preBattle 保存済みの開始前進行。
 * @param encounter 検証対象の遭遇位置。
 * @param enemyId 実際に勝利した戦闘の敵ID。戦闘結果の確認は呼出元が担当する。
 */
export function createVictoryCandidate(
  release: GameRelease,
  preBattle: Progression,
  encounter: Encounter,
  enemyId: EnemyId,
): ProgressionResult<VictoryCandidate> {
  const issues = validateEncounter(release, preBattle, encounter);
  if (issues.length) return { ok: false, issues };
  if (enemyId !== encounter.enemyId)
    return reject('enemyId', '勝利した敵が遭遇と一致しません');
  const reward = release.campaign.enemies.find((e) => e.id === enemyId)!.reward;
  const next = structuredClone(preBattle);
  next.defeatedEnemyIds.push(enemyId);
  next.location = reward.finalClear
    ? { kind: 'guild' }
    : structuredClone(encounter.room);
  if (reward.finalClear) next.endingHandled = false;
  const validation = validateProgression(release.campaign, next);
  if (validation.length) return { ok: false, issues: validation };
  return {
    ok: true,
    value: {
      progression: next,
      derived: deriveProgression(release.campaign, next),
      reward: structuredClone(reward),
    },
  };
}
/** 階層一覧・ヒント・再訪の表示条件。解放と収録を混同しない。
 * @param release 検証済みリリース。
 * @param progression 検証済み進行。
 */
export function getFloorAccess(release: GameRelease, progression: Progression) {
  const unlocked = new Set(
    deriveProgression(release.campaign, progression).unlockedFloorIds,
  );
  return release.campaign.floors.map((f) => ({
    floorId: f.id,
    unlocked: unlocked.has(f.id),
    playable: release.scope.playableFloorIds.includes(f.id),
    canWarp:
      unlocked.has(f.id) &&
      release.scope.playableFloorIds.includes(f.id) &&
      progression.location.kind === 'guild',
    visited: progression.visitedFloorIds.includes(f.id),
    hintsAvailable: unlocked.has(f.id),
    showEntryText:
      unlocked.has(f.id) && !progression.visitedFloorIds.includes(f.id),
  }));
}
