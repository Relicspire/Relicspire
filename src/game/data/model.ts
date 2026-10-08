/** Content IDs are stable save references; names belong in PresentationCatalog. */
export const JOB_IDS = [
  'knight',
  'wizard',
  'cleric',
  'thief',
  'ranger',
  'berserker',
  'time-mage',
  'paladin',
] as const;
export type JobId = (typeof JOB_IDS)[number];
export type CharacterId = 'party-1' | 'party-2' | 'party-3';
export type FloorNumber =
  '01' | '02' | '03' | '04' | '05' | '06' | '07' | '08' | '09' | '10';
export type GuardianNumber = '01' | '02' | '03' | '04' | '05';
export type FloorId = `floor-${FloorNumber}`;
export type EnemyId =
  `boss-${FloorNumber}` | `guardian-${FloorNumber}-${GuardianNumber}`;
export type RelicId = `relic-${FloorNumber}-${GuardianNumber}`;
export type StarterEquipmentId =
  `starter-${'sword' | 'staff' | 'armor' | 'charm' | 'boots' | 'ring'}`;
export type EquipmentId = StarterEquipmentId | RelicId;
export type SkillNodeId = `${JobId}-${'a' | 'b'}${1 | 2 | 3}`;
export type SkillId =
  SkillNodeId | `${EnemyId}-s${1 | 2 | 3}` | 'basic-attack' | 'wait';
export type CooldownId = `${JobId}-${'a' | 'b'}` | SkillId;
export type NodeId =
  `${FloorId}-${'entry' | 'boss' | `hall-${1 | 2 | 3}` | `alcove-${1 | 2 | 3 | 4 | 5}`}`;
/** TU and basis points (10000 = 100%) are nonnegative safe integers at the data boundary. */
export type TU = number;
export type BasisPoints = number;
export interface Stats {
  maxHp: number;
  atk: number;
  mag: number;
  def: number;
  mdef: number;
  spd: number;
}
export type Element = 'none' | 'fire' | 'ice' | 'lightning' | 'light' | 'dark';
export type TargetBinding = 'selected' | 'all-allies' | 'all-enemies' | 'self';
export type TargetRule =
  | 'enemy-single'
  | 'enemy-all'
  | 'ally-single'
  | 'ally-other'
  | 'ally-all'
  | 'self'
  | 'dead-ally-other'
  | 'waiting-ally-other';
export type Power =
  | number
  | {
      kind: 'low-hp';
      normal: number;
      lowHp: number;
      snapshot: 'before-activation';
    };
export interface AttackPayload {
  damageType: 'physical' | 'magic';
  element: Element | 'chosen';
  power: Power;
  breakDamage: number;
  hits: 1;
  actorReference: 'before-activation';
  targetReference: 'before-effect';
}
export type StatusSpec =
  | {
      familyId:
        | 'atk-up'
        | 'atk-down'
        | 'mag-up'
        | 'mag-down'
        | 'spd-up'
        | 'spd-down'
        | 'physical-guard'
        | 'magic-guard';
      magnitude: BasisPoints;
    }
  | { familyId: 'taunt' | 'cover' | 'time-stop' }
  | { familyId: 'reflect'; ratio: 5000; charges: number }
  | { familyId: 'counter' | 'follow'; attack: AttackPayload }
  | { familyId: 'poison'; damage: number; interval: 20 }
  | { familyId: 'self-revive'; hpRatio: BasisPoints; charges: 1 };
export type UtilityPayload =
  | { kind: 'shift'; direction: 'advance' | 'delay'; amount: TU }
  | { kind: 'cancel-cast' }
  | {
      kind: 'apply-status';
      status: StatusSpec;
      duration: TU;
      dispellable: boolean;
    }
  | { kind: 'dispel'; polarity: 'buff' | 'debuff'; count: number };
export type HitEffect = UtilityPayload & { target: 'hit-recipient' };
export type Effect =
  | (AttackPayload & {
      kind: 'attack';
      target: TargetBinding;
      attached: HitEffect[];
    })
  | (UtilityPayload & { target: TargetBinding })
  | {
      kind: 'heal';
      target: TargetBinding;
      power: number;
      actorReference: 'before-activation';
      targetReference: 'before-effect';
    }
  | { kind: 'revive'; target: 'selected'; hpRatio: BasisPoints }
  | {
      kind: 'trap';
      target: 'selected';
      duration: TU;
      attack: AttackPayload;
      attached: HitEffect[];
      snapshot: 'on-trigger';
    };
export interface SkillDefinition {
  id: SkillId;
  target: TargetRule;
  castTime: TU;
  delay: TU;
  cooldown: TU;
  cooldownId: CooldownId;
  actorSnapshot: 'before-activation';
  targetSnapshot: 'before-activation';
  elementChoices: Element[];
  effects: Effect[];
}
export interface SkillNode {
  id: SkillNodeId;
  skillId: SkillNodeId;
  cost: 1 | 2 | 3;
  prerequisites: SkillNodeId[];
  replacementGroup: CooldownId;
  rank: 1 | 2 | 3;
}
export interface JobDefinition {
  id: JobId;
  routes: { a: SkillNode[]; b: SkillNode[] };
}
export type EquipmentSlots = [
  EquipmentId | null,
  EquipmentId | null,
  EquipmentId | null,
  EquipmentId | null,
  EquipmentId | null,
  EquipmentId | null,
];
export interface CharacterDefinition {
  id: CharacterId;
  baseStats: Stats;
  initialJob: JobId;
  initialSkills: SkillNodeId[];
  initialEquipment: EquipmentSlots;
}
export interface StarterEquipmentDefinition {
  id: StarterEquipmentId;
  kind: 'starter';
  stats: Partial<Stats>;
  maxOwned: 3;
}
export interface RelicDefinition {
  id: RelicId;
  kind: 'relic';
  stats: Partial<Stats>;
  maxOwned: 1;
  sourceEnemyId: EnemyId;
}
export type EquipmentDefinition = StarterEquipmentDefinition | RelicDefinition;
export interface BattleReward {
  skillPointsPerCharacter: number;
  equipment: { id: EquipmentId; quantity: number }[];
  unlockFloorId: FloorId | null;
  finalClear: boolean;
}
export interface EnemyAction {
  skillId: SkillId;
  selection:
    | 'lowest-hp'
    | 'highest-atk'
    | 'highest-mag'
    | 'highest-spd'
    | 'all'
    | 'self';
}
export interface EnemyPhase {
  id: string;
  hpThreshold: BasisPoints;
  actions: EnemyAction[];
}
export interface EnemyDefinition {
  id: EnemyId;
  stats: Stats;
  maxBreakGauge: number;
  weakness: Element;
  resistance: Element;
  immuneElements?: Element[];
  breakResistance: BasisPoints;
  knockbackResistance: BasisPoints;
  cancelImmune: boolean;
  timeStopImmune: boolean;
  phases: EnemyPhase[];
  reward: BattleReward;
}
export interface FloorNode {
  id: NodeId;
  links: NodeId[];
  enemies: [] | [EnemyId];
}
export interface FloorDefinition {
  id: FloorId;
  entryNodeId: NodeId;
  nodes: FloorNode[];
}
export interface GameContent {
  characters: CharacterDefinition[];
  jobs: JobDefinition[];
  skills: SkillDefinition[];
  equipment: EquipmentDefinition[];
  enemies: EnemyDefinition[];
  floors: FloorDefinition[];
}
/** UI text never determines an effect, target, phase or reward. */
export interface PresentationCatalog {
  entries: Record<string, { name: string; description: string }>;
  floors: Partial<
    Record<FloorId, { theme: string; entryText: string; hints: string[] }>
  >;
  ending: string[];
}
