import type { EffectResult } from './effect-results';
export type * from './effect-results';
import type {
  BattleState,
  CommandReservation,
  ParticipantId,
} from '../data/battle';
import type {
  BattleReward,
  CharacterId,
  EnemyId,
  GameContent,
  SkillId,
  TU,
} from '../data/model';
import type { CampaignMetadata } from '../data/release-model';
import type { FormationContext, PartyBuild } from '../party/types';
export type { PartyBuild } from '../party/types';
/** 参加者順を固定した3人の編成と、今回戦う敵ID。 */
export interface BattleSetup {
  party: [PartyBuild, PartyBuild, PartyBuild];
  enemyId: EnemyId;
  /** 戦闘前に検証済みの進行。省略時は初期予算3・守護者未討伐として編成を検証する。 */
  context?: FormationContext;
  /** 正式リリースの全編メタデータ。未収録階層への報酬参照を検証するために渡す。 */
  campaign?: CampaignMetadata;
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
  /** 効果単位の診断履歴。ログ連番・状態の連番とは独立する。 */
  effectResults: EffectResult[];
  /** 呼び出し元が保持する戦闘前の確定進行。エンジンは内容を変更しない。 */
  preBattle: T;
}
/** コマンド使用可否。拒否理由を返し、状態は更新しない。 */
export type CommandRejectionCode =
  | 'not-awaiting-input'
  | 'unknown-skill'
  | 'not-learned'
  | 'replaced'
  | 'cooldown'
  | 'invalid-element'
  | 'unexpected-target'
  | 'invalid-target';
/** 表示文言と独立した拒否コードと、従来のデバッグ理由。 */
export type CommandCheck =
  { ok: true } | { ok: false; code: CommandRejectionCode; reason: string };
/** 予約内容に入力者のキャラクターIDを加えたプレイヤーコマンド。 */
export interface PlayerCommand extends CommandReservation {
  actorId: CharacterId;
}
/** 確定成功なら更新セッション、不正入力なら理由と元セッションを返す。 */
export type CommandResult<T> =
  | { ok: true; session: BattleSession<T> }
  | {
      ok: false;
      code: CommandRejectionCode;
      reason: string;
      session: BattleSession<T>;
    };
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
