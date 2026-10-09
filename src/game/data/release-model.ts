import type {
  BattleReward,
  EnemyId,
  FloorId,
  GameContent,
  PresentationCatalog,
  RelicId,
  Element,
  TargetRule,
  StatusSpec,
} from './model';
/** 実戦能力を含めない全編の正規ID・所属・固定報酬。MVPでも全件を保持する。 */
export interface CampaignMetadata {
  floors: { id: FloorId }[];
  enemies: { id: EnemyId; floorId: FloorId; reward: BattleReward }[];
  relics: {
    id: RelicId;
    floorId: FloorId;
    sourceEnemyId: EnemyId;
    maxOwned: 1;
  }[];
}
/** この版で探索・戦闘できる階層。解放済みでも収録されていなければ移動できない。 */
export interface ReleaseScope {
  playableFloorIds: FloorId[];
}
/** リリース用の表示データ。既存本文に全属性・状態系統・対象規則の表示対応を加える。 */
export interface ReleasePresentation extends PresentationCatalog {
  elements: Record<Element, string>;
  statuses: Record<StatusSpec['familyId'], string>;
  targets: Record<TargetRule, string>;
}
/** 全編進行メタデータと収録実戦データを分離したリリース単位。 */
export interface GameRelease {
  contentVersion: number;
  campaign: CampaignMetadata;
  scope: ReleaseScope;
  content: GameContent;
  presentation: ReleasePresentation;
}
/** 解放状態と独立した収録状態。未知と既知未収録を区別する。 */
export type ContentAvailability = 'unknown' | 'unavailable' | 'playable';
