/** 全編で使用する8ジョブの固定ID一覧。IDはセーブ参照に使い、表示名は別管理する。 */
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
/** 全8ジョブを識別する固定ID。表示名と独立して保存・参照に使う。 */
export type JobId = (typeof JOB_IDS)[number];
/** パーティの固定3枠を識別するキャラクターID。 */
export type CharacterId = 'party-1' | 'party-2' | 'party-3';
/** 第1〜10階層を表す2桁の番号。 */
export type FloorNumber =
  '01' | '02' | '03' | '04' | '05' | '06' | '07' | '08' | '09' | '10';
/** 各階層に配置する5体の守護者の2桁番号。 */
export type GuardianNumber = '01' | '02' | '03' | '04' | '05';
/** 階層番号を含む階層ID。 */
export type FloorId = `floor-${FloorNumber}`;
/** 階層ボスまたは遺物守護者を識別するID。 */
export type EnemyId =
  `boss-${FloorNumber}` | `guardian-${FloorNumber}-${GuardianNumber}`;
/** 階層と守護者番号で一意に決まるユニーク遺物ID。 */
export type RelicId = `relic-${FloorNumber}-${GuardianNumber}`;
/** 初期装備6種類を識別するID。部位の装備制限は意味しない。 */
export type StarterEquipmentId =
  `starter-${'sword' | 'staff' | 'armor' | 'charm' | 'boots' | 'ring'}`;
/** 初期装備とユニーク遺物を共通に参照する装備ID。 */
export type EquipmentId = StarterEquipmentId | RelicId;
/** ジョブ・ルート・ランクを含む習得ノードID。 */
export type SkillNodeId = `${JobId}-${'a' | 'b'}${1 | 2 | 3}`;
/** 習得スキル、敵スキル、無料の基本コマンドを識別するID。 */
export type SkillId =
  SkillNodeId | `${EnemyId}-s${1 | 2 | 3}` | 'basic-attack' | 'wait';
/** 上位置換で共有するスキル系統、または独立スキルのCD識別子。 */
export type CooldownId = `${JobId}-${'a' | 'b'}` | SkillId;
/** 階層IDと部屋種別を含む探索ノードID。 */
export type NodeId =
  `${FloorId}-${'entry' | 'boss' | `hall-${1 | 2 | 3}` | `alcove-${1 | 2 | 3 | 4 | 5}`}`;
/** 論理時間の単位。読み込み境界で非負の安全な整数として検証する。実時間とは独立する。 */
export type TU = number;
/** 10000を1倍（100%）とする整数倍率。許容範囲は各効果の検証で決める。 */
export type BasisPoints = number;
/** HP上限と攻撃・魔力・防御・魔法防御・速度の共通能力値。 */
export interface Stats {
  /** 最大HP。戦闘中の増減は採用しない。 */
  maxHp: number;
  /** 物理攻撃力。 */
  atk: number;
  /** 魔法攻撃・回復に使用する魔力。 */
  mag: number;
  /** 物理防御力。 */
  def: number;
  /** 魔法防御力。 */
  mdef: number;
  /** 開始待機と以後のディレイに使う速度。 */
  spd: number;
}
/** 攻撃属性。noneは無属性で、常に通常倍率として扱う。 */
export type Element = 'none' | 'fire' | 'ice' | 'lightning' | 'light' | 'dark';
/** Effectの対象束縛。単体予約、発動時の全体集合、自身を区別する。 */
export type TargetBinding = 'selected' | 'all-allies' | 'all-enemies' | 'self';
/** スキル全体の対象選択・発動適格性を決める規則。 */
export type TargetRule =
  | 'enemy-single'
  | 'enemy-all'
  | 'ally-single'
  | 'ally-other'
  | 'ally-all'
  | 'self'
  | 'dead-ally-other'
  | 'waiting-ally-other';
/** 固定威力、または発動直前のHP条件で選ぶ背水威力。 */
export type Power =
  | number
  | {
      kind: 'low-hp';
      normal: number;
      lowHp: number;
      snapshot: 'before-activation';
    };
/** 1ヒットの攻撃性能。行動者能力は発動直前、対象能力は各効果直前に参照する。 */
export interface AttackPayload {
  /** 物理または魔法のダメージ種別。 */
  damageType: 'physical' | 'magic';
  /** 攻撃属性。chosenはコマンド確定時の選択属性を使用する。 */
  element: Element | 'chosen';
  /** 固定威力または発動時HP条件で選ぶ背水威力。 */
  power: Power;
  /** 弱点・耐性を適用する前の基礎ゲージ削り。 */
  breakDamage: number;
  /** 現行では1に固定するヒット数。 */
  hits: 1;
  /** 行動者能力を参照する時点。反応攻撃ではその反応の発動直前。 */
  actorReference: 'before-activation';
  /** 対象の防御・補正を参照する時点。 */
  targetReference: 'before-effect';
}
/** 状態効果の性能を系統別に定義する。付与者・期限・残り回数は戦闘状態で別途保持する。 */
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
/** 攻撃以外の時間操作・詠唱妨害・状態付与・解除の性能。 */
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
/** かばう後の実際の被弾者に束縛する攻撃付随効果。独立した対象選択をしない。 */
export type HitEffect = UtilityPayload & { target: 'hit-recipient' };
/** スキルを構成する効果の判別共用体。配列順に実行し、未対応効果は読み込み時に拒否する。 */
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
/** スキルの対象規則・時間・CD・属性選択・効果を定義するロジック用データ。 */
export interface SkillDefinition {
  id: SkillId;
  /** スキル全体の必須対象と適格性。Effectごとの対象束縛とは区別する。 */
  target: TargetRule;
  /** 詠唱開始から発動までのTU。速度では短縮しない。 */
  castTime: TU;
  /** 発動後の基礎ディレイTU。発動直前のSPDで補正する。 */
  delay: TU;
  /** コマンド確定から同系統の再使用までのTU。 */
  cooldown: TU;
  /** 上位版と共有するスキル系統または独立スキルの識別子。 */
  cooldownId: CooldownId;
  /** 能力とHP条件を発動直前に固定する参照契約。 */
  actorSnapshot: 'before-activation';
  /** 全体対象集合を発動直前に固定する参照契約。 */
  targetSnapshot: 'before-activation';
  /** コマンド確定時に選べる属性。選択不要なら空配列。 */
  elementChoices: Element[];
  /** 記載順で解決する独立Effectの一覧。 */
  effects: Effect[];
}
/** 習得費用、前提ノード、ランク、上位置換グループを定義する。 */
export interface SkillNode {
  id: SkillNodeId;
  skillId: SkillNodeId;
  /** 習得に追加で必要なポイント。 */
  cost: 1 | 2 | 3;
  /** このノードの習得に必要な前提ノードID。 */
  prerequisites: SkillNodeId[];
  /** 上位版による置換とCD共有に用いるグループID。 */
  replacementGroup: CooldownId;
  /** 置換の優先度を表すランク（1〜3）。 */
  rank: 1 | 2 | 3;
}
/** ジョブが持つA・Bのスキルツリー。能力補正や表示文言は含めない。 */
export interface JobDefinition {
  id: JobId;
  routes: { a: SkillNode[]; b: SkillNode[] };
}
/** 順序付きの6装備枠。nullは空欄を表し、部位制限は設けない。 */
export type EquipmentSlots = [
  EquipmentId | null,
  EquipmentId | null,
  EquipmentId | null,
  EquipmentId | null,
  EquipmentId | null,
  EquipmentId | null,
];
/** キャラクターの基礎能力と新規開始時のジョブ・習得・装備。 */
export interface CharacterDefinition {
  id: CharacterId;
  /** 装備・状態補正前の基礎能力値。 */
  baseStats: Stats;
  /** 新規開始時に選ぶジョブ。 */
  initialJob: JobId;
  /** 新規開始時に習得済みのノードID。 */
  initialSkills: SkillNodeId[];
  /** 新規開始時の順序付き6枠装備。 */
  initialEquipment: EquipmentSlots;
}
/** 所持上限3個の初期装備。性能は固定の能力加算のみ。 */
export interface StarterEquipmentDefinition {
  id: StarterEquipmentId;
  kind: 'starter';
  /** 装備1個による固定能力加算。未指定能力の加算は0。 */
  stats: Partial<Stats>;
  /** パーティ全体の最大所持数。装備中の個数も含む。 */
  maxOwned: 3;
}
/** 所持上限1個のユニーク遺物。対応する守護者IDを入手元として保持する。 */
export interface RelicDefinition {
  id: RelicId;
  kind: 'relic';
  /** 装備1個による固定能力加算。未指定能力の加算は0。 */
  stats: Partial<Stats>;
  /** パーティ全体の最大所持数。装備中の個数も含む。 */
  maxOwned: 1;
  /** この遺物を初回報酬で付与する守護者ID。 */
  sourceEnemyId: EnemyId;
}
/** 初期装備と遺物を種類で判別する共通の装備定義。 */
export type EquipmentDefinition = StarterEquipmentDefinition | RelicDefinition;
/** 初回勝利時のポイント・装備・階層解放・クリア報酬候補。永続更新は保存層が行う。 */
export interface BattleReward {
  /** 初回勝利で各人の独立予算へ追加するポイント。 */
  skillPointsPerCharacter: number;
  equipment: { id: EquipmentId; quantity: number }[];
  /** 勝利後に解放する階層。追加解放なしならnull。 */
  unlockFloorId: FloorId | null;
  /** この勝利で最終クリアを確定するか。 */
  finalClear: boolean;
}
/** 固定行動列の1要素。使用スキルと公開する対象選択規則を持つ。 */
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
/** HP閾値で移る敵フェーズと、先頭から反復する行動列。 */
export interface EnemyPhase {
  id: string;
  /** このフェーズへ移る最大HP比の閾値（10000基準）。 */
  hpThreshold: BasisPoints;
  /** 先頭から実行し、末尾で先頭へ戻る固定行動列。 */
  actions: EnemyAction[];
}
/** 敵の能力・属性・妨害耐性・行動フェーズ・報酬をまとめる。 */
export interface EnemyDefinition {
  id: EnemyId;
  /** 状態補正前の敵基礎能力。最終能力の制限は戦闘計算側で適用する。 */
  stats: Stats;
  /** 開始・復帰時に満タンとなる敵の最大ゲージ。 */
  maxBreakGauge: number;
  /** 弱点属性。HPダメージは1.5倍、ゲージ削りは2倍。 */
  weakness: Element;
  /** HPダメージが0.5倍になる耐性属性。 */
  resistance: Element;
  /** HPダメージ・削り・付随効果が成立しない属性。省略時はなし。 */
  immuneElements?: Element[];
  /** ゲージ削りへの耐性率（10000基準）。 */
  breakResistance: BasisPoints;
  /** 後退TUへの耐性率（10000基準）。 */
  knockbackResistance: BasisPoints;
  /** 詠唱キャンセルを無効にするか。 */
  cancelImmune: boolean;
  /** 時間停止の付与を無効にするか。 */
  timeStopImmune: boolean;
  /** 初期フェーズと、HP閾値が降順の移行先一覧。 */
  phases: EnemyPhase[];
  reward: BattleReward;
}
/** 探索ノードの接続先と任意遭遇。現行の敵配置は0〜1体に限定する。 */
export interface FloorNode {
  id: NodeId;
  /** 同じ階層内の双方向の接続先ID。 */
  links: NodeId[];
  /** 現行の任意遭遇配置。敵なしまたは1体のみ。 */
  enemies: [] | [EnemyId];
}
/** 階層の入口と探索グラフ。表示文言はPresentationCatalogへ分離する。 */
export interface FloorDefinition {
  id: FloorId;
  /** ワープ・初期入場先の探索ノードID。 */
  entryNodeId: NodeId;
  nodes: FloorNode[];
}
/** 読み込み境界で検証するゲームのロジック用コンテンツ一式。テスト用の部分カタログも許可する。 */
export interface GameContent {
  characters: CharacterDefinition[];
  jobs: JobDefinition[];
  skills: SkillDefinition[];
  equipment: EquipmentDefinition[];
  /** 全遭遇で参照する敵定義の一覧。1戦闘への配置上限とは別。 */
  enemies: EnemyDefinition[];
  floors: FloorDefinition[];
}
/** 名前・説明・テーマ・ヒント・結末本文の表示専用データ。判定条件には使用しない。 */
export interface PresentationCatalog {
  entries: Record<string, { name: string; description: string }>;
  floors: Partial<
    Record<FloorId, { theme: string; entryText: string; hints: string[] }>
  >;
  ending: string[];
}
