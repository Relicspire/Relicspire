import { JOB_IDS, type GameContent } from './model';
export interface DataIssue {
  path: string;
  message: string;
}
type Check = (value: unknown, path: string, issues: DataIssue[]) => void;
const fail = (issues: DataIssue[], path: string, message: string) => {
  issues.push({ path, message });
};
const integer =
  (min = 0, max = Number.MAX_SAFE_INTEGER): Check =>
  (v, p, e) => {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max)
      fail(e, p, `Expected integer ${min}..${max}`);
  };
const choice =
  (...values: readonly unknown[]): Check =>
  (v, p, e) => {
    if (!values.includes(v)) fail(e, p, `Expected ${values.join(' | ')}`);
  };
const bool: Check = choice(true, false);
const id =
  (pattern: RegExp): Check =>
  (v, p, e) => {
    if (typeof v !== 'string' || !pattern.test(v)) fail(e, p, 'Invalid ID');
  };
const array =
  (item: Check, min = 0, max = Number.MAX_SAFE_INTEGER): Check =>
  (v, p, e) => {
    if (!Array.isArray(v)) return fail(e, p, 'Expected array');
    if (v.length < min || v.length > max)
      fail(e, p, `Expected ${min}..${max} items`);
    v.forEach((x, i) => item(x, `${p}[${i}]`, e));
  };
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
const floorPart = '(?:0[1-9]|10)';
const jobPart = `(?:${JOB_IDS.join('|')})`;
const enemyPart = `(?:boss-${floorPart}|guardian-${floorPart}-0[1-5])`;
const nodeSkillPart = `${jobPart}-[ab][123]`;
const skillPart = `(?:${nodeSkillPart}|${enemyPart}-s[123]|basic-attack|wait)`;
const match = (pattern: string) => id(new RegExp(`^${pattern}$`));
const floorId = match(`floor-${floorPart}`);
const enemyId = match(enemyPart);
const skillId = match(skillPart);
const skillNodeId = match(nodeSkillPart);
const cooldownId = match(`(?:${jobPart}-[ab]|${skillPart})`);
const equipmentId = match(
  `(?:starter-(?:sword|staff|armor|charm|boots|ring)|relic-${floorPart}-0[1-5])`,
);
const nodeId = match(
  `floor-${floorPart}-(?:entry|boss|hall-[123]|alcove-[1-5])`,
);
const element = choice('none', 'fire', 'ice', 'lightning', 'light', 'dark');
const statsFields = {
  maxHp: integer(1),
  atk: integer(),
  mag: integer(),
  def: integer(),
  mdef: integer(),
  spd: integer(1),
};
const statBonuses = object(
  Object.fromEntries(Object.keys(statsFields).map((k) => [k, integer()])),
  Object.keys(statsFields),
);
const power = union([
  integer(),
  object({
    kind: choice('low-hp'),
    normal: integer(),
    lowHp: integer(),
    snapshot: choice('before-activation'),
  }),
]);
const attackFields = {
  damageType: choice('physical', 'magic'),
  element: union([element, choice('chosen')]),
  power,
  breakDamage: integer(),
  hits: choice(1),
  actorReference: choice('before-activation'),
  targetReference: choice('before-effect'),
};
const attack = object(attackFields);
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
const hit = union(
  utilityFields.map((fields) =>
    object({ ...fields, target: choice('hit-recipient') }),
  ),
);
const target = choice('selected', 'all-allies', 'all-enemies', 'self');
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
const skillNode = object({
  id: skillNodeId,
  skillId: skillNodeId,
  cost: choice(1, 2, 3),
  prerequisites: array(skillNodeId),
  replacementGroup: cooldownId,
  rank: choice(1, 2, 3),
});
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
    object({
      id: enemyId,
      stats: object(statsFields),
      maxBreakGauge: integer(1),
      weakness: element,
      resistance: element,
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
    }),
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

/** Validate unknown JSON before exposing a typed catalog. Partial catalogs are allowed for fixtures/MVP. */
export function validateGameContent(input: unknown): DataIssue[] {
  const issues: DataIssue[] = [];
  schema(input, 'content', issues);
  if (issues.length) return issues;
  const data = input as GameContent;
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
export function parseGameContent(input: unknown): GameContent {
  const issues = validateGameContent(input);
  if (issues.length)
    throw new Error(issues.map((i) => `${i.path}: ${i.message}`).join('\n'));
  return structuredClone(input) as GameContent;
}
