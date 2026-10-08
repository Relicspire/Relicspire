import type {
  AttackPayload,
  BasisPoints,
  CharacterId,
  CooldownId,
  Element,
  EnemyId,
  EquipmentSlots,
  HitEffect,
  JobId,
  SkillId,
  SkillNodeId,
  Stats,
  StatusSpec,
  TU,
} from './model';
/** 戦闘内の味方と敵を共通に識別するID。 */
export type ParticipantId = CharacterId | EnemyId;
/** 通常時の絶対TUと時間停止中の残りTUを区別する。凍結値を絶対時刻として扱わない。 */
export type Timer =
  { kind: 'running'; at: TU } | { kind: 'frozen'; remaining: TU };
/** スキル系統ごとの再使用可能時刻。時間停止中は残りTUを保存する。 */
export interface Cooldown {
  id: CooldownId;
  timer: Timer;
}
/** 確定したスキル・単体対象・属性選択。詠唱開始後は対象を選び直さない。 */
export interface CommandReservation {
  skillId: SkillId;
  /** コマンド確定時に予約する単体対象ID。自身・全体対象ではnull。 */
  selectedTargetId: ParticipantId | null;
  /** 確定した選択属性。属性選択がないスキルではnull。 */
  chosenElement: Element | null;
}
/** 予約コマンドと詠唱完了タイマー。妨害時は予約ごと削除する。 */
export interface Cast {
  command: CommandReservation;
  completes: Timer;
}
/** ブレイク復帰タイマー。通常待機・詠唱予定とは排他的に保持する。 */
export interface BreakState {
  recovers: Timer;
}
/** 参加者の行動状態。actingは処理中の後退量、finishedは予定のない戦闘終了状態を表す。 */
export type ActionState =
  | { kind: 'waiting'; ready: Timer }
  | { kind: 'ready' }
  | { kind: 'acting'; pendingKnockback: TU }
  | { kind: 'casting'; cast: Cast }
  | { kind: 'broken'; break: BreakState }
  | { kind: 'dead' }
  | { kind: 'finished' };
/** 付与済み状態の性能・付与者・期限・周期・残り回数。同系統延長では期限だけ更新する。 */
export interface StatusEffect {
  id: number;
  /** 付与者または設置者のID。同系統延長では変更しない。 */
  sourceId: ParticipantId;
  /** 安定した処理順に使う連番。 */
  sequence: number;
  spec: StatusSpec;
  dispellable: boolean;
  /** 通常時の絶対期限または停止中の残り持続TU。 */
  expires: Timer;
  /** 毒の次回発動予定。定期効果がなければnull。 */
  nextTick: Timer | null;
  /** 残り使用回数。同系統延長では補充しない。回数制限なしならnull。 */
  remainingCharges: number | null;
}
/** 設置者ごとに1個の罠。指定敵の行動開始前に、設置順で一度だけ発動する。 */
export interface Trap {
  /** 付与者または設置者のID。同系統延長では変更しない。 */
  sourceId: ParticipantId;
  targetId: EnemyId;
  /** 安定した処理順に使う連番。 */
  sequence: number;
  /** 通常時の絶対期限または停止中の残り持続TU。 */
  expires: Timer;
  attack: AttackPayload;
  attached: HitEffect[];
  snapshot: 'on-trigger';
}
/** 味方と敵に共通するHP・行動予定・状態・CD・時間停止の一時データ。 */
export interface ParticipantBase {
  id: ParticipantId;
  /** 装備加算後の基礎値。最大HPのみ制限済みで、ほかの能力はeffectiveStatsで補正後に上下限を適用する。 */
  stats: Stats;
  /** 現在HP。0で戦闘不能。 */
  hp: number;
  /** 最大1件の行動予定を持つ現在状態。 */
  action: ActionState;
  /** 現在付与されている状態効果。 */
  statuses: StatusEffect[];
  /** スキル系統ごとの再使用タイマー。 */
  cooldowns: Cooldown[];
  /** 戦闘全体のTUで経過する停止終了時刻。停止なしならnull。 */
  timeStopUntil: TU | null;
}
/** 味方のビルド情報と敵のゲージ・行動列位置を陣営で判別する参加者型。 */
export type BattleParticipant =
  | (ParticipantBase & {
      side: 'party';
      id: CharacterId;
      slot: 0 | 1 | 2;
      jobId: JobId;
      learnedSkills: SkillNodeId[];
      equipment: EquipmentSlots;
    })
  | (ParticipantBase & {
      side: 'enemy';
      id: EnemyId;
      breakGauge: number;
      maxBreakGauge: number;
      phaseIndex: number;
      actionIndex: number;
    });
/** 有効タイマーから生成する予定イベント。同時刻は種別、参加者、付与順で解決する。 */
export type TimelineEvent = {
  id: number;
  participantId: ParticipantId;
  at: TU;
  sequence: number;
} & (
  | { kind: 'time-stop-end' | 'break-recovery' | 'cast-complete' | 'ready' }
  | { kind: 'status-expiry' | 'poison-tick'; statusId: number }
  | { kind: 'trap-expiry'; trapSequence: number }
);
/** 発動直前に固定する行動者の能力・HP・補正。同一行動の後続効果で再計算しない。 */
export interface ActorSnapshot {
  reference: 'before-activation';
  actorId: ParticipantId;
  /** 物理攻撃力。 */
  atk: number;
  /** 魔法攻撃・回復に使用する魔力。 */
  mag: number;
  /** 開始待機と以後のディレイに使う速度。 */
  spd: number;
  /** 現在HP。0で戦闘不能。 */
  hp: number;
  /** 最大HP。戦闘中の増減は採用しない。 */
  maxHp: number;
  /** 与ダメージ倍率（10000基準）。 */
  damageModifier: BasisPoints;
  /** 与回復倍率（10000基準）。 */
  healingModifier: BasisPoints;
}
/** 予約済みの単体対象と発動時に固定した全体対象集合を持つ実行コンテキスト。 */
export interface ActivationContext {
  command: CommandReservation;
  actor: ActorSnapshot;
  selected: ParticipantId | null;
  allAllies: ParticipantId[];
  allEnemies: ParticipantId[];
}
/** 3人と敵1体の戦闘一時状態。論理時刻・有効予定・罠・連番・結果を保持する。 */
export interface BattleState {
  /** 戦闘開始を0とする現在の論理TU。 */
  now: TU;
  /** 味方1→2→3→敵の固定参加者順。 */
  participants: [
    BattleParticipant,
    BattleParticipant,
    BattleParticipant,
    BattleParticipant,
  ];
  /** 有効タイマーから生成した、処理順に並ぶ予定一覧。 */
  timeline: TimelineEvent[];
  /** 設置者ごとに最大1個の罠一覧。 */
  traps: Trap[];
  /** 状態・罠・イベントの新規識別子に使う次の連番。 */
  nextSequence: number;
  result: 'ongoing' | 'victory' | 'defeat' | 'escaped';
}
