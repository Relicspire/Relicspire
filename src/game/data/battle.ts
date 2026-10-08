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
export type ParticipantId = CharacterId | EnemyId;
/** Frozen timers store remaining TU, never an ambiguous absolute timestamp. */
export type Timer =
  { kind: 'running'; at: TU } | { kind: 'frozen'; remaining: TU };
export interface Cooldown {
  id: CooldownId;
  timer: Timer;
}
export interface CommandReservation {
  skillId: SkillId;
  selectedTargetId: ParticipantId | null;
  chosenElement: Element | null;
}
export interface Cast {
  command: CommandReservation;
  completes: Timer;
}
export interface BreakState {
  recovers: Timer;
}
export type ActionState =
  | { kind: 'waiting'; ready: Timer }
  | { kind: 'ready' }
  | { kind: 'acting'; pendingKnockback: TU }
  | { kind: 'casting'; cast: Cast }
  | { kind: 'broken'; break: BreakState }
  | { kind: 'dead' }
  | { kind: 'finished' };
export interface StatusEffect {
  id: number;
  sourceId: ParticipantId;
  sequence: number;
  spec: StatusSpec;
  dispellable: boolean;
  expires: Timer;
  nextTick: Timer | null;
  remainingCharges: number | null;
}
export interface Trap {
  sourceId: ParticipantId;
  targetId: EnemyId;
  sequence: number;
  expires: Timer;
  attack: AttackPayload;
  attached: HitEffect[];
  snapshot: 'on-trigger';
}
export interface ParticipantBase {
  id: ParticipantId;
  /** Baseline plus equipment; effectiveStats applies modifiers before final clamps. maxHp is already clamped. */
  stats: Stats;
  hp: number;
  action: ActionState;
  statuses: StatusEffect[];
  cooldowns: Cooldown[];
  timeStopUntil: TU | null;
}
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
export interface ActorSnapshot {
  reference: 'before-activation';
  actorId: ParticipantId;
  atk: number;
  mag: number;
  spd: number;
  hp: number;
  maxHp: number;
  damageModifier: BasisPoints;
  healingModifier: BasisPoints;
}
export interface ActivationContext {
  command: CommandReservation;
  actor: ActorSnapshot;
  selected: ParticipantId | null;
  allAllies: ParticipantId[];
  allEnemies: ParticipantId[];
}
export interface BattleState {
  now: TU;
  participants: [
    BattleParticipant,
    BattleParticipant,
    BattleParticipant,
    BattleParticipant,
  ];
  timeline: TimelineEvent[];
  traps: Trap[];
  nextSequence: number;
  result: 'ongoing' | 'victory' | 'defeat' | 'escaped';
}
