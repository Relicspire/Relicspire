import type {
  CharacterId,
  EnemyId,
  EquipmentId,
  EquipmentSlots,
  GameContent,
  JobId,
  SkillNodeId,
} from '../data/model';
/** 1人の確定編成。HP・残りポイント・CDは保存せず、能力と予算から導出する。 */
export interface PartyBuild {
  /** スロットに対応する固定人物ID。 */
  id: CharacterId;
  /** 現在選択しているジョブ。他の人物との重複を許可する。 */
  jobId: JobId;
  /** 購入済みノード。上位コマンドに置換された下位ノードも保持する。 */
  learnedSkills: SkillNodeId[];
  /** 自由装備の6枠。空き枠はnullで表す。 */
  equipment: EquipmentSlots;
}
/** 味方1→2→3の順序を固定した編成。ジョブの重複は許可する。 */
export type PartyFormation = [PartyBuild, PartyBuild, PartyBuild];
/** 討伐集合を予算・所持品の正規情報とし、戦闘中の編成更新を禁止する。 */
export interface FormationContext {
  defeatedEnemyIds: EnemyId[];
  inBattle: boolean;
}
/** 人物・ノード・装備枠を特定できる編成検証の問題。 */
export interface FormationIssue {
  path: string;
  code: string;
  message: string;
}
/** 原子的な純粋操作の結果。不正時には入力状態を変更しない。 */
export type FormationResult<T> =
  { ok: true; value: T } | { ok: false; issues: FormationIssue[] };
/** 呼び出し元が生成する管理ID。戦闘判定の乱数とは独立する。 */
export type PresetId = `preset-${string}`;
/** 編成だけを保存するプリセット。時刻はUTCのUnixミリ秒、版は非負整数。 */
export interface BuildPreset {
  id: PresetId;
  name: string;
  createdAt: number;
  updatedAt: number;
  contentVersion: number;
  party: PartyFormation;
}
/** 保存層に渡す編成候補。所持数・進行・戦闘状態は含めない。 */
export interface FormationState {
  party: PartyFormation;
  presets: BuildPreset[];
}
/** UIが渡す保存メタデータ。純粋ロジックは時計や乱数を呼ばない。 */
export interface PresetMetadata {
  id: PresetId;
  name: string;
  now: number;
  contentVersion: number;
}
/** 1個の装備枠。人物は固定ID、slotは0〜5。 */
export interface EquipmentLocation {
  characterId: CharacterId;
  slot: number;
}
/** 振り直し時に表示する依存ノードと返却費用のプレビュー。 */
export interface SkillRefund {
  removedSkillIds: SkillNodeId[];
  refundedPoints: number;
}
/** 修復プレビューの差分。元のプリセットは常に保持する。 */
export interface RepairChange {
  path: string;
  before: string;
  after: string | null;
  reason: string;
}
/** 明示された版移行のID対応表。対応なしの削除済みIDは通常呼出で拒否する。 */
export interface PresetIdMigration {
  jobs?: Record<string, JobId>;
  skills?: Record<string, SkillNodeId>;
  equipment?: Record<string, EquipmentId>;
}
/** 適用前の修復候補と残存問題。予算超過・未知ジョブを自動で解消しない。 */
export interface PresetRepair {
  party: PartyFormation;
  changes: RepairChange[];
  issues: FormationIssue[];
}
/** 共通APIの入力コンテンツ。事前にparseGameContentで検証したカタログを使用する。 */
export type FormationContent = GameContent;
