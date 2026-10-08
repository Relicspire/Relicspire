import { JOB_IDS, type GameContent } from './model';
/** 読み込み検証の問題箇所と理由。呼び出し元は複数の問題をまとめて表示できる。 */
export interface DataIssue {
  /** 不正データの箇所を示すパス。 */
  path: string;
  /** 検証に失敗した理由。 */
  message: string;
}
/** 未知の値・データパス・エラー蓄積先を受け取る検証関数。問題をissuesへ追加する。 */
type Check = (value: unknown, path: string, issues: DataIssue[]) => void;
/**
 * データパスと検証理由をエラー配列へ追加する。
 *
 * @param issues 検出した問題の蓄積先。
 * @param path 問題箇所を示すデータパス。
 * @param message 検証エラーの説明文。
 */
const fail = (issues: DataIssue[], path: string, message: string) => {
  issues.push({ path, message });
};
/**
 * 上下限を満たす安全な整数の検証関数を生成する。
 * 返す検証関数は値v・データパスp・エラー蓄積先eを受け取り、不正ならeへ問題を追加する。
 *
 * @param min 許可する下限（含む）。
 * @param max 許可する上限（含む）。
 */
const integer =
  (min = 0, max = Number.MAX_SAFE_INTEGER): Check =>
  (v, p, e) => {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max)
      fail(e, p, `Expected integer ${min}..${max}`);
  };
/**
 * 指定した値のいずれかに一致する検証関数を生成する。
 * 返す検証関数は値v・データパスp・エラー蓄積先eを受け取り、不正ならeへ問題を追加する。
 *
 * @param values 許可する値の一覧。
 */
const choice =
  (...values: readonly unknown[]): Check =>
  (v, p, e) => {
    if (!values.includes(v)) fail(e, p, `Expected ${values.join(' | ')}`);
  };
/** 真偽値だけを受け入れる検証関数。 */
const bool: Check = choice(true, false);
/**
 * 指定正規表現に一致する文字列IDの検証関数を生成する。
 * 返す検証関数は値v・データパスp・エラー蓄積先eを受け取り、不正ならeへ問題を追加する。
 *
 * @param pattern 文字列全体への一致に使う正規表現。
 */
const id =
  (pattern: RegExp): Check =>
  (v, p, e) => {
    if (typeof v !== 'string' || !pattern.test(v)) fail(e, p, 'Invalid ID');
  };
/**
 * 配列の長さと全要素を検証する関数を生成する。
 * 返す検証関数は値v・データパスp・エラー蓄積先eを受け取り、不正ならeへ問題を追加する。
 *
 * @param item 配列の各要素に適用する検証関数。
 * @param min 許可する配列長の下限。
 * @param max 許可する配列長の上限。
 */
const array =
  (item: Check, min = 0, max = Number.MAX_SAFE_INTEGER): Check =>
  (v, p, e) => {
    if (!Array.isArray(v)) return fail(e, p, 'Expected array');
    if (v.length < min || v.length > max)
      fail(e, p, `Expected ${min}..${max} items`);
    v.forEach((x, i) => item(x, `${p}[${i}]`, e));
  };
/**
 * 必須・任意項目を検証し、未知のキーを拒否するオブジェクト検証関数を生成する。
 * 返す検証関数は値v・データパスp・エラー蓄積先eを受け取り、不正ならeへ問題を追加する。
 *
 * @param fields 項目名と検証関数の対応表。
 * @param optional 省略を許可する項目名。
 */
const object =
  (fields: Record<string, Check>, optional: string[] = []): Check =>
  (v, p, e) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v))
      return fail(e, p, 'Expected object');
    const data = v as Record<string, unknown>;
    for (const key of Object.keys(data))
      if (!(key in fields)) fail(e, `${p}.${key}`, 'Unsupported field');
    for (const [key, check] of Object.entries(fields))
      if (key in data || !optional.includes(key))
        check(data[key], `${p}.${key}`, e);
  };
/**
 * 候補のいずれかに適合する値を検証する。全候補不適合なら問題数が最少の候補のエラーを返す。
 * 返す検証関数は値v・データパスp・エラー蓄積先eを受け取り、不正ならeへ問題を追加する。
 *
 * @param checks いずれか1つを満たせばよい検証関数の一覧。
 */
const union =
  (checks: Check[]): Check =>
  (v, p, e) => {
    const failures = checks.map((check) => {
      const errors: DataIssue[] = [];
      check(v, p, errors);
      return errors;
    });
    if (!failures.some((errors) => errors.length === 0))
      e.push(...failures.reduce((a, b) => (a.length <= b.length ? a : b)));
  };
/** 第1〜10階層の2桁番号に一致する正規表現部品。 */
const floorPart = '(?:0[1-9]|10)';
/** 許可されたジョブIDに一致する正規表現部品。 */
const jobPart = `(?:${JOB_IDS.join('|')})`;
/** ボス・守護者IDに一致する正規表現部品。 */
const enemyPart = `(?:boss-${floorPart}|guardian-${floorPart}-0[1-5])`;
/** ジョブのA/Bルート・ランク1〜3のノードIDに一致する正規表現部品。 */
const nodeSkillPart = `${jobPart}-[ab][123]`;
/** プレイヤー・敵スキルと基本コマンドIDの正規表現部品。 */
const skillPart = `(?:${nodeSkillPart}|${enemyPart}-s[123]|basic-attack|wait)`;
/**
 * ID書式の正規表現部品を文字列全体への一致条件にして検証関数を生成する。
 *
 * @param pattern 先頭・末尾指定を含まないID書式の正規表現文字列。
 */
const match = (pattern: string) => id(new RegExp(`^${pattern}$`));
/** 階層IDの書式を検証する。 */
const floorId = match(`floor-${floorPart}`);
/** 敵IDの書式を検証する。 */
const enemyId = match(enemyPart);
/** 使用可能なスキルID書式を検証する。 */
const skillId = match(skillPart);
/** 習得ノードIDの書式を検証する。 */
const skillNodeId = match(nodeSkillPart);
/** 共有スキル系統または独立スキルのCD IDを検証する。 */
const cooldownId = match(`(?:${jobPart}-[ab]|${skillPart})`);
/** 初期装備・遺物のID書式を検証する。 */
const equipmentId = match(
  `(?:starter-(?:sword|staff|armor|charm|boots|ring)|relic-${floorPart}-0[1-5])`,
);
/** 階層内の探索ノードID書式を検証する。 */
const nodeId = match(
  `floor-${floorPart}-(?:entry|boss|hall-[123]|alcove-[1-5])`,
);
/** 現行の無・火・氷・雷・光・闇属性を検証する。 */
const element = choice('none', 'fire', 'ice', 'lightning', 'light', 'dark');
/** 基礎能力値の必須項目と整数範囲を定義する。最終能力の上限は戦闘計算で適用する。 */
const statsFields = {
  maxHp: integer(1),
  atk: integer(),
  mag: integer(),
  def: integer(),
  mdef: integer(),
  spd: integer(1),
};
/** 装備の任意能力加算を検証する。未指定能力は加算0として扱う。 */
const statBonuses = object(
  Object.fromEntries(Object.keys(statsFields).map((k) => [k, integer()])),
  Object.keys(statsFields),
);
/** 固定威力または発動時の背水条件による威力選択を検証する。 */
const power = union([
  integer(),
  object({
    kind: choice('low-hp'),
    normal: integer(),
    lowHp: integer(),
    snapshot: choice('before-activation'),
  }),
]);
/** 1ヒット攻撃の性能と能力参照時点の検証項目。 */
const attackFields = {
  damageType: choice('physical', 'magic'),
  element: union([element, choice('chosen')]),
  power,
  breakDamage: integer(),
  hits: choice(1),
  actorReference: choice('before-activation'),
  targetReference: choice('before-effect'),
};
/** 攻撃性能だけを検証する。対象・付随効果はEffect側で扱う。 */
const attack = object(attackFields);
/** 現行の状態系統ごとに必要な性能項目を検証する。 */
const status = union([
  object({
    familyId: choice(
      'atk-up',
      'atk-down',
      'mag-up',
      'mag-down',
      'spd-up',
      'spd-down',
      'physical-guard',
      'magic-guard',
    ),
    magnitude: integer(0, 10000),
  }),
  object({ familyId: choice('taunt', 'cover', 'time-stop') }),
  object({
    familyId: choice('reflect'),
    ratio: choice(5000),
    charges: integer(1),
  }),
  object({ familyId: choice('counter', 'follow'), attack }),
  object({
    familyId: choice('poison'),
    damage: integer(),
    interval: choice(20),
  }),
  object({
    familyId: choice('self-revive'),
    hpRatio: integer(1, 10000),
    charges: choice(1),
  }),
]);
/** 時間操作・詠唱妨害・状態付与・解除の検証項目。 */
const utilityFields = [
  {
    kind: choice('shift'),
    direction: choice('advance', 'delay'),
    amount: integer(),
  },
  { kind: choice('cancel-cast') },
  {
    kind: choice('apply-status'),
    status,
    duration: integer(1),
    dispellable: bool,
  },
  {
    kind: choice('dispel'),
    polarity: choice('buff', 'debuff'),
    count: integer(1),
  },
];
/** 被弾者にだけ束縛できる攻撃付随効果を検証する。 */
const hit = union(
  utilityFields.map((fields) =>
    object({ ...fields, target: choice('hit-recipient') }),
  ),
);
/** 独立Effectで指定できる対象束縛を検証する。 */
const target = choice('selected', 'all-allies', 'all-enemies', 'self');
/** 現行Effectの構造を検証し、未対応の種類・余分な項目を拒否する。 */
const effect = union([
  ...utilityFields.map((fields) => object({ ...fields, target })),
  object({
    ...attackFields,
    kind: choice('attack'),
    target,
    attached: array(hit),
  }),
  object({
    kind: choice('heal'),
    target,
    power: integer(),
    actorReference: choice('before-activation'),
    targetReference: choice('before-effect'),
  }),
  object({
    kind: choice('revive'),
    target: choice('selected'),
    hpRatio: integer(1, 10000),
  }),
  object({
    kind: choice('trap'),
    target: choice('selected'),
    duration: integer(1),
    attack,
    attached: array(hit),
    snapshot: choice('on-trigger'),
  }),
]);
/** スキルの構造・時間・CD・対象規則・能力参照時点を検証する。 */
const skill = object({
  id: skillId,
  target: choice(
    'enemy-single',
    'enemy-all',
    'ally-single',
    'ally-other',
    'ally-all',
    'self',
    'dead-ally-other',
    'waiting-ally-other',
  ),
  castTime: integer(),
  delay: integer(1),
  cooldown: integer(),
  cooldownId,
  actorSnapshot: choice('before-activation'),
  targetSnapshot: choice('before-activation'),
  elementChoices: array(element),
  effects: array(effect),
});
/** 習得ノードの費用・前提・ランク・置換グループの構造を検証する。 */
const skillNode = object({
  id: skillNodeId,
  skillId: skillNodeId,
  cost: choice(1, 2, 3),
  prerequisites: array(skillNodeId),
  replacementGroup: cooldownId,
  rank: choice(1, 2, 3),
});
/** コンテンツ全体の構造検証。参照整合性と循環検出は構造確認後に行う。 */
const schema = object({
  characters: array(
    object({
      id: choice('party-1', 'party-2', 'party-3'),
      baseStats: object(statsFields),
      initialJob: choice(...JOB_IDS),
      initialSkills: array(skillNodeId),
      initialEquipment: array(union([equipmentId, choice(null)]), 6, 6),
    }),
  ),
  jobs: array(
    object({
      id: choice(...JOB_IDS),
      routes: object({ a: array(skillNode), b: array(skillNode) }),
    }),
  ),
  skills: array(skill),
  equipment: array(
    union([
      object({
        id: match('starter-(?:sword|staff|armor|charm|boots|ring)'),
        kind: choice('starter'),
        stats: statBonuses,
        maxOwned: choice(3),
      }),
      object({
        id: match(`relic-${floorPart}-0[1-5]`),
        kind: choice('relic'),
        stats: statBonuses,
        maxOwned: choice(1),
        sourceEnemyId: enemyId,
      }),
    ]),
  ),
  enemies: array(
    object(
      {
        id: enemyId,
        stats: object(statsFields),
        maxBreakGauge: integer(1),
        weakness: element,
        resistance: element,
        immuneElements: array(element),
        breakResistance: integer(0, 10000),
        knockbackResistance: integer(0, 10000),
        cancelImmune: bool,
        timeStopImmune: bool,
        phases: array(
          object({
            id: id(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
            hpThreshold: integer(0, 10000),
            actions: array(
              object({
                skillId,
                selection: choice(
                  'lowest-hp',
                  'highest-atk',
                  'highest-mag',
                  'highest-spd',
                  'all',
                  'self',
                ),
              }),
              1,
            ),
          }),
          1,
        ),
        reward: object({
          skillPointsPerCharacter: integer(),
          equipment: array(object({ id: equipmentId, quantity: integer(1) })),
          unlockFloorId: union([floorId, choice(null)]),
          finalClear: bool,
        }),
      },
      ['immuneElements'],
    ),
  ),
  floors: array(
    object({
      id: floorId,
      entryNodeId: nodeId,
      nodes: array(
        object({
          id: nodeId,
          links: array(nodeId),
          enemies: array(enemyId, 0, 1),
        }),
        1,
      ),
    }),
  ),
});

/**
 * 未知データの構造・値・ID・参照・前提循環・現行効果制約を検証する。部分カタログも許可する。
 *
 * @param input 型が未確認のコンテンツ。境界で構造と参照を検証する。
 * @returns 全検証問題の一覧。問題なしなら空配列。
 */
export function validateGameContent(input: unknown): DataIssue[] {
  const issues: DataIssue[] = [];
  schema(input, 'content', issues);
  if (issues.length) return issues;
  const data = input as GameContent;
  /**
   * 定義のIDを収集し、同じ一覧内の重複を検出する。
   *
   * @param items IDを収集する定義の配列。
   * @param path 問題箇所を示すデータパス。
   */
  const collect = (items: { id: string }[], path: string) => {
    const ids = new Set<string>();
    items.forEach((item, i) => {
      if (ids.has(item.id))
        fail(issues, `${path}[${i}].id`, `Duplicate ID: ${item.id}`);
      ids.add(item.id);
    });
    return ids;
  };
  collect(data.characters, 'characters');
  const jobs = collect(data.jobs, 'jobs');
  const skills = collect(data.skills, 'skills');
  const equipment = collect(data.equipment, 'equipment');
  const enemies = collect(data.enemies, 'enemies');
  const floors = collect(data.floors, 'floors');
  const nodes = data.jobs.flatMap((j) => [...j.routes.a, ...j.routes.b]);
  const nodeIds = collect(nodes, 'skillNodes');
  const mapNodes = collect(
    data.floors.flatMap((f) => f.nodes),
    'floorNodes',
  );
  /**
   * 参照IDが対応する定義集合に存在するかを検証する。
   *
   * @param ids 参照先として存在するIDの集合。
   * @param value 参照先として要求するID。
   * @param path 問題箇所を示すデータパス。
   */
  const ref = (ids: Set<string>, value: string, path: string) => {
    if (!ids.has(value)) fail(issues, path, `Missing reference: ${value}`);
  };
  data.characters.forEach((c) => {
    ref(jobs, c.initialJob, c.id);
    c.initialSkills.forEach((s) => {
      ref(nodeIds, s, c.id);
      if (!s.startsWith(`${c.initialJob}-`))
        fail(issues, c.id, 'Initial skill belongs to another job');
    });
    c.initialEquipment.forEach((e) => {
      if (e !== null) ref(equipment, e, c.id);
    });
  });
  data.jobs.forEach((j) => {
    for (const route of ['a', 'b'] as const)
      j.routes[route].forEach((n) => {
        if (!n.id.startsWith(`${j.id}-${route}`) || n.id !== n.skillId)
          fail(issues, n.id, 'Node ownership/skill ID mismatch');
        ref(skills, n.skillId, n.id);
        n.prerequisites.forEach((p) => {
          ref(nodeIds, p, n.id);
          if (!p.startsWith(`${j.id}-${route}`))
            fail(issues, n.id, 'Prerequisite belongs to another route');
        });
        const rank = Number(n.id.slice(-1));
        const group = rank === 3 ? n.id : `${j.id}-${route}`;
        if (n.rank !== rank || n.cost !== rank || n.replacementGroup !== group)
          fail(issues, n.id, 'Rank, cost or replacement group mismatch');
        const definition = data.skills.find((s) => s.id === n.skillId);
        if (definition && definition.cooldownId !== n.replacementGroup)
          fail(issues, n.id, 'Replacement and cooldown groups must match');
      });
  });
  const byId = new Map<string, (typeof nodes)[number]>(
    nodes.map((n) => [n.id, n]),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  /**
   * 前提ノードを深さ優先で探索し、探索中ノードへの再訪から循環を検出する。
   *
   * @param key 探索する習得ノードID。
   */
  const visit = (key: string) => {
    if (visiting.has(key)) {
      fail(issues, key, 'Cyclic skill prerequisites');
      return;
    }
    if (visited.has(key)) return;
    visiting.add(key);
    byId.get(key)?.prerequisites.forEach(visit);
    visiting.delete(key);
    visited.add(key);
  };
  nodes.forEach((n) => visit(n.id));
  data.skills.forEach((s) => {
    const path = s.id;
    if (
      s.id === 'wait' &&
      (s.target !== 'self' ||
        s.castTime !== 0 ||
        s.delay !== 20 ||
        s.cooldown !== 0 ||
        s.cooldownId !== 'wait' ||
        s.elementChoices.length !== 0 ||
        s.effects.length !== 0)
    )
      fail(issues, path, 'Wait must use the fixed free command definition');
    if (s.id === 'basic-attack') {
      const effect = s.effects[0];
      if (
        s.target !== 'enemy-single' ||
        s.castTime !== 0 ||
        s.delay !== 100 ||
        s.cooldown !== 0 ||
        s.cooldownId !== 'basic-attack' ||
        s.elementChoices.length !== 0 ||
        s.effects.length !== 1 ||
        effect?.kind !== 'attack' ||
        effect.target !== 'selected' ||
        effect.damageType !== 'physical' ||
        effect.element !== 'none' ||
        effect.power !== 100 ||
        effect.breakDamage !== 5 ||
        effect.attached.length !== 0
      )
        fail(
          issues,
          path,
          'Basic attack must use the fixed free command definition',
        );
    }

    if (
      s.effects.filter((e) => e.kind === 'attack' || e.kind === 'trap').length >
      1
    )
      fail(issues, path, 'Multiple attack effects/hits are unsupported');
    const allowedTargets = new Set<string>(['self']);
    if (s.target === 'ally-all') allowedTargets.add('all-allies');
    else if (s.target === 'enemy-all') allowedTargets.add('all-enemies');
    else if (s.target !== 'self') allowedTargets.add('selected');
    for (const e of s.effects) {
      if (!allowedTargets.has(e.target))
        fail(issues, path, 'Effect target is not bound by the skill target');
      if (
        e.kind === 'revive' &&
        (s.id !== 'cleric-a3' || s.target !== 'dead-ally-other')
      )
        fail(issues, path, 'Only cleric-a3 can revive another dead ally');
      if (s.target === 'dead-ally-other' && e.kind !== 'revive')
        fail(issues, path, 'Dead targets only support revival');
      if (e.kind === 'trap' && s.target !== 'enemy-single')
        fail(issues, path, 'Trap requires a selected enemy');
      const payload =
        e.kind === 'attack' ? e : e.kind === 'trap' ? e.attack : null;
      if (payload?.element === 'chosen' && s.elementChoices.length === 0)
        fail(issues, path, 'Chosen element requires choices');
      const utilities =
        e.kind === 'attack' || e.kind === 'trap' ? e.attached : [e];
      for (const u of utilities) {
        if (u.kind === 'apply-status') {
          if (
            u.status.familyId === 'self-revive' &&
            (s.id !== 'berserker-a3' || u.target !== 'self')
          )
            fail(issues, path, 'Only berserker-a3 supports self revival');
          if (
            (u.status.familyId === 'counter' ||
              u.status.familyId === 'follow') &&
            u.status.attack.element === 'chosen'
          )
            fail(issues, path, 'Reaction element must be fixed');
        }
        if (
          u.kind === 'shift' &&
          u.direction === 'advance' &&
          (u.target !== 'selected' || s.target !== 'waiting-ally-other')
        )
          fail(issues, path, 'Advance requires another waiting/casting ally');
      }
    }
  });
  data.enemies.forEach((e) => {
    const attributes = [e.weakness, e.resistance, ...(e.immuneElements ?? [])];
    if (
      attributes.includes('none') ||
      new Set(attributes).size !== attributes.length
    )
      fail(issues, e.id, 'Element categories must be distinct and non-neutral');
    collect(e.phases, `${e.id}.phases`);
    e.phases.forEach((p, i) => {
      if (
        (i === 0 && p.hpThreshold !== 10000) ||
        (i > 0 && p.hpThreshold >= e.phases[i - 1]!.hpThreshold)
      )
        fail(
          issues,
          e.id,
          'Phase thresholds must start at 10000 and strictly decrease',
        );
      p.actions.forEach((a) => {
        ref(skills, a.skillId, e.id);
        if (!a.skillId.startsWith(`${e.id}-s`))
          fail(issues, e.id, 'Enemy action belongs to another owner');
        const s = data.skills.find((s) => s.id === a.skillId);
        if (s && s.cooldown !== 0)
          fail(issues, e.id, 'Current enemy skills must have zero cooldown');
        if (s && s.elementChoices.length !== 0)
          fail(issues, e.id, 'Enemy skill elements must be fixed');
        if (
          s &&
          ((a.selection === 'self' && s.target !== 'self') ||
            (a.selection === 'all' && s.target !== 'enemy-all') ||
            (!['self', 'all'].includes(a.selection) &&
              s.target !== 'enemy-single'))
        )
          fail(issues, e.id, 'AI selection and skill target mismatch');
      });
    });
    if (e.reward.unlockFloorId !== null)
      ref(floors, e.reward.unlockFloorId, e.id);
    e.reward.equipment.forEach((r) => ref(equipment, r.id, e.id));
  });
  data.equipment.forEach((e) => {
    if (e.kind === 'relic') {
      ref(enemies, e.sourceEnemyId, e.id);
      if (e.sourceEnemyId !== e.id.replace('relic-', 'guardian-'))
        fail(issues, e.id, 'Relic guardian ID mismatch');
      const source = data.enemies.find((enemy) => enemy.id === e.sourceEnemyId);
      if (
        source &&
        (source.reward.equipment.length !== 1 ||
          source.reward.equipment[0]?.id !== e.id ||
          source.reward.equipment[0]?.quantity !== 1)
      )
        fail(issues, e.id, 'Guardian reward must contain its unique relic');
    }
  });
  data.floors.forEach((f) => {
    ref(mapNodes, f.entryNodeId, f.id);
    if (!f.nodes.some((n) => n.id === f.entryNodeId))
      fail(issues, f.id, 'Entry must belong to this floor');
    f.nodes.forEach((n) => {
      if (!n.id.startsWith(`${f.id}-`))
        fail(issues, n.id, 'Node belongs to another floor');
      n.links.forEach((link) => {
        ref(mapNodes, link, n.id);
        if (
          !f.nodes.some(
            (other) => other.id === link && other.links.includes(n.id),
          )
        )
          fail(issues, n.id, 'Links must be bidirectional within the floor');
      });
      n.enemies.forEach((enemy) => ref(enemies, enemy, n.id));
    });
  });
  return issues;
}
/**
 * 読み込み境界でコンテンツを検証し、成功時に外部変更から独立したコピーを返す。
 *
 * @param input 型が未確認のコンテンツ。境界で構造と参照を検証する。
 * @returns 検証済みコンテンツ。不正ならパス付きの例外を投げる。
 */
export function parseGameContent(input: unknown): GameContent {
  const issues = validateGameContent(input);
  if (issues.length)
    throw new Error(issues.map((i) => `${i.path}: ${i.message}`).join('\n'));
  return structuredClone(input) as GameContent;
}
