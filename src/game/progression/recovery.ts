import type { EnemyId, FloorId, NodeId } from '../data/model';
import type { CampaignMetadata, GameRelease } from '../data/release-model';
import { array, bool, choice, id, object } from '../data/schema';
import type { DataIssue } from '../data/validation';
import {
  deriveProgression,
  validateProgression,
  type DerivedProgression,
  type Progression,
  type ProgressionResult,
} from './index';

/** 保存層が版に応じて選ぶ明示対応表。一段だけ適用し、継承キーを参照しない。 */
export interface ProgressionIdMigration {
  enemies?: Record<string, EnemyId>;
  floors?: Record<string, FloorId>;
  nodes?: Record<string, NodeId>;
}
/** 原本と候補を比較する復旧差分。集合・位置も切り詰めずコピーして返す。 */
export interface ProgressionRecoveryChange {
  path: string;
  before: unknown;
  after: unknown;
  reason:
    | 'id-migration'
    | 'duplicate'
    | 'invalid-visit'
    | 'invalid-location'
    | 'ending-before-clear';
}
/** 構造が読めても修復できない進行は候補を保持して適用を拒否する。 */
export interface ProgressionRecovery {
  original: unknown;
  progression: Progression;
  changes: ProgressionRecoveryChange[];
  issues: (DataIssue & { code: 'unknown-defeat' | 'invalid-progression' })[];
  canApply: boolean;
  derived: DerivedProgression | null;
  /** 正当な未収録復帰先は保持する。UIは再開せず、収録版への切替などを案内する。 */
  unavailableLocation: FloorId | null;
  /** 収録範囲を確認した再開可否。メタデータだけの移行APIでは未確認のnull。 */
  canResume: boolean | null;
}
/** 旧IDも読み取るため、構造段階では文字列だけを要求する。正規IDは移行後に検証する。 */
const stringId = id(/^[\s\S]*$/);
/** 討伐・訪問・結末・位置の構造を確認し、欠落や型破損を自動解釈しない。 */
const recoverySchema = object({
  defeatedEnemyIds: array(stringId),
  visitedFloorIds: array(stringId),
  endingHandled: bool,
  location: (v, p, e) => {
    if (v && typeof v === 'object' && 'kind' in v && v.kind === 'guild')
      object({ kind: choice('guild') })(v, p, e);
    else
      object({ kind: choice('floor'), floorId: stringId, nodeId: stringId })(
        v,
        p,
        e,
      );
  },
});
/** 対応表の自身のキーだけを一段変換する。
 * @param table 版ごとの明示対応表。
 * @param value 元のID。
 */
function mapped<T extends string>(
  table: Record<string, T> | undefined,
  value: T,
): T {
  return table && Object.hasOwn(table, value) ? table[value]! : value;
}
/** 差分を独立コピーで追加する。
 * @param changes 差分の出力先。
 * @param path 修復した項目。
 * @param before 修復前の値。
 * @param after 修復後の値。
 * @param reason 修復の種類。
 */
function change(
  changes: ProgressionRecoveryChange[],
  path: string,
  before: unknown,
  after: unknown,
  reason: ProgressionRecoveryChange['reason'],
): void {
  if (JSON.stringify(before) !== JSON.stringify(after))
    changes.push({
      path,
      before: structuredClone(before),
      after: structuredClone(after),
      reason,
    });
}
/** 読める構造に明示ID移行だけを適用する。修復・報酬導出は後段で行う。
 * @param input 未知のセーブ進行。
 * @param migration 保存層が選択した対応表。
 */
function migrate(
  input: unknown,
  migration: ProgressionIdMigration,
): ProgressionResult<{
  progression: Progression;
  changes: ProgressionRecoveryChange[];
}> {
  const issues: DataIssue[] = [];
  recoverySchema(input, 'progression', issues);
  if (issues.length) return { ok: false, issues };
  const progression = structuredClone(input) as Progression;
  const changes: ProgressionRecoveryChange[] = [];
  const before = structuredClone(progression);
  progression.defeatedEnemyIds = progression.defeatedEnemyIds.map((value) =>
    mapped(migration.enemies, value),
  );
  progression.visitedFloorIds = progression.visitedFloorIds.map((value) =>
    mapped(migration.floors, value),
  );
  if (progression.location.kind === 'floor') {
    progression.location.floorId = mapped(
      migration.floors,
      progression.location.floorId,
    );
    progression.location.nodeId = mapped(
      migration.nodes,
      progression.location.nodeId,
    );
  }
  change(
    changes,
    'defeatedEnemyIds',
    before.defeatedEnemyIds,
    progression.defeatedEnemyIds,
    'id-migration',
  );
  change(
    changes,
    'visitedFloorIds',
    before.visitedFloorIds,
    progression.visitedFloorIds,
    'id-migration',
  );
  change(
    changes,
    'location',
    before.location,
    progression.location,
    'id-migration',
  );
  return { ok: true, value: { progression, changes } };
}
/** 候補を通常規則で再検証する。未解決討伐があれば導出結果を提供しない。
 * @param campaign 正規ID・報酬メタデータ。
 * @param original 保存された原本。
 * @param progression 移行・修復候補。
 * @param changes 生成した変更差分。
 * @param release 収録確認を行う場合のリリース。
 */
function inspect(
  campaign: CampaignMetadata,
  original: unknown,
  progression: Progression,
  changes: ProgressionRecoveryChange[],
  release?: GameRelease,
): ProgressionRecovery {
  const issues: ProgressionRecovery['issues'] = progression.defeatedEnemyIds
    .filter((value) => !campaign.enemies.some((e) => e.id === value))
    .map((value) => ({
      path: value,
      code: 'unknown-defeat',
      message: '対応表のない討伐IDは削除できません',
    }));
  issues.push(
    ...validateProgression(campaign, progression).map((issue) => ({
      ...issue,
      code: 'invalid-progression' as const,
    })),
  );
  const canApply = issues.length === 0;
  const unavailableLocation =
    canApply &&
    release &&
    progression.location.kind === 'floor' &&
    !release.scope.playableFloorIds.includes(progression.location.floorId)
      ? progression.location.floorId
      : null;
  return {
    original: structuredClone(original),
    progression,
    changes,
    issues,
    canApply,
    derived: canApply ? deriveProgression(campaign, progression) : null,
    unavailableLocation,
    canResume: release ? canApply && unavailableLocation === null : null,
  };
}
/** 明示ID移行のみを行い、通常検証の問題を保持する。重複もここでは除去しない。
 * @param campaign 検証済み全編メタデータ。
 * @param input 保存された未知の進行。
 * @param migration 版に応じた一段のID対応表。
 */
export function migrateProgression(
  campaign: CampaignMetadata,
  input: unknown,
  migration: ProgressionIdMigration = {},
): ProgressionResult<ProgressionRecovery> {
  const result = migrate(input, migration);
  return result.ok
    ? {
        ok: true,
        value: inspect(
          campaign,
          input,
          result.value.progression,
          result.value.changes,
        ),
      }
    : result;
}
/** 移行後に許可された修復だけを候補化し、原本・差分・停止理由を保持する。
 * @param release 検証済みリリース。未知IDと既知未収録を区別する。
 * @param input 保存された未知の進行。型破損では候補を生成しない。
 * @param migration 保存層で選択した明示対応表。
 */
export function previewProgressionRecovery(
  release: GameRelease,
  input: unknown,
  migration: ProgressionIdMigration = {},
): ProgressionResult<ProgressionRecovery> {
  const result = migrate(input, migration);
  if (!result.ok) return result;
  const { progression, changes } = result.value;
  const oldDefeats = [...progression.defeatedEnemyIds];
  const oldVisits = [...progression.visitedFloorIds];
  progression.defeatedEnemyIds = [...new Set(oldDefeats)];
  progression.visitedFloorIds = [...new Set(oldVisits)];
  change(
    changes,
    'defeatedEnemyIds',
    oldDefeats,
    progression.defeatedEnemyIds,
    'duplicate',
  );
  change(
    changes,
    'visitedFloorIds',
    oldVisits,
    progression.visitedFloorIds,
    'duplicate',
  );
  // 安全に報酬を導出できる討伐だけを先に検証する。未知ID・進行の穴は補わない。
  const defeatIssues = validateProgression(release.campaign, {
    ...progression,
    visitedFloorIds: [],
    endingHandled: false,
    location: { kind: 'guild' },
  });
  if (!defeatIssues.length) {
    const derived = deriveProgression(release.campaign, progression);
    const visits = [...progression.visitedFloorIds];
    progression.visitedFloorIds = visits.filter((value) =>
      derived.unlockedFloorIds.includes(value),
    );
    change(
      changes,
      'visitedFloorIds',
      visits,
      progression.visitedFloorIds,
      'invalid-visit',
    );
    if (progression.endingHandled && !derived.finalClear) {
      progression.endingHandled = false;
      change(changes, 'endingHandled', true, false, 'ending-before-clear');
    }
    const locationIssues = validateProgression(release.campaign, {
      ...progression,
      visitedFloorIds: [],
      endingHandled: false,
    });
    if (locationIssues.length) {
      const before = progression.location;
      progression.location = { kind: 'guild' };
      change(
        changes,
        'location',
        before,
        progression.location,
        'invalid-location',
      );
    }
  }
  return {
    ok: true,
    value: inspect(release.campaign, input, progression, changes, release),
  };
}
