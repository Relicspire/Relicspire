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
export interface PartyBuild {
  id: CharacterId;
  jobId: JobId;
  learnedSkills: SkillNodeId[];
  equipment: EquipmentSlots;
}
export interface BattleSetup {
  party: [PartyBuild, PartyBuild, PartyBuild];
  enemyId: EnemyId;
}
export interface BattleLogEntry {
  sequence: number;
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
  amount: number | null;
  detail: string | null;
}
/** The engine owns no browser/persistence state. The caller supplies its pre-battle snapshot. */
export interface BattleSession<T = null> {
  content: GameContent;
  setup: BattleSetup;
  initialState: BattleState;
  state: BattleState;
  log: BattleLogEntry[];
  preBattle: T;
}
export type CommandCheck = { ok: true } | { ok: false; reason: string };
export interface PlayerCommand extends CommandReservation {
  actorId: CharacterId;
}
export type CommandResult<T> =
  | { ok: true; session: BattleSession<T> }
  | { ok: false; reason: string; session: BattleSession<T> };
export interface EnemyForecast {
  enemyId: EnemyId;
  command: CommandReservation;
  targets: ParticipantId[];
  startsAt: TU | null;
  activatesAt: TU | null;
  frozenRemaining: TU | null;
  isCasting: boolean;
  blocked: boolean;
  phaseIndex: number;
  actionIndex: number;
}
export interface BattleOutcome<T> {
  result: BattleState['result'];
  reward: BattleReward | null;
  preBattle: T;
}
