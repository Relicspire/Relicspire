import type {
  BattleState,
  CommandReservation,
  ParticipantId,
} from '../data/battle';
import type {
  CharacterId,
  EnemyId,
  EquipmentSlots,
  GameContent,
  JobId,
  SkillNodeId,
  BattleReward,
  SkillId,
  TU,
} from '../data/model';
/** 戦闘開始時に確定した1人分のジョブ・習得・6枠装備。 */
export interface PartyBuild {
  id: CharacterId;
  /** 現在選択しているジョブID。 */
  jobId: JobId;
  /** 習得済みノードID。上位置換で下位が隠れても習得記録は保持する。 */
  learnedSkills: SkillNodeId[];
  equipment: EquipmentSlots;
}
/** 参加者順を固定した3人の編成と、今回戦う敵ID。 */
export interface BattleSetup {
  party: [PartyBuild, PartyBuild, PartyBuild];
  enemyId: EnemyId;
}
/** 結果再現とデバッグに使う構造化ログ。論理時刻とログ連番で順序を保持する。 */
export interface BattleLogEntry {
  /** 安定した処理順に使う連番。 */
  sequence: number;
  /** 戦闘開始を0とする現在の論理TU。 */
  now: TU;
  kind:
    | 'start'
    | 'command'
    | 'cast'
    | 'fizzle'
    | 'damage'
    | 'heal'
    | 'death'
    | 'revive'
    | 'break'
    | 'recover'
    | 'status'
    | 'expire'
    | 'dispel'
    | 'shift'
    | 'cancel'
    | 'trap'
    | 'reflect'
    | 'counter'
    | 'follow'
    | 'phase'
    | 'result';
  actorId: ParticipantId | null;
  targetId: ParticipantId | null;
  skillId: SkillId | null;
  /** ログ種別に応じたHP量やTUなど。該当しない場合はnull。 */
  amount: number | null;
  /** 処理種別に応じた補足情報。 */
  detail: string | null;
}
/** 純粋な更新APIが受け渡す戦闘セッション。Tは呼び出し元の戦闘前進行型で、エンジンは内容を変更しない。 */
export interface BattleSession<T = null> {
  /** ロジック用ゲームコンテンツ。 */
  content: GameContent;
  /** 戦闘開始時に確定した編成と敵。 */
  setup: BattleSetup;
  /** リトライ元のTU0状態。 */
  initialState: BattleState;
  /** 現在の戦闘一時状態。 */
  state: BattleState;
  /** 論理時刻と連番を持つ構造化ログ。 */
  log: BattleLogEntry[];
  /** 呼び出し元が保持する戦闘前の確定進行。エンジンは内容を変更しない。 */
  preBattle: T;
}
/** コマンド使用可否。拒否理由を返し、状態は更新しない。 */
export type CommandCheck = { ok: true } | { ok: false; reason: string };
/** 予約内容に入力者のキャラクターIDを加えたプレイヤーコマンド。 */
export interface PlayerCommand extends CommandReservation {
  actorId: CharacterId;
}
/** 確定成功なら更新セッション、不正入力なら理由と元セッションを返す。 */
export type CommandResult<T> =
  | { ok: true; session: BattleSession<T> }
  | { ok: false; reason: string; session: BattleSession<T> };
/** 敵の現在の予告情報。詠唱中は予約を保持し、停止中は凍結残りTUを示す。 */
export interface EnemyForecast {
  enemyId: EnemyId;
  command: CommandReservation;
  targets: ParticipantId[];
  /** 次の開始予定TU。詠唱中・ブレイク中・停止中・終了時はnull。 */
  startsAt: TU | null;
  /** 発動予定TU。絶対時刻を示せない場合はnull。 */
  activatesAt: TU | null;
  /** 停止中に保存された行動予定までの残りTU。通常時はnull。 */
  frozenRemaining: TU | null;
  /** 現在の予告が予約済み詠唱を指すか。 */
  isCasting: boolean;
  /** 死亡・ブレイク・時間停止・終了で行動できないか。 */
  blocked: boolean;
  /** 現在フェーズの配列位置。 */
  phaseIndex: number;
  /** 現在フェーズで次に開始する行動列位置。 */
  actionIndex: number;
}
/** 勝敗と勝利報酬候補、復元用の戦闘前進行コピー。保存・報酬付与の副作用はない。 */
export interface BattleOutcome<T> {
  result: BattleState['result'];
  reward: BattleReward | null;
  /** 呼び出し元が保持する戦闘前の確定進行。エンジンは内容を変更しない。 */
  preBattle: T;
}
