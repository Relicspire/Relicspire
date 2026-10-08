import { describe, expect, it } from 'vitest';
import type { GameContent, SkillDefinition } from './model';
import { parseGameContent, validateGameContent } from './validation';
const attack = {
  kind: 'attack',
  target: 'selected',
  damageType: 'physical',
  element: 'none',
  power: 100,
  breakDamage: 5,
  hits: 1,
  actorReference: 'before-activation',
  targetReference: 'before-effect',
  attached: [],
} as const;
function fixture(): GameContent {
  const skills: SkillDefinition[] = ['knight-a1', 'knight-a2'].map((id) => ({
    id: id as SkillDefinition['id'],
    target: 'enemy-single',
    castTime: 0,
    delay: 100,
    cooldown: 100,
    cooldownId: 'knight-a',
    actorSnapshot: 'before-activation',
    targetSnapshot: 'before-activation',
    elementChoices: [],
    effects: [{ ...attack, attached: [] }],
  }));
  return {
    characters: [],
    jobs: [
      {
        id: 'knight',
        routes: {
          a: [
            {
              id: 'knight-a1',
              skillId: 'knight-a1',
              cost: 1,
              prerequisites: [],
              replacementGroup: 'knight-a',
              rank: 1,
            },
            {
              id: 'knight-a2',
              skillId: 'knight-a2',
              cost: 2,
              prerequisites: ['knight-a1'],
              replacementGroup: 'knight-a',
              rank: 2,
            },
          ],
          b: [],
        },
      },
    ],
    skills,
    equipment: [],
    enemies: [],
    floors: [],
  };
}
const messages = (data: unknown) =>
  validateGameContent(data)
    .map((i) => i.message)
    .join('\n');
describe('content boundary', () => {
  it('accepts and isolates a valid partial catalog', () => {
    const data = fixture();
    const parsed = parseGameContent(data);
    expect(validateGameContent(parsed)).toEqual([]);
    expect(parsed).toEqual(data);
    expect(parsed).not.toBe(data);
  });
  it('detects duplicate IDs and missing references', () => {
    const data = fixture();
    data.skills.push(data.skills[0]!);
    data.jobs[0]!.routes.a[0]!.prerequisites = ['wizard-a1'];
    expect(messages(data)).toContain('Duplicate ID');
    expect(messages(data)).toContain('Missing reference');
  });
  it('detects indirect and self prerequisite cycles', () => {
    const data = fixture();
    data.jobs[0]!.routes.a[0]!.prerequisites = ['knight-a2'];
    expect(messages(data)).toContain('Cyclic');
    data.jobs[0]!.routes.a[0]!.prerequisites = ['knight-a1'];
    expect(messages(data)).toContain('Cyclic');
  });
  it.each(['barrier', 'regeneration', 'self-damage', 'restore-gauge'])(
    'rejects unsupported %s JSON',
    (kind) => {
      const data = fixture();
      const raw = {
        ...data,
        skills: [{ ...data.skills[0], effects: [{ kind, target: 'self' }] }],
      };
      expect(validateGameContent(raw).length).toBeGreaterThan(0);
      expect(() => parseGameContent(raw)).toThrow();
    },
  );
  it('rejects multiple hits and multiple attack effects', () => {
    const data = fixture();
    data.skills[0]!.effects.push({ ...attack, attached: [] });
    expect(messages(data)).toContain('Multiple attack');
    expect(
      validateGameContent({
        ...fixture(),
        skills: [{ ...fixture().skills[0], effects: [{ ...attack, hits: 2 }] }],
      }).length,
    ).toBeGreaterThan(0);
  });
  it('rejects multiple enemies per encounter', () => {
    expect(
      messages({
        ...fixture(),
        floors: [
          {
            id: 'floor-01',
            entryNodeId: 'floor-01-entry',
            nodes: [
              {
                id: 'floor-01-entry',
                links: [],
                enemies: ['boss-01', 'guardian-01-01'],
              },
            ],
          },
        ],
      }),
    ).toContain('0..1 items');
  });
  it('validates hit-recipient binding and snapshot timing from unknown JSON', () => {
    const data = fixture();
    data.skills[0]!.effects = [
      {
        ...attack,
        attached: [{ kind: 'cancel-cast', target: 'hit-recipient' }],
      },
    ];
    expect(validateGameContent(data)).toEqual([]);
    expect(
      validateGameContent({
        ...data,
        skills: [
          {
            ...data.skills[0],
            effects: [
              {
                ...attack,
                attached: [{ kind: 'cancel-cast', target: 'selected' }],
              },
            ],
          },
        ],
      }).length,
    ).toBeGreaterThan(0);
    expect(
      validateGameContent({
        ...data,
        skills: [{ ...data.skills[0], actorSnapshot: 'command-confirmation' }],
      }).length,
    ).toBeGreaterThan(0);
  });
  it('rejects illegal targets, resurrection, and undefined element choices', () => {
    const data = fixture();
    data.skills[0]!.effects = [
      { kind: 'revive', target: 'selected', hpRatio: 5000 },
    ];
    expect(messages(data)).toContain('Only cleric');
    data.skills[0]!.effects = [
      { ...attack, target: 'all-allies', element: 'chosen', attached: [] },
    ];
    expect(messages(data)).toContain('not bound');
    expect(messages(data)).toContain('requires choices');
  });
  it.each([
    null,
    {},
    { ...fixture(), extra: true },
    { ...fixture(), skills: [{ ...fixture().skills[0], delay: -1 }] },
    { ...fixture(), skills: [{ ...fixture().skills[0], cooldown: 0.5 }] },
  ])('rejects malformed values', (input) => {
    expect(validateGameContent(input).length).toBeGreaterThan(0);
  });
});

describe('battle execution data contracts', () => {
  it('rejects attempts to redefine universal commands', () => {
    const data = fixture();
    data.skills.push({ ...data.skills[0]!, id: 'wait' });
    expect(messages(data)).toContain('fixed free command');
    data.skills[data.skills.length - 1] = {
      ...data.skills[0]!,
      id: 'basic-attack',
    };
    expect(messages(data)).toContain('fixed free command');
  });
});
